import { db } from "../db.js";

export type ClassificacaoPlano = "livre" | "horaCerta" | "turma";

/**
 * Nomes de atividade que usam matrícula em turma com horário fixo
 * (`/api/v2/activities/enroll/member`) — confirmado com o dono da academia
 * em 2026-07-15, contra o catálogo real de 244 planos ativos. Qualquer
 * plano cujo nome contenha um desses termos é "turma".
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
 * Classifica os contratos ativos de um aluno a partir dos `idMembership`
 * deles (`CatracaAluno.idMembershipsAtivos`, sincronizado periodicamente)
 * contra o catálogo local (`EvoPlano`, também sincronizado). Devolve **todas**
 * as classificações distintas, não uma só: quem tem mais de um plano tem
 * direito à janela de horário de *cada* um deles (ex.: "HORA CERTA ANUAL" +
 * "JUDÔ 2X ANUAL" entra tanto na janela da Hora Certa quanto na aula de judô).
 * Reduzir isso a uma classificação única fazia o plano mais restritivo comer
 * o outro e barrava o aluno na aula — ver `checarHorario` em access-handler.ts.
 *
 * "livre" continua vencendo tudo na prática, mas quem aplica essa regra é
 * quem decide o acesso, não esta função.
 */
export async function classificarPlanosAtivos(idMembershipsAtivos: number[]): Promise<ClassificacaoPlano[]> {
  if (idMembershipsAtivos.length === 0) {
    return ["livre"]; // sem contrato ativo conhecido — não restringe por falta de dado (ver NOTES.md)
  }

  const planos = await db.evoPlano.findMany({
    where: { idMembership: { in: idMembershipsAtivos } },
    select: { nameMembership: true },
  });

  if (planos.length === 0) {
    return ["livre"]; // nenhum plano encontrado no catálogo local — não restringe por falta de dado
  }

  return [...new Set(planos.map((p) => classificarPlanoPorNome(p.nameMembership)))];
}
