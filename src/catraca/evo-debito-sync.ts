import { db } from "../db.js";

/**
 * Marca `CatracaAluno.comDebito` de quem tem dívida vencida em aberto na EVO
 * (`GET /api/v1/receivables/debtors?debtStatus=1`) — usado pra bloquear
 * acesso mesmo de aluno ativo (regra: qualquer atraso trava, confirmado com
 * o dono da academia em 2026-07-16). Endpoint em LOTE e barato (~2 páginas
 * pra academia toda), então roda automático junto do sync de `ativo`
 * (evo-sync-job.ts), diferente do sync de horário que é caro/manual.
 *
 * Decisão sempre local: o access-handler lê o flag `comDebito`, nunca chama
 * a EVO na hora da passagem.
 */
const DEFAULT_BASE_URL = "https://evo-integracao-api.w12app.com.br";
const DEBTORS_PATH = "/api/v1/receivables/debtors";
const DEFAULT_TIMEOUT_MS = 20000;
const TAKE = 50; // máximo aceito pelo endpoint
const MAX_PAGES = 40; // trava de segurança (2000 dívidas) — hoje são ~69
const INTERVALO_MS = 400;

interface DebtorRaw {
  memberId?: number | null;
  daysLate?: number | null;
  dueDate?: string | null;
}

function getAuthHeader(): string {
  const apiKey = process.env.EVO_INTEGRACAO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Configure EVO_INTEGRACAO_API_KEY no .env.");
  }
  return apiKey;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buscarPaginaDevedores(skip: number): Promise<DebtorRaw[]> {
  const search = new URLSearchParams({ debtStatus: "1", memberStatus: "1", take: String(TAKE), skip: String(skip) });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${DEFAULT_BASE_URL}${DEBTORS_PATH}?${search}`, {
      method: "GET",
      headers: { accept: "application/json", authorization: getAuthHeader() },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`EVO respondeu ${response.status} em skip=${skip}`);
    }
    const json = await response.json();
    return Array.isArray(json?.results) ? (json.results as DebtorRaw[]) : [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Varre todas as dívidas abertas e atualiza `comDebito` no banco: `true` pra
 * quem tem dívida com `dueDate` já passado, `false` pra todo o resto (assim
 * quem pagou é desbloqueado no próximo ciclo). Retorna quantos alunos ficaram
 * com débito. Se a varredura falhar no meio, NÃO zera ninguém (evita liberar
 * geral por uma falha de rede) — só aplica se conseguiu a lista completa.
 *
 * NÃO usa `daysLate` pra decidir vencido: descoberto em 2026-07-27 (caso
 * real: Roni Salomé da Rosa da Cunha, idMember 11224) que `daysLate` é
 * calculado a partir do `originalDueDate`, e não é recalculado quando a EVO
 * reagenda a cobrança (tentativas automáticas de cartão) — um débito pode
 * mostrar "vencido há 1270 dias" com `dueDate` reagendado pra hoje ou até pro
 * futuro. Medido nesse dia: 32 de 50 devedores (64%) eram falso-positivo por
 * esse motivo. Critério certo: `dueDate` já é de um dia ANTERIOR a hoje
 * (comparação por dia calendário, não por timestamp exato — "vence hoje" não
 * é vencido ainda, mesmo com horário específico tipo 09:05 já passado).
 * Bate com o painel da EVO, que já mostrava "Acesso liberado" pro Roni.
 */
export async function sincronizarDebitosEvo(): Promise<number> {
  const idsComDebito = new Set<number>();
  // Compara por DIA calendário, não por timestamp exato: "vence hoje" (ex.
  // dueDate 27/07 09:05) não é vencido ainda, mesmo se já passou desse
  // horário — só vence a partir de amanhã. Bate com o painel da EVO.
  const inicioHoje = new Date();
  inicioHoje.setHours(0, 0, 0, 0);

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const lote = await buscarPaginaDevedores(page * TAKE);
    for (const d of lote) {
      const vencimento = d.dueDate ? new Date(d.dueDate).getTime() : null;
      if (typeof d.memberId === "number" && vencimento !== null && vencimento < inicioHoje.getTime()) {
        idsComDebito.add(d.memberId);
      }
    }
    if (lote.length < TAKE) {
      break;
    }
    await sleep(INTERVALO_MS);
  }

  // Só chega aqui se a varredura terminou sem lançar erro (lista completa).
  await db.catracaAluno.updateMany({ where: { comDebito: true }, data: { comDebito: false } });
  if (idsComDebito.size > 0) {
    await db.catracaAluno.updateMany({
      where: { idMember: { in: [...idsComDebito] } },
      data: { comDebito: true },
    });
  }

  return idsComDebito.size;
}
