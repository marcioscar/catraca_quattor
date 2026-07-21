import path from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { db } from "./db.js";
import { catracaRoutes } from "./catraca/routes.js";
import { startCatracaWsServer } from "./catraca/ws-server.js";
import { startEvoSyncJob, startWellhubAutoValidacaoJob } from "./catraca/evo-sync-job.js";
import { startEvoClientesSyncJob } from "./catraca/evo-clientes-sync.js";
import { startWellhubIdsSyncJob } from "./catraca/wellhub-ids-sync.js";
import { carregarCacheInicial } from "./catraca/known-aluno-cache.js";

// Sync de restrição de horário (Hora Certa/turma) NÃO inicia automaticamente
// ainda — faz ~1000-1500 chamadas à EVO por rodada (uma por aluno ativo),
// caro demais pra automatizar sem antes confirmar o limite diário da chave
// de integração (ver NOTES.md, "API Plus" free tier = só 100/dia). Disparar
// manualmente por enquanto: POST /catraca/sincronizar-memberships.

const app = Fastify({ logger: true });

app.get("/health", async () => {
  const count = await db.catracaAluno.count();
  return { status: "ok", alunos: count };
});

app.register(catracaRoutes);

// Telas locais (cadastro + monitor), servidas no mesmo processo — rodam no
// PC dedicado à catraca, acessadas via navegador em http://localhost:3001.
app.register(fastifyStatic, {
  root: path.join(import.meta.dirname, "../public"),
});

// 7792 é a porta padrão do leitor facial TopData (MENU > REDE > SERVIDOR > Porta).
const CATRACA_WS_PORT = Number(process.env.CATRACA_WS_PORT) || 7792;
const EVO_SYNC_INTERVAL_MS = Number(process.env.EVO_SYNC_INTERVAL_MS) || undefined;

const start = async () => {
  try {
    await app.listen({ port: 3001, host: "0.0.0.0" });
    await carregarCacheInicial();
    startCatracaWsServer(CATRACA_WS_PORT);
    startEvoSyncJob(EVO_SYNC_INTERVAL_MS);
    startWellhubAutoValidacaoJob();
    // wellhub-ids-sync (30min, barato) só enxerga check-ins que passaram
    // pelo sistema da própria EVO — quem valida direto com a Wellhub (nosso
    // caminho mais comum, ver wellhub-access-control.ts) fica invisível pra
    // esse relatório (confirmado em 2026-07-21: gympassId certo no perfil,
    // mas ausente no relatório de check-ins). Por isso continua sendo só um
    // complemento rápido — o full-crawl diário (evo-clientes-sync.ts) segue
    // sendo a única fonte completa e continua na cadência original.
    startWellhubIdsSyncJob();
    startEvoClientesSyncJob();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
