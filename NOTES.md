# Notas do bring-up (contexto que não está no código)

Registro do que foi descoberto/decidido durante a integração inicial com a
catraca real, pra não se perder quando a conversa que gerou isso não estiver
mais disponível.

## Hardware

- Catraca **TopData Fit**, com dois módulos fisicamente separados, cada um
  com seu próprio IP/cabo de rede:
  - **Controlador da roleta** (o painel com teclado numérico 0-9/F/MENU/ESC/OK)
    — protocolo antigo "Inner Acesso", porta **3570**. É esse que fala com o
    PC que já roda o software de acesso da EVO (hoje em `192.168.1.12`) —
    sistema separado, funcionando, **não mexer nele** (a menos que decidam
    desativá-lo de vez no futuro, depois que este projeto estiver validado).
  - **Leitor facial** ("AiFace", firmware `AiF43V_v4.50`) — tela touch com
    câmera, menu próprio (toque na tela → ícone de engrenagem). É esse que
    fala com a gente, via WebSocket na porta **7792**.
- Menu do leitor facial: `MENU → REDE → SERVIDOR` tem os campos Domínio/IP/
  Porta/Heartbeat/**Servidor Valida**. **Servidor Valida: Sim** é o que faz o
  leitor esperar nossa resposta antes de liberar — enquanto estiver em "Não"
  (estado atual), ele decide sozinho e ignora nosso sistema por completo.
- Acesso ao menu master do painel do teclado (roleta) ficou bloqueado — senha
  alterada do padrão de fábrica, sem credencial disponível. Não foi
  necessário pra nada do que fizemos (o leitor facial tem menu próprio via
  touch), mas fica registrado caso precise mexer na roleta em si algum dia
  (aí só via instalador original ou suporte EVO/TecnoFit).

## Protocolo (WebSocket, JSON `cmd`/`ret`) — confirmado contra o device real

Documentação pública da TopData é incompleta/desatualizada; o que segue foi
confirmado observando tráfego real:

- `reg` (device → nós, ao conectar): traz `devinfo` com contadores
  (`usersize`, `useduser`, `usedface`, `usedlog`, etc.) e o relógio do
  próprio device. Respondemos `{"ret":"reg","result":true}`.
- `sendlog` (device → nós): vem em **lote** (`record[]`, com `count` e
  `logindex`), não um evento por mensagem. Precisa responder
  `{"ret":"sendlog","result":true,"count":N,"logindex":N}` ou o device fica
  reenviando o mesmo lote pra sempre (sem avançar).
  - **`access` na resposta do `sendlog` = decisão da roleta (CONFIRMADO
    contra o device real em 2026-07-16)**: com "Servidor Valida: Sim" no
    leitor, uma passagem real-time (lote de 1 record, não backlog) espera a
    nossa decisão de liberar/negar. É só **adicionar** um campo `access`
    booleano ao ack normal: `{"ret":"sendlog","result":true,"count":1,
    "logindex":0,"access":true|false}`. `access:false` **trava a roleta de
    verdade** — testado ao vivo (aluno inativo travou; aluno fora do horário
    Hora Certa travou; ativo liberou). Isso resolve o "modo real" que ficou
    pendente desde o começo do projeto. Ver `buildSendLogAck` (campo `access`
    opcional) + `decisaoDeAcessoParaDevice` em `ws-server.ts`.
  - **Fail-open pra enrollid desconhecido**: `nao_cadastrado` responde
    `access:true` (libera + loga) — quem está no leitor mas não no nosso
    banco é provavelmente membro legítimo ainda não importado. Só trava quem
    a gente CONHECE e negou (inativo, fora do horário). Backlog (`isHistorico`)
    e lotes com +1 record não recebem `access` (a passagem já aconteceu).
- `getuserinfo` (nós → device): pedimos por `enrollid`, ele responde
  `{"ret":"getuserinfo","enrollid":N,"name":"...","result":true}` (ou
  `result:false` com `"msg":"can not find the user"` se o enrollid não
  existe mais no device).
- `getuserlist`: **existe** (não dá erro), mas não conseguimos descobrir os
  parâmetros certos pra paginar — sempre voltou vazio (`count:0`). Não vale
  mais tempo tentando parâmetros às cegas; se precisar de novo, primeiro
  procurar doc oficial ou suporte.
- `getalluserinfo`: **não existe** nesse firmware (`"can not find this
  command"`).
- `cleanlog` (nós → device): **existe e funciona** — zera os contadores de
  log (`usedlog`, `usednewlog`, `usedrtlog` voltam a 0). Broadcast
  destrutivo do histórico de acessos do device (não do nosso
  `CatracaAcessoLog`, que é separado). Usamos isso de propósito pra não ter
  que drenar +2 anos de backlog manualmente.
  - **Efeito colateral descoberto por acaso**: depois do `cleanlog`, o
    device começou a empurrar sozinho, sem pedirmos, um `senduser` por
    usuário cadastrado — ver abaixo. Não confirmado se isso é garantido
    (pode ter sido coincidência de timing), mas foi reproduzido uma vez.
- `senduser` (device → nós, **não solicitado**): `{"cmd":"senduser",
  "enrollid":N,"name":"...","record":"<base64 JPEG puro, sem prefixo
  data:>"}`. Parece ser o device sincronizando a foto de cada usuário
  cadastrado, um de cada vez. Também precisa de ack
  (`{"ret":"senduser","result":true}`) ou ele reenvia o mesmo usuário pra
  sempre. Foi assim que conseguimos fotos reais de ~4378 alunos sem precisar
  recapturar nada manualmente.
- `setuserinfo` (nós → device, cadastro manual pela tela local `/`):
  **testado contra hardware real em 2026-07-14, três tentativas, nenhuma
  funcionou de verdade** — cadastro de um colaborador novo (enrollid 577):
  1. Envio direto do `record` (foto capturada por `canvas.toDataURL()`, já
     sem o prefixo `data:image/...;base64,` — bug real que existia e foi
     corrigido, ver `protocol.ts`/`paraBase64Puro`). Device respondeu
     `{"ret":"setuserinfo","result":true}`. Ele passou o rosto no leitor:
     **não reconheceu, sem reação nenhuma**.
  2. Reenvio adicionando `backupnum: 10` (convenção comum em devices
     ZKTeco/AiFace pra indicar "isso é um template de rosto", tentativa
     baseada em padrão de mercado, não documentação oficial da TopData).
     Device ecoou `backupnum:10` de volta em `result:true`. Testou nele:
     **de novo nada**.
  3. Foto nova, enquadramento mais afastado (menos "selfie de perto", mais
     parecido com a distância que a câmera do leitor captura de verdade).
     `result:true` de novo. **De novo nada.**
  - **Conclusão**: `result:true` parece só confirmar que o JSON foi aceito
    (enrollid/nome válidos), não que um template de rosto pesquisável foi
    de fato gerado a partir da foto enviada. Provavelmente esse comando (do
    jeito que estamos chamando) não é suficiente pra cadastro biométrico
    remoto nesse hardware — falta a especificação oficial da TopData pra
    saber se falta algum campo, ou se simplesmente não é suportado via API
    (só captura ao vivo pela própria câmera do leitor gera template válido).
  - **O que funciona, confirmado**: cadastro manual direto no painel touch
    do leitor (`MENU → engrenagem`) — resolveu o caso do Arthur na hora.
    **Usar esse caminho pra colaboradores/alunos novos até o `setuserinfo`
    ser resolvido** (ou até a TopData confirmar a spec exata).
  - Rota de diagnóstico `GET /catraca/debug/log` (par de `POST /catraca/
    debug/send`) foi criada pra esse bring-up — mostra as últimas 100
    mensagens WS trocadas com o device, em memória. Remover as duas depois
    que isso for resolvido de vez.

## Decisões de arquitetura

- **`enrollid` do device == `idMember` da EVO** — confirmado com dado real
  (enrollid 17841 = "marcio", conferido direto na EVO). Por isso dá pra
  reaproveitar todo o cadastro facial existente sem recapturar ninguém.
- **Corte de importação em 2025-01-01**: ao descobrir alunos via backlog de
  `sendlog`, só disparamos `getuserinfo` (import) pra quem tem registro de
  2025 em diante. Backlog mais antigo só é confirmado/avançado, não gera
  import — decisão do usuário pra não perder tempo com quem provavelmente já
  não frequenta mais.
- **Log de acesso "ao vivo" vs backlog**: `access-handler.ts` só grava em
  `CatracaAcessoLog` registros com menos de 10 min — mais antigo que isso é
  considerado backlog e só é usado pra decidir (não persistido), evitando
  inflar o histórico a cada reconexão.
- **`Servidor Valida: Sim` VALIDADO e funcionando (2026-07-16).** O modo real
  foi ligado e testado ao vivo: com o campo `access` na resposta do `sendlog`
  (ver seção Protocolo acima), a roleta trava de verdade quando negamos —
  confirmado com aluno inativo e aluno fora do horário Hora Certa, e liberando
  o ativo. A estratégia "desconhecido (`nao_cadastrado`) libera + loga pra
  revisão" **foi implementada** (fail-open pra enrollid que não conhecemos).
- **Sistema antigo da EVO (via `192.168.1.12`) ainda roda em paralelo** — o
  leitor facial já valida contra o nosso sistema, mas o sistema antigo segue
  ligado (não desativado). Próximo passo de longo prazo: desativar de vez
  depois de um período de "Servidor Valida: Sim" estável em produção.

## Personal trainers (coleção `Personal`, 2026-07-21)

- Personais passam no leitor com enrollid = a **"Carteirinha"** deles na EVO
  (campo `evoPersonalId` na coleção `Personal`) — um **quarto espaço de id**,
  que colide com member/employee de OUTRA pessoa. Ex.: enrollid 119 = personal
  ITALO, mas member 119 = Giovanna (inativa) e employee 119 = Maiara
  (bloqueada) — por isso a enriquecimento automática marcava 119 como "Maiara
  inativa" e o personal seria barrado.
- **Não tem endpoint de API** pra esse cadastro (procuramos). A solução: uma
  coleção `Personal` no Mongo compartilhado, **escrita por um processo externo**
  (sync da EVO fora deste projeto — o catraca-api só LÊ). Cada doc tem
  `evoPersonalId`, `nome` e `contratos[]` (`inicio`/`fim`).
- **Liberação por validade de contrato**: personal entra se tem algum contrato
  com `inicio <= agora` e `fim >= início de hoje` (pega renovação — checa todos
  os contratos, não só o último). `access-handler.decidirAcesso` checa a
  coleção `Personal` **ANTES** do `CatracaAluno` (a coleção é a fonte
  autoritativa; o `CatracaAluno` do enrollid pode estar com nome/status errado
  pela colisão). Decisão sempre local. Ver `personal.ts`.
- `personal-sync.ts` espelha `Personal` → `CatracaAluno` (nome certo, tipo
  "personal", ativo pela validade) só pra o NOME/status aparecerem certos nas
  telas — roda automático a cada ciclo (barato, leitura local, sem chamar EVO).
  `syncAtivos` **exclui** tipo "personal" (senão sincronizaria contra
  member/employee e daria status errado). `buscarNomeEStatusPorIdMember` checa
  `Personal` primeiro (senão a descoberta pelo device reverte pro nome errado).
- Motivo de negação: `personal_vencido`. personType 4 (EVO entryAuthorize).

## Colaboradores vs alunos (colisão de id)

- A catraca facial também é usada por **colaboradores** (professores,
  recepção etc.), não só alunos. O device não distingue — qualquer `enrollid`
  que aparece no `sendlog` é importado em `CatracaAluno` como se fosse aluno.
- **Descoberta importante**: as tabelas de `members` (`idMember`) e
  `employees` (`idEmployee`) na EVO numeram independentemente a partir de 1,
  então **enrollids baixos colidem com frequência** entre um aluno real e um
  colaborador real — os dois nomes podem ser genuínos, não dá pra usar
  "nome anonimizado" nem nenhuma heurística de API pra desambiguar sozinho.
  Exemplos confirmados: enrollid 54 = aluna inativa "Gabriella Queiroz Jara"
  **e** professor ativo "Pedro Vieira Sousa Neto"; enrollid 540 = contrato de
  aluno anonimizado (LGPD) **e** colaboradora ativa; enrollid 549 = perfil de
  membro antigo anonimizado **e** professor ativo.
- **Solução adotada**: campo `tipo` (`"aluno"` | `"colaborador"`) em
  `CatracaAluno`, e uma lista manual fornecida pelo dono da academia —
  `src/catraca/colaboradores-conhecidos.ts` — que tem **prioridade sobre
  qualquer detecção automática** (`buscarNomeEStatusPorIdMember` em
  `evo-aluno-busca.ts` checa essa lista primeiro, antes de contrato/perfil).
  Pra atualizar a lista: pedir um novo CSV de colaboradores (exportado da
  EVO) e regerar o arquivo.
- `evo-sync-job.ts` sincroniza `ativo` separadamente por `tipo`: alunos
  contra `/api/v1/members/active-members`, colaboradores contra
  `/api/v2/employees` (`fetchIdEmployeesAtivos` em `evo-active-members.ts`) —
  **isso é o comportamento certo mesmo se parecer "desfazer" a lista
  manual**: a lista manual só fixa a classificação (aluno x colaborador), o
  `ativo` continua acompanhando o status real e atual na EVO (confirmado:
  colaborador que o CSV dizia "Ativo" apareceu "Bloqueado" na consulta ao
  vivo dias depois — está correto barrar, não é bug).

## Wellhub/Gympass (check-in libera mesmo com "inativo" na EVO)

- Alunos que usam Wellhub/Gympass ficam **inativos** na EVO (sem contrato
  direto) mas devem ser liberados na catraca quando fazem check-in pelo app,
  só naquela janela de tempo — não dá pra cachear isso como o `ativo` normal
  (sincronizado a cada 10 min).
- **A EVO já integra Wellhub/Gympass e Totalpass por trás de um único
  endpoint**: `POST /api/v2/accessControl/entryAuthorize` (`id`, `personType`
  — 1 aluno/3 colaborador —, `device` — 3 é facial —, `idTurnstile`). Não
  precisamos falar com a API do Wellhub diretamente. O retorno já cobre os
  dois cenários (`blockedtype` tem códigos específicos pra Gympass 19-25 e
  Totalpass 30-35).
- Catraca já cadastrada na EVO pra isso: `idTurnstile: 8` ("Catraca Topdata
  Facial Browser - Quattor"), salvo em `EVO_ID_TURNSTILE_FACIAL` no `.env`.
- **Implementado** em `evo-access-control.ts` + `access-handler.ts`: quando
  o cache local diz "inativo", confirma com esse endpoint antes de negar de
  vez (falha (rede/permissão) → mantém a decisão local, nunca trava nem
  libera por engano).
- **Bloqueado por permissão da EVO**: testado contra os dois turnstiles
  cadastrados (2 e 8), os dois retornam **HTTP 500 vazio**. Suspeita: falta
  habilitar a permissão "Controle Acesso - Consulta" na chave de integração
  da EVO (ou os turnstiles não estão totalmente configurados do lado da EVO
  — os dois têm `serialNumber` vazio/nulo). Precisa verificar no painel
  admin da EVO ou com o suporte deles antes de conseguir validar de verdade.

## Wellhub direto (independente da EVO)

- **Decisão**: o dono da academia quer parar de depender da EVO no futuro, e
  o `entryAuthorize` dela (que embrulha Wellhub/Totalpass) segue bloqueado
  por permissão (ver seção acima). Solução: falar direto com a **Access
  Control API** da própria Wellhub, sem passar pela EVO.
- **Endpoint**: `POST https://api.partners.gympass.com/access/v1/validate`
  (sandbox: `https://apitesting.partners.gympass.com/access/v1`). Headers
  `Authorization: Bearer {token}` + `X-Gym-Id: {gymId}`, body
  `{"gympass_id": "..."}`. `200` vazio = check-in confirmado; erros
  conhecidos: "Check-In not found in database", "Check-In already
  validated", "Check-In expired". Check-in expira **30 min** depois de
  criado no app — precisa validar dentro dessa janela.
- **Modelo escolhido**: "Gate System Trigger" (chamamos `/validate` quando a
  própria facial já decidiu liberar fisicamente), não o "Automated Trigger"
  (ficar ouvindo o webhook de check-in da Wellhub) — schema mais simples e
  já bate com o fluxo existente (`decidirAcesso` em `access-handler.ts`).
- **Implementado** em `wellhub-access-control.ts` (`validarCheckInWellhub`,
  mesmo padrão defensivo do `evo-access-control.ts`: retorna `null` — não
  nega — se faltar credencial ou a chamada falhar) + campo `wellhubId` em
  `CatracaAluno` + rota `PATCH /catraca/alunos/:idMember/wellhub-id` pra
  cadastrar manualmente. `decidirAcesso` tenta Wellhub primeiro quando o
  aluno tem `wellhubId`, senão cai no fallback EVO de sempre.
- **PRODUÇÃO VALIDADA (2026-07-20)**: token de produção + `WELLHUB_GYM_ID=6249`
  (⚠️ **o Gym ID de produção é DIFERENTE do sandbox** — sandbox era 538;
  passamos ~1h achando que o token estava errado, dava `401 Unauthorized` no
  gateway istio-envoy mesmo sem X-Gym-Id, mas era o Gym ID de sandbox sendo
  usado contra o host de produção). Com o Gym ID certo, `/validate` autentica
  (404 "Check-In not found" pra id inexistente = auth OK). Confirmado ao vivo:
  aluna Wellhub que fez check-in passou com motivo `wellhub_ok` (validação
  real), enquanto antes de configurar as credenciais no PC da catraca as
  passagens vinham como `wellhub_provisorio` (fail-open). Host produção:
  `https://api.partners.gympass.com` (o `api.partners.wellhub.com` nem
  resolve). Credenciais ficam no `.env` do PC da catraca (gitignored, não vai
  no git — cada máquina tem o seu).
- ~~**Pendências antes de funcionar de verdade**~~ (resolvidas):
  1. ~~**Credenciais**~~ — recebidas e configuradas em produção (2026-07-20,
     ver acima). Token de produção veio do Tech Sales da Wellhub (Marco Ende)
     via onetimesecret.
  2. **Origem do `gympass_id` por aluno** — **resolvido, e melhor do que
     imaginávamos no começo**: achávamos que só dava pra descobrir via
     relatório de check-ins exportado manualmente do painel da EVO (é o que
     esse item dizia antes — desatualizado, `scripts/import-wellhub-csv.ts`
     ficou como peça morta). Na real: `GET /api/v2/members/{idMember}` (busca
     individual) não retorna `gympassId`, mas a **lista paginada** `GET
     /api/v2/members` retorna sim (ver `evo-clientes-sync.ts`). Ou seja, dá
     pra descobrir e manter atualizado só com a API, sem exportar nada na mão.
   - Primeira rodada em massa em 2026-07-09 (via `POST
     /catraca/sincronizar-clientes`, que sincroniza a coleção `EvoCliente`
     inteira e já backfilla `CatracaAluno.wellhubId` de quem tiver
     `gympassId`): ~1500 vínculos de uma vez.
   - **Descoberto em 2026-07-21**: essa sincronização só rodava manualmente,
     então quem vinculou o Wellhub depois de 09/07 ficava sem `wellhubId` até
     alguém rodar de novo na mão (caso real: Ianê de Andrade Azevedo, idMember
     23612, apareceu como "não cadastrado" na tela `/wellhub.html` porque
     nunca tinha sido resincronizada). **Agora roda sozinho 1x/dia**
     (`startEvoClientesSyncJob`, chamado no `index.ts`) — é uma varredura em
     lote (~444 páginas), bem mais barata que os syncs de horário
     (600-1500 chamadas cada, esses sim mantidos manuais, ver abaixo).

### Reentrada e validação automática (2026-07-21)

- **Reentrada dentro de 40min não revalida**: o check-in Wellhub é de uso
  único — depois do primeiro `/validate` bem-sucedido, uma segunda chamada
  falharia mesmo com a pessoa presente (ex.: foi no carro pegar algo e
  voltou). `decidirAcesso` agora checa `passagemWellhubRecente(enrollid)`
  (`wellhub-checkins.ts`) antes de chamar a Wellhub de novo — se teve uma
  passagem `wellhub_ok`/`wellhub_manual`/`wellhub_auto` nos últimos 40min,
  libera direto sem tentar validar.
- **Validação automática após 15min sem passar na catraca**: se o aluno fez
  check-in no app mas não passou fisicamente na catraca, o check-in ficava
  "em aberto" pro sempre do lado da Wellhub. A pedido do dono da academia
  (ciente do trade-off — reporta o check-in como usado sem confirmação
  física), `autoValidarCheckinsPendentes()` roda no job periódico
  (`evo-sync-job.ts`, ciclo de 10min → disparo real entre 15-25min) e chama
  `/validate` mesmo assim, registrando `wellhub_auto` no log. Continua
  tentando a cada ciclo até validar (custo baixo, poucos check-ins/dia — sem
  necessidade de guardar estado de tentativa).
  - `wellhub_auto` é **excluído** de `/catraca/acessos/ultimo` (rota do
    monitor ao vivo) — é uma confirmação tardia via job em background, não
    uma passagem física na hora; mostrar isso como "acesso ao vivo" enganaria
    quem está olhando a tela. Aparece normalmente no histórico
    (`/catraca/acessos`) e na tela `/wellhub.html` como validado.
  - Validação manual (`validarCheckinManual`, botão na tela `/wellhub.html`)
    continua existindo como fallback pra quando a auto falha (ex.: erro
    transitório na API da Wellhub).

## Migração do MongoDB: Atlas → EasyPanel (self-hosted)

- Em 2026-07-09 o banco saiu do Atlas (`cluster0.lg36a.mongodb.net`) pra um
  Mongo self-hosted no EasyPanel (`easypanel.quattoracademia.com:27017`,
  serviço `mongodb` dentro do projeto `n8n_quattor` — reaproveitando um Mongo
  que já existia lá pro n8n). Motivo: decisão do usuário, `recepcao` não usa
  os dados da catraca, então não tem problema de "banco compartilhado" que
  achávamos que existia antes (ver [[catraca-api-overview]] — checar se essa
  memória precisa de correção).
- **Pegadinha que quebrou tudo na primeira tentativa**: o Mongo do EasyPanel
  por padrão **não roda como replica set**, e o Prisma exige isso (usa
  transação por baixo até pra updates simples) — sem isso, `evo-sync-job.ts`
  (job periódico de `ativo`) falhava com `P2031`. Corrigido:
  1. No serviço Mongo do EasyPanel, campo "Comando" → `mongod --replSet rs0 --bind_ip_all`.
  2. Console do serviço → `mongo client` → `rs.initiate()`.
  3. **Outra pegadinha**: `rs.initiate()` sem argumento registra o member
     com o **hostname interno do container Docker** (tipo `4e02c958be28:27017`),
     não o domínio externo — isso quebra conexões de fora assim que o driver
     tenta redirecionar pro host "oficial" do replica set. Corrigir com:
     ```
     cfg = rs.conf()
     cfg.members[0].host = "easypanel.quattoracademia.com:27017"
     rs.reconfig(cfg, {force: true})
     ```
  4. String de conexão final precisa de `authSource=admin` (usuário foi
     criado no banco `admin`, não no `quattor`) e `replicaSet=rs0`:
     `mongodb://usuario:senha@easypanel.quattoracademia.com:27017/quattor?tls=false&authSource=admin&replicaSet=rs0`
- Antes de trocar o `.env` de vez, validado que a cópia de dados (feita pelo
  usuário, fora do nosso controle) bateu 100% com o Atlas: 4398 alunos, 1026
  ativos, 1570 com `wellhubId`, 69 logs, 22158 `EvoCliente` — todos iguais
  nos dois bancos antes da troca.

## Restrição de horário (Hora Certa / turma)

Implementado em 2026-07-15. Alguns planos só liberam entrada em janelas de
horário específicas — dois mecanismos diferentes na EVO:

- **"Hora Certa"** (qualquer plano com esse termo no nome): usa uma tabela
  fixa de "Horários de contrato" (configurada no painel admin da EVO, aba
  do plano) — **a API não expõe esse dado**, nem achamos outro endpoint que
  exponha (procuramos; só o motor interno `entryAuthorize`, bloqueado por
  permissão, parece ter acesso — ver seção Wellhub acima). A tabela foi
  passada manualmente pelo dono da academia e está hardcoded em
  `horario-restricao.ts` (`HORA_CERTA_JANELAS`). Tolerância: 15 min antes do
  início e 15 min depois do fim de cada janela. **Não cobre a linha
  "Feriado"** da tabela (sem calendário de feriados implementado — feriado
  hoje é tratado como dia normal da semana).
- **Turma marcada** (Ballet, Pilates, Judô, Natação, etc. — lista de termos
  em `evo-plano-classificacao.ts`, `TERMOS_TURMA`): usa a matrícula real do
  aluno (`GET /api/v1/activities/enrollment/member-enrollment`), com
  tolerância de -30/+20 min em volta do horário específico da turma dele.
  **Pegadinha confirmada**: os nomes de campo da resposta real vêm em
  camelCase (`weekDay`/`startTime`/`endTime`), mas a tabela da documentação
  da EVO mostra PascalCase (`WeekDay`/`StartTime`/`EndTime`) — usar o nome
  errado silenciosamente salva objeto vazio (sem erro, sem warning). Mesmo
  padrão de doc-vs-realidade divergente já visto em outros endpoints.
- **Prioridade**: se o aluno tem **qualquer** contrato ativo "livre" (nem
  Hora Certa, nem turma), libera sempre — mesmo tendo também um contrato
  restrito. Classificação por nome do plano contra o catálogo local
  (`EvoPlano`), confirmada com o dono da academia contra os 244 planos
  ativos reais.
- **Arquitetura**: a decisão em `access-handler.ts` continua 100% local
  (nunca chama a EVO na hora da passagem) — dois jobs sincronizam
  periodicamente (mas **não automaticamente ainda**, ver abaixo) os dados
  brutos pro Mongo: `evo-membership-sync.ts` (`idMembershipsAtivos` por
  aluno) e `evo-turma-sync.ts` (`turmaHorarios`, só de quem ficou
  classificado "turma"). A classificação em si (`evo-plano-classificacao.ts`)
  não é cacheada — é recalculada a cada passagem a partir do `EvoPlano` já
  sincronizado, pra não duplicar a lógica de classificação em dois lugares.
- **Custo de API real, medido em 2026-07-15**: `evo-membership-sync` fez
  ~662 chamadas (uma por aluno ativo — o endpoint em lote, sem filtro de
  `idMember`, traz dezenas de milhares de contratos históricos já vencidos
  que a EVO nunca marcou como cancelado, inviável de paginar tudo).
  `evo-turma-sync` fez outras ~637 chamadas e **bateu rate limit real (429)**
  seguido — resolvido com retry e backoff maior especificamente pra 429
  (`ESPERA_RATE_LIMIT_MS`). **Por isso os dois jobs não rodam sozinhos** —
  só via `POST /catraca/sincronizar-memberships` e `/catraca/
  sincronizar-turmas`, manual. Antes de automatizar, decidir uma cadência
  seguindo o limite real da chave (perguntar se a academia está no plano
  API Pro ou API Plus — grátis, 100 requisições/dia).

## Bloqueio por saldo devedor (2026-07-16)

- **Regra confirmada com o dono**: qualquer débito vencido em aberto trava o
  acesso, mesmo aluno ativo (sem carência de dias). Só pra `tipo: "aluno"`.
- **Fonte**: `GET /api/v1/receivables/debtors?debtStatus=1&memberStatus=1`
  (relatório de inadimplência). Endpoint em LOTE e barato (~2 páginas pra
  academia toda — eram 39 membros / 69 dívidas em 2026-07-16), então
  `evo-debito-sync.ts` **roda automático** junto do sync de `ativo`
  (evo-sync-job.ts, 10 min) — diferente dos syncs de horário que são
  caros/manuais.
- **Como funciona**: o sync marca `CatracaAluno.comDebito` (true pra quem tem
  dívida com `daysLate > 0`, false pro resto — quem paga é desbloqueado no
  próximo ciclo). `access-handler` lê o flag local e nega com motivo
  `saldo_devedor` (nunca chama a EVO na hora da passagem). Só zera os flags
  se a varredura terminou inteira (falha de rede não libera geral).
- Rota manual pra forçar: `POST /catraca/sincronizar-debitos`.

## Bugs/gotchas encontrados

- **A EVO troca a versão dos endpoints sem aviso** — descoberto em
  2026-07-15 fazendo `refresh_project_oas` (a doc em cache era de março).
  Pelo menos três endpoints que usamos mudaram de versão (formato de
  resposta igual, só a URL): `/api/v2/membership` → `/api/v3/membership`
  (`evo-planos-sync.ts`), `/api/v1/activities/enrollment/member-enrollment`
  → `/api/v2/activities/enroll/member` (`evo-turma-sync.ts`). Migrado nos
  dois depois de testar ao vivo. As versões antigas **ainda funcionavam**
  no momento da troca (não é urgente, mas pode parar de funcionar sem
  aviso). `/api/v1/members/active-members` também mudou (virou
  `/api/v2/members/active-members`, resposta agora com campos diferentes:
  `memberName`/`contractDescription`/etc.) — não usamos esse endpoint em
  lugar nenhum (`evo-active-members.ts` usa `/api/v2/members?status=1`,
  que não mudou), mas fica registrado caso alguém pense em usar. Vale
  rodar `refresh_project_oas` de vez em quando pra pegar mudanças assim
  antes que virem erro em produção.
- **Prisma + MongoDB**: campo `DateTime?` (ex.: `removidoEm`) que nunca foi
  setado fica **ausente** no documento, não `null`. Um filtro
  `{ removidoEm: null }` **não bate** com "ausente" — só com null explícito.
  Solução: `{ OR: [{ removidoEm: null }, { removidoEm: { isSet: false } }] }`
  (ver `src/catraca/filtros.ts`, constante `NAO_REMOVIDO`).
- **Credencial da EVO expira/rotaciona**: `EVO_INTEGRACAO_API_KEY` já ficou
  inativa uma vez no meio da sessão (token antigo). O valor correto sempre
  pode ser recalculado a partir de `EVO_USER`/`EVO_SECRET` (que a academia
  mantém atualizados): `Basic base64(EVO_USER:EVO_SECRET)`.
- **API da EVO tem rate limit agressivo** (poucas chamadas seguidas já dão
  erro) — o enriquecimento de nomes espaça as chamadas em ~400ms
  (`enriquecer-nomes-evo.ts`). Editar código enquanto uma rodada de
  enriquecimento está rodando **reinicia o `tsx watch` e mata a rodada no
  meio** (progresso não persiste, é só em memória) — evitar editar arquivos
  com uma rodada em andamento.
- **`/catraca/acessos` e `/catraca/acessos/ultimo` mostravam o nome errado**:
  usavam o nome cru vindo do próprio `sendlog` do device (`CatracaAcessoLog.
  nome`), que quase sempre vem vazio, em vez do nome já enriquecido em
  `CatracaAluno`. Corrigido pra preferir o nome enriquecido (`routes.ts`).
- **O mesmo gotcha de `isSet: false` acima também afetava o campo `nome`**
  (2026-07-10): os scripts de enriquecimento (`enriquecer-nomes-evo.ts`,
  `backfill-nomes-evo-cliente.ts`) filtravam só `{ nome: null }`/`""`, sem
  `isSet: false` — perdiam ~2800 `CatracaAluno` criados pelo `senduser` do
  device sem o campo `nome` gravado (não null, ausente mesmo). Corrigido nos
  dois scripts.
- **`prisma db push` nunca tinha sido rodado contra o Mongo do EasyPanel**
  (2026-07-10): nenhum índice do schema existia de fato no banco, nem os
  `@unique` (só o `_id_` padrão). Isso permitiu 3 documentos duplicados de
  `CatracaAluno` pro mesmo `idMember` (22343, reenvios repetidos de
  `senduser` em ~40s) — limpo manualmente, e `npx prisma db push` rodado pra
  aplicar os índices reais. Rodar `db push` de novo depois de qualquer
  mudança de schema em produção (não só `db:generate`, que só gera o client
  TS e não sincroniza índices/constraints com o banco).

## Operação no PC da catraca (Windows, serviço `CatracaApi` via NSSM)

Instalado em 2026-07-09 em `C:\catraca-api`, sem Docker, rodando como
serviço do Windows (NSSM) — sobe sozinho no boot e reinicia se cair. Ver
seção "Migração do MongoDB" e [[catraca-api-proximos-passos]] pro contexto:
esse é o mesmo PC (`192.168.1.12`) que já roda o sistema antigo da EVO
controlando a roleta, os dois convivem até o novo ser validado.

**Atualizar o app com uma versão nova do código** — usar o script
`deploy.ps1` (na raiz do repo), PowerShell como Administrador:
```powershell
powershell -ExecutionPolicy Bypass -File C:\catraca-api\deploy.ps1
```
Ele faz tudo (stop → git pull → npm install → prisma generate → db push →
build → start → health check) e, se algum passo falhar, **aborta sem subir
código quebrado** e religa a versão anterior. Da primeira vez, como o
próprio script vem via `git pull`, rodar o passo-a-passo manual uma vez pra
trazer o `deploy.ps1`, depois é só o comando acima.

Passo-a-passo manual (equivalente, caso precise):
```powershell
cd C:\catraca-api
nssm stop CatracaApi
git pull
npm install
npx prisma generate
npx prisma db push
npm run build
nssm start CatracaApi
nssm status CatracaApi
```
Sempre parar o serviço **antes** do `prisma generate`/`build` — o Windows
não deixa sobrescrever os arquivos do Prisma enquanto o processo do serviço
está com eles abertos (erro `EPERM ... rename query_engine-windows.dll`).

**Comandos do serviço:**
```powershell
nssm status CatracaApi     # ver se está rodando
nssm restart CatracaApi    # reiniciar sem trocar código
nssm stop CatracaApi
nssm start CatracaApi
```
Também dá pra ver/mexer em `services.msc`, procurando "CatracaApi".

**Ver logs** (setados em `AppStdout`/`AppStderr` na instalação):
```powershell
Get-Content C:\catraca-api\logs\out.log -Tail 50 -Wait
Get-Content C:\catraca-api\logs\err.log -Tail 50 -Wait
```
`-Wait` deixa acompanhando em tempo real (Ctrl+C pra sair).

**Checar se está de pé:**
```powershell
curl http://localhost:3001/health
```
Deve responder `{"status":"ok","alunos":N}`. Também dá pra abrir no
navegador: `http://localhost:3001/` (cadastro) e `http://localhost:3001/
monitor.html` (monitor ao vivo).

**Se mudar `schema.prisma`** (campo novo, índice novo): além do fluxo acima,
rodar `npx prisma db push` (com o serviço parado) pra sincronizar os
índices/constraints de verdade no Mongo — `db:generate`/`build` sozinhos
**não** fazem isso (ver "Bugs/gotchas encontrados" acima, causou duplicidade
de registro em 2026-07-10).

**Portas usadas** (já liberadas no Firewall do Windows): `3001` (HTTP,
cadastro/monitor) e `7792` (WS, leitor facial — `CATRACA_WS_PORT` no `.env`).

**Desinstalar o serviço** (só se for reinstalar do zero):
```powershell
nssm stop CatracaApi
nssm remove CatracaApi confirm
```

## Estado no fim desta sessão

- ~4400 alunos descobertos/importados, crescendo sozinho conforme o device
  manda `senduser`/backlog. Quase todos já com foto real (só ~1 sem, na
  última checagem).
- Enriquecimento de nome via EVO rodou várias rodadas (`POST /catraca/
  enriquecer-nomes`); ainda sobra bastante gente sem nome — rodar de novo
  periodicamente até estabilizar (ver `GET /catraca/enriquecer-nomes` pro
  progresso).
- 101 colaboradores conhecidos aplicados via `colaboradores-conhecidos.ts`
  (ver seção acima) — cobre os casos de colisão de id encontrados até agora,
  mas pode aparecer gente nova (avisar se algum colaborador aparecer com
  status/nome errado no monitor).
- Projeto extraído do monorepo `recepcao` pra cá (`catraca-api`), enxuto,
  sem as dependências do app web — pensado pra rodar num PC mais fraco sem
  Docker (ver README).

## Próximos passos

1. Terminar de importar/enriquecer o resto do cadastro.
2. Decidir e implementar o comportamento pra `enrollid` desconhecido antes
   de ligar validação real (negar vs. liberar-e-logar).
3. **Verificar com a EVO (painel admin ou suporte) a permissão "Controle
   Acesso - Consulta" na chave de integração** — `entryAuthorize` (Wellhub/
   Gympass, ver seção acima) está implementado mas retorna HTTP 500 vazio
   pros dois turnstiles cadastrados; sem isso, quem faz check-in Wellhub
   continua sendo negado quando ligarmos validação real. **Esse mesmo
   bloqueio também impede registrar presença/frequência na EVO** (testado em
   2026-07-10): existe `POST /api/v2/accessControl/insertManualLiberation`
   (funciona, cria o registro e devolve `idManualLiberation`), mas ele
   sozinho **não gera uma entrada de verdade** no relatório de frequência —
   o fluxo correto é passar esse `idManualLiberation` de volta pro
   `entryAuthorize` via `idManualEntry`, e é esse segundo passo que trava
   com o mesmo 500. Não implementar registro de presença antes desse
   bloqueio ser resolvido (deixaria só `insertManualLiberation` órfão
   rodando, poluindo o relatório de "liberações manuais" da EVO sem nunca
   virar uma entrada de verdade — decisão do usuário, ver conversa de
   2026-07-10).
4. ~~Ligar `Servidor Valida: Sim`~~ — **feito e validado em 2026-07-16** (ver
   "Decisões de arquitetura" e "Protocolo" acima). A roleta trava de verdade
   quando negamos. Falta só rodar um período estável em produção antes de
   pensar em desativar o sistema antigo.
5. ~~Validar `setuserinfo` contra o device real~~ — **validado em
   2026-07-14, não funciona** (ver seção "Protocolo" acima). Cadastro de
   rosto por enquanto só pelo painel touch do leitor. Se algum dia quiser
   retomar o cadastro remoto: precisa da spec oficial da TopData pro
   `setuserinfo`, não dá mais pra resolver só adivinhando campos.
6. Só depois de tudo validado e estável: conversar sobre desativar o
   sistema antigo da EVO em `192.168.1.12`.
7. **Restrição de horário (Hora Certa/turma)**: confirmar se a chave da EVO
   está no plano API Pro ou API Plus (100 req/dia) antes de automatizar
   `evo-membership-sync`/`evo-turma-sync` — hoje só rodam manual (ver seção
   acima). Também falta calendário de feriados (linha "Feriado" da tabela
   Hora Certa não é aplicada).
