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
  (`enriquecer-nomes-evo.ts`).

## Estado no fim desta sessão

- ~4000 alunos descobertos/importados (de ~4378 cadastrados no device),
  crescendo sozinho conforme o device manda `senduser`.
- Boa parte já com foto real (veio do device, sem precisar da recepção
  capturar nada).
- Enriquecimento de nome via EVO rodou uma primeira leva completa (962
  processados); os descobertos depois disso ainda precisam de uma nova
  rodada (`POST /catraca/enriquecer-nomes`).
- Projeto extraído do monorepo `recepcao` pra cá (`catraca-api`), enxuto,
  sem as dependências do app web — pensado pra rodar num PC mais fraco sem
  Docker (ver README).

## Próximos passos

1. Terminar de importar/enriquecer o resto do cadastro.
2. Decidir e implementar o comportamento pra `enrollid` desconhecido antes
   de ligar validação real (negar vs. liberar-e-logar).
3. Ligar `Servidor Valida: Sim` no menu do leitor facial.
4. Validar `setuserinfo` (cadastro manual) contra o device real de verdade.
5. Só depois de tudo validado e estável: conversar sobre desativar o
   sistema antigo da EVO em `192.168.1.12`.
