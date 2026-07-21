import { db } from "../db.js";

/**
 * Backfill de `CatracaAluno.wellhubId` via o relatório de check-ins de
 * agregadores da EVO (`GET /api/v1/management/aggregators/checkins/search`,
 * `Aggregators=1` = Wellhub/Gympass) — achado em 2026-07-21, bem melhor que
 * o backfill via `evo-clientes-sync.ts` (que precisa varrer os 22 mil
 * clientes inteiros pra achar os poucos com `gympassId`, ~85min por rodada).
 * Esse endpoint devolve idMember + tokenUsed (= gympassId) direto, filtrado
 * por período — poucas dezenas de linhas por dia, então dá pra rodar com
 * frequência alta sem custo.
 */
const DEFAULT_BASE_URL = "https://evo-integracao-api.w12app.com.br";
const CHECKINS_PATH = "/api/v1/management/aggregators/checkins/search";
const DEFAULT_TIMEOUT_MS = 15000;
const TAKE = 50;
const AGGREGATOR_WELLHUB = 1;

/** Janela de dias olhados a cada rodada — folga de sobra pra cobrir falha de
 * um ciclo sem perder ninguém (o endpoint é barato, poucos registros/dia). */
const DIAS_JANELA = 3;

interface CheckinAgregadorRaw {
  idMember: number;
  name?: string;
  checkinDate?: string;
  tokenUsed?: string;
  aggregator?: string;
}

function getAuthHeader(): string {
  const apiKey = process.env.EVO_INTEGRACAO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Configure EVO_INTEGRACAO_API_KEY no .env.");
  }
  return apiKey;
}

function formatarData(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function buscarPaginaCheckins(dtStart: string, dtEnd: string, skip: number): Promise<CheckinAgregadorRaw[]> {
  const search = new URLSearchParams({ DtStart: dtStart, DtEnd: dtEnd, Take: String(TAKE), Skip: String(skip) });
  search.append("Aggregators", String(AGGREGATOR_WELLHUB));

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${DEFAULT_BASE_URL}${CHECKINS_PATH}?${search}`, {
      method: "GET",
      headers: { accept: "application/json", authorization: getAuthHeader() },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`EVO respondeu ${response.status} em skip=${skip}`);
    }
    const json = (await response.json()) as { total?: number; list?: CheckinAgregadorRaw[] };
    return json.list ?? [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Backfilla `wellhubId` de quem já está cadastrado (`CatracaAluno`) a partir
 * dos check-ins Wellhub dos últimos `DIAS_JANELA` dias. Não cadastra ninguém
 * novo — só corrige o vínculo de quem já foi descoberto pelo device.
 */
export async function sincronizarWellhubIdsViaCheckins(): Promise<{ processados: number; atualizados: number }> {
  const hoje = new Date();
  const inicio = new Date(hoje.getTime() - DIAS_JANELA * 24 * 60 * 60 * 1000);
  const dtStart = formatarData(inicio);
  const dtEnd = formatarData(hoje);

  let processados = 0;
  let atualizados = 0;
  let skip = 0;

  for (;;) {
    const pagina = await buscarPaginaCheckins(dtStart, dtEnd, skip);
    if (pagina.length === 0) {
      break;
    }

    for (const item of pagina) {
      processados += 1;
      if (!item.tokenUsed || !item.idMember) {
        continue;
      }
      const aluno = await db.catracaAluno.findUnique({ where: { idMember: item.idMember }, select: { wellhubId: true } });
      if (aluno && aluno.wellhubId !== item.tokenUsed) {
        await db.catracaAluno.update({ where: { idMember: item.idMember }, data: { wellhubId: item.tokenUsed } });
        atualizados += 1;
      }
    }

    if (pagina.length < TAKE) {
      break;
    }
    skip += TAKE;
  }

  return { processados, atualizados };
}

const INTERVALO_MS = 30 * 60 * 1000;

/**
 * Roda sozinho a cada 30min — muito mais barato que o full-crawl de
 * `evo-clientes-sync.ts` (poucas chamadas em vez de ~444 páginas), então dá
 * pra manter `wellhubId` em dia com atraso de minutos em vez de até 1 dia.
 */
export function startWellhubIdsSyncJob(intervalMs = INTERVALO_MS): void {
  const rodar = () =>
    sincronizarWellhubIdsViaCheckins().catch((error) =>
      console.error("[catraca] erro no sync de wellhubId via check-ins:", error)
    );
  rodar();
  setInterval(rodar, intervalMs);
}
