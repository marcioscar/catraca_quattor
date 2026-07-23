import { db } from "../db.js";
import { autorizarEntradaEvo, PERSON_TYPE_CLIENTE, PERSON_TYPE_COLABORADOR } from "./evo-access-control.js";
import { validarCheckInWellhub, wellhubConfigurado } from "./wellhub-access-control.js";
import { passagemWellhubRecente } from "./wellhub-checkins.js";
import { classificarAlunoPorPlanosAtivos } from "./evo-plano-classificacao.js";
import { dentroDoHorarioHoraCerta, dentroDoHorarioTurma, type TurmaHorario } from "./horario-restricao.js";
import { getPersonalPorEnrollid, PERSON_TYPE_PERSONAL } from "./personal.js";
import type { SendLogMessage, SendLogRecord } from "./protocol.js";

export interface AccessDecision {
  enrollid: number;
  access: boolean;
  motivo:
    | "ok"
    | "plano_inativo"
    | "nao_cadastrado"
    | "wellhub_provisorio"
    | "wellhub_ok"
    | "fora_do_horario"
    | "saldo_devedor"
    | "personal_vencido"
    | "turma_sem_matricula"
    | "wellhub_sem_checkin";
  /** Só presente quando access=true — gravado no log pra sincronizar com a EVO depois (ver NOTES.md). */
  personType?: number;
}

type ResultadoHorario = "liberado" | "fora_do_horario" | "turma_sem_matricula";

/**
 * Checa restrição de horário (Hora Certa / turma) — só pra "aluno", nunca
 * pra colaborador. Sempre local (classificação via `EvoPlano` já
 * sincronizado + cálculo de data), nunca chama a EVO nesse caminho. Ver
 * horario-restricao.ts e evo-plano-classificacao.ts.
 *
 * Classificado "turma" mas SEM nenhuma matrícula de turma sincronizada
 * (`turmaHorarios` vazio) é um caso à parte: não é "fora do horário", é
 * ausência de cadastro na EVO (aluno tem o plano mas ninguém marcou o
 * horário de aula dele) — decisão do dono da academia (2026-07-21): libera
 * em vez de travar por um problema de cadastro que não é culpa do aluno.
 */
async function checarHorario(aluno: { idMembershipsAtivos: number[]; turmaHorarios: unknown }): Promise<ResultadoHorario> {
  const classificacao = await classificarAlunoPorPlanosAtivos(aluno.idMembershipsAtivos);
  if (classificacao === "livre") {
    return "liberado";
  }
  if (classificacao === "horaCerta") {
    return dentroDoHorarioHoraCerta(new Date()) ? "liberado" : "fora_do_horario";
  }
  const turmas = Array.isArray(aluno.turmaHorarios) ? (aluno.turmaHorarios as TurmaHorario[]) : [];
  if (turmas.length === 0) {
    return "turma_sem_matricula";
  }
  return dentroDoHorarioTurma(new Date(), turmas) ? "liberado" : "fora_do_horario";
}

/** Registros mais antigos que isso são backlog acumulado (reader ficou
 * offline), não uma passagem em tempo real — não gravamos no log de acessos
 * pra não inflar o histórico com dados antigos a cada reconexão. */
const HISTORICO_LIMITE_MS = 10 * 60 * 1000;

export function isHistorico(record: SendLogRecord): boolean {
  if (!record.time) {
    return false;
  }
  const registradoEm = new Date(record.time.replace(" ", "T")).getTime();
  return Number.isFinite(registradoEm) && Date.now() - registradoEm > HISTORICO_LIMITE_MS;
}

/**
 * Decide liberar/negar com base só no Mongo local — nunca chama serviço
 * externo aqui pro caminho normal, já que essa decisão precisa ser
 * instantânea a cada passagem na catraca. Única exceção: quando o cache
 * local diz "inativo", confirma em tempo real antes de negar — é o único
 * jeito de pegar um check-in Wellhub/Totalpass feito minutos antes (não dá
 * pra cachear isso como o `ativo` normal, sincronizado a cada 10 min).
 *
 * Se o aluno tem `wellhubId` cadastrado, valida direto na API da Wellhub
 * (independente da EVO, ver `wellhub-access-control.ts`). Enquanto as
 * credenciais da Wellhub não chegam (`wellhubConfigurado() === false`),
 * libera provisoriamente só por ter `wellhubId` — sem confirmar o check-in
 * de verdade (ver NOTES.md). Assim que a credencial for configurada, esse
 * atalho para de valer e passa a validar o check-in de verdade.
 */
