import { db } from "../db.js";
import type { SendLogMessage, SendLogRecord } from "./protocol.js";

export interface AccessDecision {
  enrollid: number;
  access: boolean;
  motivo: "ok" | "plano_inativo" | "nao_cadastrado";
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
 * Decide liberar/negar com base só no Mongo local — nunca chama a EVO aqui,
 * já que essa decisão precisa ser instantânea a cada passagem na catraca.
 */
async function decidirAcesso(enrollid: number): Promise<AccessDecision> {
  const aluno = await db.catracaAluno.findUnique({ where: { idMember: enrollid } });

  if (!aluno) {
    return { enrollid, access: false, motivo: "nao_cadastrado" };
  }
  return aluno.ativo
    ? { enrollid, access: true, motivo: "ok" }
    : { enrollid, access: false, motivo: "plano_inativo" };
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
