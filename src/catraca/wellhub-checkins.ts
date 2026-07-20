import { db } from "../db.js";
import { validarCheckInWellhub } from "./wellhub-access-control.js";

/** Check-in é validável (dá pra confirmar) por 30 min depois de criado. */
const JANELA_VALIDACAO_MS = 30 * 60 * 1000;

/** Motivos de acesso que contam como "entrou pela Wellhub" (validado). */
const MOTIVOS_WELLHUB_VALIDADO = ["wellhub_ok", "wellhub_provisorio", "wellhub_manual"];

export interface CheckinListado {
  gympassId: string;
  recebidoEm: Date;
  idMember: number | null;
  nome: string | null;
  fotoBase64: string | null;
  validado: boolean;
  validavel: boolean; // ainda dentro da janela de 30 min e não validado
}

/**
 * Lista os check-ins Wellhub de um dia (default hoje) com o status: validado
 * (a pessoa passou na catraca / foi validado manualmente depois do check-in)
 * ou não. Casa tudo em memória — poucas dezenas de check-ins por dia.
 */
export async function listarCheckinsDoDia(dia?: string): Promise<CheckinListado[]> {
  const base = dia && /^\d{4}-\d{2}-\d{2}$/.test(dia) ? new Date(`${dia}T00:00:00`) : new Date();
  const inicio = new Date(base);
  inicio.setHours(0, 0, 0, 0);
  const fim = new Date(inicio);
  fim.setDate(fim.getDate() + 1);

  const checkins = await db.wellhubCheckin.findMany({
    where: { recebidoEm: { gte: inicio, lt: fim }, gympassId: { not: null } },
    orderBy: { recebidoEm: "desc" },
  });
  if (checkins.length === 0) {
    return [];
  }

  const gympassIds = [...new Set(checkins.map((c) => c.gympassId!).filter(Boolean))];
  const alunos = await db.catracaAluno.findMany({
    where: { wellhubId: { in: gympassIds } },
    select: { idMember: true, nome: true, fotoBase64: true, wellhubId: true },
  });
  const alunoPorGympassId = new Map(alunos.map((a) => [a.wellhubId!, a]));

  // idMembers que tiveram alguma passagem Wellhub no dia = validados. Casar
  // por "mesmo dia" (não por horário exato) evita fragilidade de fuso/ordem
  // dos eventos — check-in é diário e uma passagem Wellhub significa que a
  // pessoa entrou pela Wellhub naquele dia.
  const passagens = await db.catracaAcessoLog.findMany({
    where: { ocorridoEm: { gte: inicio, lt: fim }, permitido: true, motivo: { in: MOTIVOS_WELLHUB_VALIDADO } },
    select: { idMember: true },
  });
  const idMembersValidados = new Set(passagens.map((p) => p.idMember));

  const agora = Date.now();
  return checkins.map((c) => {
    const aluno = alunoPorGympassId.get(c.gympassId!);
    const idMember = aluno?.idMember ?? null;
    const validado = idMember !== null && idMembersValidados.has(idMember);
    const validavel = !validado && agora - c.recebidoEm.getTime() < JANELA_VALIDACAO_MS;
    return {
      gympassId: c.gympassId!,
      recebidoEm: c.recebidoEm,
      idMember,
      nome: aluno?.nome ?? null,
      fotoBase64: aluno?.fotoBase64 ?? null,
      validado,
      validavel,
    };
  });
}

export interface ResultadoValidacaoManual {
  ok: boolean;
  mensagem: string;
}

/**
 * Valida manualmente um check-in (recepção confirma que a pessoa está na
 * academia mas não passou na catraca). Chama o mesmo `/validate` da Wellhub;
 * se autorizar, registra uma passagem `wellhub_manual` no log (pra aparecer
 * como validado na lista e no histórico de acessos).
 */
export async function validarCheckinManual(gympassId: string): Promise<ResultadoValidacaoManual> {
  const resultado = await validarCheckInWellhub(gympassId);
  if (resultado === null) {
    return { ok: false, mensagem: "Wellhub não configurado ou indisponível." };
  }
  if (!resultado.autorizado) {
    return { ok: false, mensagem: resultado.mensagem ?? "Check-in não pôde ser validado." };
  }

  const aluno = await db.catracaAluno.findFirst({ where: { wellhubId: gympassId }, select: { idMember: true, nome: true } });
  await db.catracaAcessoLog.create({
    data: {
      idMember: aluno?.idMember ?? 0,
      nome: aluno?.nome ?? null,
      permitido: true,
      motivo: "wellhub_manual",
      personType: 1,
    },
  });

  return { ok: true, mensagem: "Check-in validado." };
}