async function decidirAcesso(enrollid: number): Promise<AccessDecision> {
  // Personal trainer é decidido ANTES do CatracaAluno: o enrollid dele
  // (Carteirinha/`evoPersonalId`) colide com member/employee de outra pessoa,
  // então o registro em CatracaAluno pode estar com o nome/status errado (ex.:
  // enrollid 119 = personal Italo, mas CatracaAluno 119 foi enriquecido como
  // "Maiara", employee inativa). A coleção `Personal` é a fonte autoritativa.
  const personal = await getPersonalPorEnrollid(enrollid);
  if (personal) {
    return {
      enrollid,
      access: personal.valido,
      motivo: personal.valido ? "ok" : "personal_vencido",
      personType: PERSON_TYPE_PERSONAL,
    };
  }

  const aluno = await db.catracaAluno.findUnique({ where: { idMember: enrollid } });

  if (!aluno) {
    return { enrollid, access: false, motivo: "nao_cadastrado" };
  }

  const personType = aluno.tipo === "colaborador" ? PERSON_TYPE_COLABORADOR : PERSON_TYPE_CLIENTE;

  if (aluno.ativo) {
    // Débito vencido em aberto trava mesmo o aluno ativo (regra: qualquer
    // atraso, ver NOTES.md). Só pra "aluno" — colaborador não tem débito de
    // mensalidade, e o flag nunca é setado pra ele.
    if (aluno.tipo === "aluno" && aluno.comDebito) {
      return { enrollid, access: false, motivo: "saldo_devedor", personType };
    }
    if (aluno.tipo === "aluno") {
      const resultadoHorario = await checarHorario(aluno);
      if (resultadoHorario === "fora_do_horario") {
        return { enrollid, access: false, motivo: "fora_do_horario", personType };
      }
      if (resultadoHorario === "turma_sem_matricula") {
        return { enrollid, access: true, motivo: "turma_sem_matricula", personType };
      }
    }
    return { enrollid, access: true, motivo: "ok", personType };
  }

  if (aluno.wellhubId) {
    if (!wellhubConfigurado()) {
      return { enrollid, access: true, motivo: "wellhub_provisorio", personType };
    }
    // Reentrada no mesmo dia (ex.: foi no carro pegar algo e voltou, ou volta
    // à noite depois de já ter validado de manhã) — o check-in já foi
    // validado, uma segunda tentativa de /validate falharia mesmo com a
    // pessoa presente. Libera o dia todo sem chamar a Wellhub de novo.
    if (await passagemWellhubRecente(enrollid)) {
      return { enrollid, access: true, motivo: "wellhub_ok", personType };
    }
    const autorizacaoWellhub = await validarCheckInWellhub(aluno.wellhubId);
    if (autorizacaoWellhub?.autorizado) {
      return { enrollid, access: true, motivo: "wellhub_ok", personType };
    }
  }

  const autorizacao = await autorizarEntradaEvo(enrollid, personType);
  if (autorizacao?.autorizado) {
    return { enrollid, access: true, motivo: "ok", personType };
  }

  // Tem wellhubId cadastrado mas nem a Wellhub nem a EVO autorizaram — o
  // motivo mais provável é que ele não fez check-in no app ainda, não que o
  // "plano" em si tenha algum problema (ele não tem plano na EVO, só Wellhub).
  // Mensagem específica pra recepção não confundir com plano vencido/cancelado.
  if (aluno.wellhubId) {
    return { enrollid, access: false, motivo: "wellhub_sem_checkin" };
  }

  return { enrollid, access: false, motivo: "plano_inativo" };
}

/** Processa um lote de sendlog (pode ter 1 evento em tempo real ou vários de backlog). */
export async function handleSendLog(message: SendLogMessage): Promise<AccessDecision[]> {
  const decisoes: AccessDecision[] = [];

  for (const record of message.record) {
    const decisao = await decidirAcesso(record.enrollid);
    decisoes.push(decisao);

    if (isHistorico(record)) {
      continue;
    }

    await db.catracaAcessoLog.create({
      data: {
        idMember: record.enrollid,
        nome: record.name ?? null,
        permitido: decisao.access,
        motivo: decisao.motivo,
        personType: decisao.personType ?? null,
      },
    });
  }

  return decisoes;
}
