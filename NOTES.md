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
- `setuserinfo` (nós → device, cadastro manual): formato ainda **não
  confirmado** contra hardware real — só testado via cadastro manual pela
  tela local, sem verificação de que o device realmente aceitou/gravou o
  jeito que esperávamos. Validar no próximo cadastro real.

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
- **`Servidor Valida` continua "Não"** neste momento — modo de teste seguro,
  onde o device decide sozinho (como sempre fez) e só nos avisa em paralelo.
  **Ainda não ligamos o modo real.** Antes de ligar, considerar: o que fazer
  quando um `enrollid` desconhecido aparece (hoje = nega por padrão — risco
  de barrar aluno ativo que ainda não foi importado). Foi discutida a ideia
  de "desconhecido libera + loga pra revisão" como estratégia de transição,
  mas **não implementada ainda**.
- **Sistema antigo da EVO (via `192.168.1.12`) continua rodando em
  paralelo** e é o que hoje realmente controla a roleta. O objetivo de longo
  prazo do usuário é substituir esse sistema pelo daqui — mas isso só deve
  ser feito depois que "Servidor Valida: Sim" estiver validado e estável.

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
- **Pendências antes de funcionar de verdade**:
  1. **Credenciais** (`WELLHUB_ACCESS_TOKEN`, `WELLHUB_GYM_ID`) — ainda não
     solicitadas. Pedir ao Tech Sales da Wellhub
     (`integrations@gympass.com`) ou via Help Center ("solicitar token de
     integração da academia").
  2. **Origem do `gympass_id` por aluno** — **resolvido, dá pra fazer em
     lote**: a EVO tem um **relatório de check-ins Wellhub** exportável em
     CSV (colunas `ID` = idMember, `ID Agregador` = gympass_id, entre
     outras) — não achamos endpoint de API pra isso (`GET /api/v2/members/
     {idMember}` não retorna esse campo, testado contra idMember 18684),
     mas o relatório exportado manualmente do painel resolve. Processado em
     2026-07-09: 6089 linhas de check-in → 448 `idMember` únicos → 436
     batidos com alunos já cadastrados no `CatracaAluno` (12 não encontrados
     ainda, provavelmente não descobertos via `sendlog`). 2 conflitos (aluno
     com dois gympass_id diferentes ao longo do histórico — resolvido pelo
     mais frequente). Script reaproveitável em `scripts/import-wellhub-csv.ts`
     (`npx tsx scripts/import-wellhub-csv.ts /caminho/wellhub.csv`). Pra
     atualizar de novo no futuro: pedir novo export do mesmo relatório na
     EVO e rerodar.

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

## Bugs/gotchas encontrados

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

**Atualizar o app com uma versão nova do código** (PowerShell como
Administrador):
```powershell
cd C:\catraca-api
nssm stop CatracaApi
git pull
npm install
npx prisma generate
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
   continua sendo negado quando ligarmos validação real.
4. Ligar `Servidor Valida: Sim` no menu do leitor facial.
5. Validar `setuserinfo` (cadastro manual) contra o device real de verdade.
6. Só depois de tudo validado e estável: conversar sobre desativar o
   sistema antigo da EVO em `192.168.1.12`.
