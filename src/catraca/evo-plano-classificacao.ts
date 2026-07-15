import { db } from "../db.js";

export type ClassificacaoPlano = "livre" | "horaCerta" | "turma";

/**
 * Nomes de atividade que usam matrícula em turma com horário fixo
 * (`/api/v1/activities/enrollment/member-enrollment`) — confirmado com o
 * dono da academia em 2026-07-15, contra o catálogo real de 244 planos
 * ativos. Qualquer plano cujo nome contenha um desses termos é "turma".
 */
const TERMOS_TURMA = [
  "ballet",
  "boxe",
  "dança contemporânea",
  "dança do ventre",
  "fit dance",
  "fitdance",
  "hidroginástica",
  "jiu-jitsu",
  "judô",
  "judo",
  "karate",
  "krav maga",
  "kung fu",
  "muay-thai",
  "muay thai",
  "natação",
  "pilates studio",
  "spinning",
  "yoga",
];

/**
 * Classifica um plano pelo nome — "horaCerta" (usa a tabela fixa de
 * horários, ver horario-restricao.ts), "turma" (usa a matrícula de turma do
 * aluno) ou "livre" (sem restrição de horário, padrão pra tudo que não bate
 * com os dois casos acima — musculação comum, personal, diária, etc.).
 */
export function classificarPlanoPorNome(nomePlano: string | null | undefined): ClassificacaoPlano {
  const nome = (nomePlano ?? "").toLowerCase();
  if (nome.includes("hora certa")) {
    return "horaCerta";
  }
  if (TERMOS_TURMA.some((termo) => nome.includes(termo))) {
    return "turma";
  }
  return "livre";
}

/**
 * Classifica um aluno a partir dos `idMembership` dos contratos ativos dele
 * (`CatracaAluno.idMembershipsAtivos`, sincronizado periodicamente) contra o
 * catálogo local (`EvoPlano`, também sincronizado). Prioridade: "livre"
 * vence qualquer outra coisa (aluno com plano livre + turma não é
 * restringido pela turma) — regra confirmada com o dono da academia.
 */
export async function classificarAlunoPorPlanosAtivos(idMembershipsAtivos: number[]): Promise<ClassificacaoPlano> {
  if (idMembershipsAtivos.length === 0) {
    return "livre"; // sem contrato ativo conhecido — não restringe por falta de dado (ver NOTES.md)
  }

  const planos = await db.evoPlano.findMany({
    where: { idMembership: { in: idMembershipsAtivos } },
    select: { nameMembership: true },
  });

  const classificacoes = planos.map((p) => classificarPlanoPorNome(p.nameMembership));
  if (classificacoes.includes("livre")) {
    return "livre";
  }
  if (classificacoes.includes("horaCerta")) {
    return "horaCerta";
  }
  if (classificacoes.includes("turma")) {
    return "turma";
  }
  return "livre"; // nenhum plano encontrado no catálogo local — não restringe por falta de dado
}
