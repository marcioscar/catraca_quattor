# catraca-api

Bridge entre a catraca facial TopData (leitor "AiFace") e a EVO — roda local
no PC dedicado à catraca, na mesma rede do leitor. Projeto separado do
`recepcao` (app principal, na VPS): os dois só compartilham o mesmo banco
MongoDB (coleções `CatracaAluno` e `CatracaAcessoLog`), sem chamada HTTP
entre os dois.

## Setup

```bash
npm install -g pnpm   # se ainda não tiver
pnpm install
cp .env.example .env  # preencher DATABASE_URL e EVO_INTEGRACAO_API_KEY
pnpm db:generate
pnpm dev              # http://localhost:3001
```

Telas locais: `/` (cadastro de aluno) e `/monitor.html` (monitor ao vivo,
foto + status a cada passagem).

## Rodando sem Docker (Windows, PC fraco)

```powershell
pnpm install
pnpm db:generate
pnpm build
pnpm start
```

Pra manter rodando sempre (reinicia sozinho, sobrevive a reboot), usar PM2
em vez de deixar um terminal aberto:

```powershell
npm install -g pm2 pm2-windows-startup
pm2 start dist/index.js --name catraca-api
pm2-startup install
pm2 save
```

## Configuração no menu físico do leitor facial

```
MENU → REDE → SERVIDOR
  Domínio: desligado (IP puro, mesma rede local)
  IP: <IP local deste PC>
  Porta: 7792
  Servidor Valida: SIM  ⚠️ crítico — em "Não" a catraca decide sozinha e
                         ignora o status de matrícula vindo da EVO.
```
