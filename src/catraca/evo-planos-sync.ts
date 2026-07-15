import { db } from "../db.js";

/**
 * Importa o catálogo de planos da EVO (`GET /api/v2/membership`, paginado)
 * pra uma coleção própria (`EvoPlano`) — pensando na migração futura pra
 * fora da EVO. Mesmo padrão de `evo-clientes-sync.ts` (paginação com
 * retentativa, rate limit espaçado — ver NOTES.md).
 */
const DEFAULT_BASE_URL = "https://evo-integracao-api.w12app.com.br";
const MEMBERSHIP_PATH = "/api/v2/membership";
const DEFAULT_TIMEOUT_MS = 15000;
const TAKE = 50; // máximo aceito pela EVO
const INTERVALO_MS = 400;

interface Progresso {
  rodando: boolean;
  processados: number;
  total: number;
  erros: number;
  ultimoSkip: number;
}

const progresso: Progresso = { rodando: false, processados: 0, total: 0, erros: 0, ultimoSkip: 0 };

export function getProgressoSincronizacaoPlanos(): Progresso {
  return { ...progresso };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAuthHeader(): string {
  const apiKey = process.env.EVO_INTEGRACAO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Configure EVO_INTEGRACAO_API_KEY no .env.");
  }
  return apiKey;
}

interface EvoMembershipRaw {
  idMembership: number;
  idBranch?: number | null;
  nameMembership?: string | null;
  membershipType?: string | null;
  durationType?: string | null;
  duration?: number | null;
  value?: number | null;
  description?: string | null;
  inactive?: boolean | null;
  displayName?: string | null;
  [key: string]: unknown;
}

function normalizeMembershipPayload(payload: unknown): EvoMembershipRaw[] {
  if (Array.isArray(payload)) {
    return payload as EvoMembershipRaw[];
  }
  if (payload && typeof payload === "object") {
    const list = (payload as { list?: unknown }).list;
    if (Array.isArray(list)) {
      return list as EvoMembershipRaw[];
    }
  }
  return [];
}

async function buscarPaginaPlanos(skip: number): Promise<EvoMembershipRaw[]> {
  const search = new URLSearchParams({ take: String(TAKE), skip: String(skip) });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${DEFAULT_BASE_URL}${MEMBERSHIP_PATH}?${search}`, {
      method: "GET",
      headers: { accept: "application/json", authorization: getAuthHeader() },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`EVO respondeu ${response.status} em skip=${skip}`);
    }
    return normalizeMembershipPayload(await response.json());
  } finally {
    clearTimeout(timeoutId);
  }
}

async function upsertPlano(raw: EvoMembershipRaw): Promise<void> {
  const data = {
    idBranch: raw.idBranch ?? null,
    nameMembership: raw.nameMembership ?? null,
    membershipType: raw.membershipType ?? null,
    durationType: raw.durationType ?? null,
    duration: raw.duration ?? null,
    value: raw.value ?? null,
    description: raw.description ?? null,
    inactive: raw.inactive ?? null,
    displayName: raw.displayName ?? null,
    raw: raw as object,
  };

  await db.evoPlano.upsert({
    where: { idMembership: raw.idMembership },
    create: { idMembership: raw.idMembership, ...data },
    update: data,
  });
}

const MAX_TENTATIVAS_POR_PAGINA = 3;
const MAX_FALHAS_CONSECUTIVAS = 5;

async function buscarPaginaComRetentativa(skip: number): Promise<EvoMembershipRaw[] | null> {
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_POR_PAGINA; tentativa++) {
    try {
      return await buscarPaginaPlanos(skip);
    } catch (error) {
      console.error(`[catraca] erro ao buscar página de planos (skip=${skip}, tentativa=${tentativa}):`, error);
      if (tentativa < MAX_TENTATIVAS_POR_PAGINA) {
        await sleep(INTERVALO_MS * tentativa * 2);
      }
    }
  }
  return null;
}

export async function sincronizarPlanosEvo(skipInicial = 0): Promise<void> {
  if (progresso.rodando) {
    return;
  }
  progresso.rodando = true;
  progresso.processados = 0;
  progresso.total = 0;
  progresso.erros = 0;

  try {
    let skip = skipInicial;
    let falhasConsecutivas = 0;
    for (;;) {
      progresso.ultimoSkip = skip;
      const pagina = await buscarPaginaComRetentativa(skip);
      if (pagina === null) {
        progresso.erros += 1;
        falhasConsecutivas += 1;
        if (falhasConsecutivas >= MAX_FALHAS_CONSECUTIVAS) {
          console.error(`[catraca] desistindo da sincronização de planos — ${MAX_FALHAS_CONSECUTIVAS} páginas seguidas falharam (parou em skip=${skip})`);
          break;
        }
        skip += TAKE;
        await sleep(INTERVALO_MS);
        continue;
      }
      falhasConsecutivas = 0;

      if (pagina.length === 0) {
        break;
      }
      progresso.total += pagina.length;

      for (const plano of pagina) {
        try {
          await upsertPlano(plano);
        } catch (error) {
          progresso.erros += 1;
          console.error(`[catraca] erro ao gravar plano idMembership=${plano.idMembership}:`, error);
        }
        progresso.processados += 1;
      }

      if (pagina.length < TAKE) {
        break;
      }
      skip += TAKE;
      await sleep(INTERVALO_MS);
    }
  } finally {
    progresso.rodando = false;
  }
}
