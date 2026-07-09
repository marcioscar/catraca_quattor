import { db } from "../db.js";
import { autorizarEntradaEvo, PERSON_TYPE_CLIENTE, PERSON_TYPE_COLABORADOR } from "./evo-access-control.js";
import { validarCheckInWellhub, wellhubConfigurado } from "./wellhub-access-control.js";
import type { SendLogMessage, SendLogRecord } from "./protocol.js";

export interface AccessDecision {
  enrollid: number;
  access: boolean;
  motivo: "ok" | "plano_inativo" | "nao_cadastrado" | "wellhub_provisorio" | "wellhub_ok";
}

/** Registros mais antigos que isso são backlog acumulado (reader ficou
 * offline), não uma passagem em tempo real — não gravamos no log de acessos
 * pra não inflar o histórico com dados antigos a cada reconexão. */
const HISTORICO_LIMITE_MS = 10 * 60 * 1000;

function isHistorico(record: SendLogRecord): boolean {
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
  const aluno = await db.catracaAluno.findUnique({ where: { idMember: enrollid } });

  if (!aluno) {
    return { enrollid, access: false, motivo: "nao_cadastrado" };
  }
  if (aluno.ativo) {
    return { enrollid, access: true, motivo: "ok" };
  }

  if (aluno.wellhubId) {
    if (!wellhubConfigurado()) {
      return { enrollid, access: true, motivo: "wellhub_provisorio" };
    }
    const autorizacaoWellhub = await validarCheckInWellhub(aluno.wellhubId);
    if (autorizacaoWellhub?.autorizado) {
      return { enrollid, access: true, motivo: "wellhub_ok" };
    }
  }

  const personType = aluno.tipo === "colaborador" ? PERSON_TYPE_COLABORADOR : PERSON_TYPE_CLIENTE;
  const autorizacao = await autorizarEntradaEvo(enrollid, personType);
  if (autorizacao?.autorizado) {
    return { enrollid, access: true, motivo: "ok" };
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
      },
    });
  }

  return decisoes;
}
