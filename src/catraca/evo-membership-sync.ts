import { db } from "../db.js";

/**
 * Sincroniza quais `idMembership` cada aluno tem ativos agora — usado pra
 * classificar restrição de horário (ver evo-plano-classificacao.ts).
 *
 * Descoberta em 2026-07-15: `GET /api/v3/membermembership?statusMemberMembership=1`
 * SEM idMember, pra pegar tudo em lote, traz dezenas de milhares de linhas —
 * inclui contrato antigo já vencido (ex.: "DIÁRIA EXPERIMENTAL" de anos
 * atrás) que a EVO nunca marcou como cancelado, só ficou com
 * `statusMemberMembership: 1` mesmo vencido. Inviável de paginar tudo a cada
 * rodada. Por isso aqui é **por aluno**, só pra quem já está `ativo: true`
 * no nosso banco (lista bem menor, ~1000-1500 no lugar de dezenas de
 * milhares), com filtro de `membershipEnd` pra ignorar contrato vencido.
 */
const DEFAULT_BASE_URL = "https://evo-integracao-api.w12app.com.br";
const MEMBERSHIP_PATH = "/api/v3/membermembership";
const DEFAULT_TIMEOUT_MS = 15000;
const INTERVALO_MS = 400;

interface Progresso {
  rodando: boolean;
  processados: number;
  total: number;
  erros: number;
}

const progresso: Progresso = { rodando: false, processados: 0, total: 0, erros: 0 };

export function getProgressoSincronizacaoMembership(): Progresso {
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

interface MemberMembershipRaw {
  idMembership: number;
  membershipEnd?: string | null;
}

/** `membershipEnd` no futuro (ou ausente = sem data de fim) conta como vigente hoje. */
function aindaVigente(membershipEnd: string | null | undefined): boolean {
  if (!membershipEnd) return true;
  const fim = new Date(membershipEnd);
  return Number.isNaN(fim.getTime()) || fim.getTime() >= Date.now();
}

async function buscarMembershipsAtivosDoAluno(idMember: number): Promise<number[]> {
  const search = new URLSearchParams({ idMember: String(idMember), statusMemberMembership: "1", take: "25", skip: "0" });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${DEFAULT_BASE_URL}${MEMBERSHIP_PATH}?${search}`, {
      method: "GET",
      headers: { accept: "application/json", authorization: getAuthHeader() },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`EVO respondeu ${response.status} pra idMember=${idMember}`);
    }
    const json = await response.json();
    const lista = Array.isArray(json) ? (json as MemberMembershipRaw[]) : [];
    return [...new Set(lista.filter((m) => aindaVigente(m.membershipEnd)).map((m) => m.idMembership))];
  } finally {
    clearTimeout(timeoutId);
  }
}

const MAX_TENTATIVAS = 3;

async function buscarComRetentativa(idMember: number): Promise<number[] | null> {
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      return await buscarMembershipsAtivosDoAluno(idMember);
    } catch (error) {
      console.error(`[catraca] erro ao buscar memberships de idMember=${idMember} (tentativa=${tentativa}):`, error);
      if (tentativa < MAX_TENTATIVAS) {
        await sleep(INTERVALO_MS * tentativa * 2);
      }
    }
  }
  return null;
}

/**
 * Só varre alunos `ativo: true` (tipo "aluno") — colaborador não tem
 * membership de cliente, e inativo não passa pela checagem de horário de
 * qualquer forma (já é negado antes, ver access-handler.ts).
 */
export async function sincronizarMembershipsEvo(): Promise<void> {
  if (progresso.rodando) {
    return;
  }
  progresso.rodando = true;
  progresso.processados = 0;
  progresso.erros = 0;

  try {
    const alunos = await db.catracaAluno.findMany({
      where: { tipo: "aluno", ativo: true },
      select: { idMember: true },
    });
    progresso.total = alunos.length;

    for (const aluno of alunos) {
      const idMemberships = await buscarComRetentativa(aluno.idMember);
      if (idMemberships === null) {
        progresso.erros += 1;
      } else {
        try {
          await db.catracaAluno.updateMany({
            where: { idMember: aluno.idMember },
            data: { idMembershipsAtivos: idMemberships },
          });
        } catch (error) {
          progresso.erros += 1;
          console.error(`[catraca] erro ao gravar idMembershipsAtivos de idMember=${aluno.idMember}:`, error);
        }
      }
      progresso.processados += 1;
      await sleep(INTERVALO_MS);
    }
  } finally {
    progresso.rodando = false;
  }
}
