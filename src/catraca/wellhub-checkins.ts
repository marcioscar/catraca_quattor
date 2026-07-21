import { db } from "../db.js";
import { validarCheckInWellhub } from "./wellhub-access-control.js";

/** Check-in é validável (dá pra confirmar) por 30 min depois de criado. */
const JANELA_VALIDACAO_MS = 30 * 60 * 1000;

/**
 * Depois desse tempo sem passagem na catraca, valida automaticamente o
 * check-in mesmo assim (pra não ficar em aberto pro sempre do lado da
 * Wellhub — pedido do dono da academia). Roda no próprio job de 5min
 * (`startWellhubAutoValidacaoJob`, evo-sync-job.ts), então o disparo real
 * fica entre 15 e ~20min.
 */
const JANELA_AUTO_VALIDACAO_MS = 15 * 60 * 1000;

/**
 * Depois de uma passagem validada pela Wellhub, libera reentrada na catraca
 * por esse tempo sem tentar validar de novo — o check-in é de uso único, uma
 * segunda chamada a /validate falharia mesmo com a pessoa presente (ex.: foi
 * no vestiário e voltou). Ver `passagemWellhubRecente`.
 */
const JANELA_REENTRADA_MS = 40 * 60 * 1000;

/** Motivos de acesso que contam como "entrou pela Wellhub" (validado). */
const MOTIVOS_WELLHUB_VALIDADO = ["wellhub_ok", "wellhub_provisorio", "wellhub_manual", "wellhub_auto"];

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

/**
 * True se esse idMember teve uma passagem Wellhub validada nos últimos
 * `JANELA_REENTRADA_MS` — usado por `access-handler.ts` pra liberar
 * reentrada (ex.: foi no carro pegar algo e voltou) sem tentar validar o
 * check-in de novo, já que é de uso único e a segunda tentativa falharia.
 */
export async function passagemWellhubRecente(idMember: number): Promise<boolean> {
  const desde = new Date(Date.now() - JANELA_REENTRADA_MS);
  const passagem = await db.catracaAcessoLog.findFirst({
    where: { idMember, permitido: true, motivo: { in: MOTIVOS_WELLHUB_VALIDADO }, ocorridoEm: { gte: desde } },
    select: { id: true },
  });
  return passagem !== null;
}

/**
 * Valida automaticamente check-ins de hoje que passaram de
 * `JANELA_AUTO_VALIDACAO_MS` sem a pessoa ter passado na catraca — pra não
 * ficar em aberto pro sempre do lado da Wellhub (pedido explícito do dono da
 * academia, mesmo sabendo que isso reporta o check-in como usado sem
 * confirmação física). Continua tentando a cada ciclo do job enquanto não
 * validar (custo baixo, poucos check-ins/dia) — se um dia tiver volume alto,
 * vale guardar estado de "já tentei e falhou" pra não bater na API à toa.
 */
export async function autoValidarCheckinsPendentes(): Promise<void> {
  const pendentes = (await listarCheckinsDoDia()).filter(
    (c) => !c.validado && Date.now() - c.recebidoEm.getTime() >= JANELA_AUTO_VALIDACAO_MS
  );

  for (const checkin of pendentes) {
    const resultado = await validarCheckInWellhub(checkin.gympassId);
    if (!resultado?.autorizado) {
      continue;
    }
    await db.catracaAcessoLog.create({
      data: {
        idMember: checkin.idMember ?? 0,
        nome: checkin.nome,
        permitido: true,
        motivo: "wellhub_auto",
        personType: 1,
      },
    });
  }
}
