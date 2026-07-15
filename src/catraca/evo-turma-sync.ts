import { db } from "../db.js";
import { classificarAlunoPorPlanosAtivos } from "./evo-plano-classificacao.js";
import type { TurmaHorario } from "./horario-restricao.js";

/**
 * Cacheia o horário de turma (`/api/v2/activities/enroll/member`) só de
 * quem foi classificado como "turma" (nenhum plano ativo livre nem Hora
 * Certa) — roda depois de `evo-membership-sync.ts`. Chamada por aluno (esse
 * endpoint exige `idMember`, não tem versão em lote), mas o volume é
 * pequeno: a maioria dos alunos não tem matrícula em turma (testado em
 * 2026-07-15: só 1 em 25 alunos ativos aleatórios tinha).
 *
 * Era `/api/v1/activities/enrollment/member-enrollment` até 2026-07-15 — a
 * EVO trocou pra v2 (mesmos campos que já usamos, só ganhou
 * `idConfigurationEnroll` a mais, que ignoramos). Migrado por segurança
 * depois de confirmar ao vivo (ver NOTES.md).
 */
const DEFAULT_BASE_URL = "https://evo-integracao-api.w12app.com.br";
const MEMBER_ENROLLMENT_PATH = "/api/v2/activities/enroll/member";
const DEFAULT_TIMEOUT_MS = 15000;
const INTERVALO_MS = 700;
const MAX_TENTATIVAS = 3;
const ESPERA_RATE_LIMIT_MS = 10000; // 429 precisa de uma pausa bem maior que erro de rede isolado

interface Progresso {
  rodando: boolean;
  processados: number;
  total: number;
  erros: number;
}

const progresso: Progresso = { rodando: false, processados: 0, total: 0, erros: 0 };

export function getProgressoSincronizacaoTurmas(): Progresso {
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

// Nomes de campo em minúsculo, confirmados contra resposta real da EVO — a
// tabela da documentação usa PascalCase (Status/StartTime/...), mas o JSON
// de verdade vem camelCase (mesma pegadinha de outros endpoints, ver NOTES.md).
interface MemberEnrollmentRaw {
  status: number;
  startTime: string;
  endTime: string;
  weekDay: number;
}

async function buscarMatriculaTurmaUmaVez(idMember: number): Promise<TurmaHorario[]> {
  const search = new URLSearchParams({ idMember: String(idMember), status: "1" });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${DEFAULT_BASE_URL}${MEMBER_ENROLLMENT_PATH}?${search}`, {
      method: "GET",
      headers: { accept: "application/json", authorization: getAuthHeader() },
      signal: controller.signal,
    });
    if (response.status === 429) {
      throw new RateLimitError(`EVO rate limit (429) pra idMember=${idMember}`);
    }
    if (!response.ok) {
      throw new Error(`EVO respondeu ${response.status} pra idMember=${idMember}`);
    }
    const json = await response.json();
    const lista = Array.isArray(json) ? (json as MemberEnrollmentRaw[]) : [];
    return lista.map((item) => ({ weekDay: item.weekDay, startTime: item.startTime, endTime: item.endTime }));
  } finally {
    clearTimeout(timeoutId);
  }
}

class RateLimitError extends Error {}

/** 429 precisa de uma pausa bem mais longa que um erro de rede isolado antes de tentar de novo. */
async function buscarMatriculaTurma(idMember: number): Promise<TurmaHorario[]> {
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    try {
      return await buscarMatriculaTurmaUmaVez(idMember);
    } catch (error) {
      const ultimaTentativa = tentativa === MAX_TENTATIVAS;
      if (ultimaTentativa) {
        throw error;
      }
      const espera = error instanceof RateLimitError ? ESPERA_RATE_LIMIT_MS * tentativa : INTERVALO_MS * tentativa * 2;
      console.error(`[catraca] erro ao buscar turma de idMember=${idMember} (tentativa=${tentativa}), esperando ${espera}ms:`, error);
      await sleep(espera);
    }
  }
  throw new Error("inalcançável");
}

export async function sincronizarTurmasEvo(): Promise<void> {
  if (progresso.rodando) {
    return;
  }
  progresso.rodando = true;
  progresso.processados = 0;
  progresso.total = 0;
  progresso.erros = 0;

  try {
    const candidatos = await db.catracaAluno.findMany({
      where: { tipo: "aluno", ativo: true, idMembershipsAtivos: { isEmpty: false } },
      select: { idMember: true, idMembershipsAtivos: true },
    });
    progresso.total = candidatos.length;

    for (const aluno of candidatos) {
      try {
        const classificacao = await classificarAlunoPorPlanosAtivos(aluno.idMembershipsAtivos);
        if (classificacao === "turma") {
          const turmas = await buscarMatriculaTurma(aluno.idMember);
          await db.catracaAluno.update({ where: { idMember: aluno.idMember }, data: { turmaHorarios: turmas as object } });
        } else {
          // não é mais "turma" (trocou de plano) — limpa cache velho, se tinha.
          await db.catracaAluno.update({ where: { idMember: aluno.idMember }, data: { turmaHorarios: null } });
        }
      } catch (error) {
        progresso.erros += 1;
        console.error(`[catraca] erro ao sincronizar turma de idMember=${aluno.idMember}:`, error);
      }
      progresso.processados += 1;
      await sleep(INTERVALO_MS);
    }
  } finally {
    progresso.rodando = false;
  }
}
