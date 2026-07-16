import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  buildGetUserInfo,
  buildRegAck,
  buildSendLogAck,
  buildSendUserAck,
  isGetUserInfoReply,
  isRegMessage,
  isSendLogMessage,
  isSendUserMessage,
  parseDeviceMessage,
} from "./protocol.js";
import { setActiveConnection, send, touchLastSeen } from "./connection-manager.js";
import { handleSendLog, isHistorico, type AccessDecision } from "./access-handler.js";
import { importarAlunoDoDispositivo, importarFotoDoDispositivo } from "./enroll-service.js";
import { jaConhecido, marcarPerguntadoSePrimeiraVez } from "./known-aluno-cache.js";
import { registrarMensagem } from "./debug-log.js";
import type { SendLogMessage, SendLogRecord } from "./protocol.js";

/**
 * Decisão de liberação da roleta pro modo "Servidor Valida: Sim" — só
 * definida numa passagem real-time única (não backlog). Retorna `undefined`
 * pra não enviar campo de acesso nenhum (ack normal) em backlog ou lote.
 *
 * **Fail-open pra enrollid desconhecido** (`nao_cadastrado`): quem está
 * cadastrado no leitor mas ainda não é conhecido por nós é provavelmente
 * membro legítimo ainda não importado — libera e loga pra revisão (estratégia
 * de transição documentada no NOTES.md). Só bloqueia de fato quem a gente
 * CONHECE e negou (inativo, fora do horário).
 */
function decisaoDeAcessoParaDevice(
  message: SendLogMessage,
  decisoes: AccessDecision[]
): boolean | undefined {
  if (message.record.length !== 1 || decisoes.length !== 1 || isHistorico(message.record[0])) {
    return undefined;
  }
  const decisao = decisoes[0];
  return decisao.access || decisao.motivo === "nao_cadastrado";
}

/** Backlog anterior a isso é ignorado para fins de importação — aluno que só
 * aparece antes disso muito provavelmente já não frequenta mais a academia. */
const CORTE_IMPORTACAO = "2025-01-01";

/**
 * Pergunta `getuserinfo` pros alunos que o dispositivo já tem cadastrado mas
 * ainda não conhecemos (descobertos pelo `enrollid` que aparece no sendlog) —
 * assim importamos o cadastro existente (nome) sem precisar recapturar foto.
 * Só considera registros de 2025 em diante (backlog mais antigo é só
 * confirmado/avançado, não gera importação).
 */
function descobrirAlunosDesconhecidos(records: SendLogRecord[]): void {
  for (const record of records) {
    if (record.time && record.time < CORTE_IMPORTACAO) {
      continue;
    }
    if (jaConhecido(record.enrollid) || !marcarPerguntadoSePrimeiraVez(record.enrollid)) {
      continue;
    }
    send(buildGetUserInfo(record.enrollid));
  }
}

function handleMessage(socket: WebSocket, raw: string): void {
  console.log(`[catraca] mensagem recebida: ${raw}`);
  registrarMensagem("in", raw);

  const message = parseDeviceMessage(raw);
  if (!message) {
    console.warn(`[catraca] mensagem não reconhecida (ignorada): ${raw}`);
    return;
  }

  touchLastSeen();

  if (isRegMessage(message)) {
    setActiveConnection(socket);
    socket.send(buildRegAck());
    return;
  }

  if (isSendLogMessage(message)) {
    descobrirAlunosDesconhecidos(message.record);
    handleSendLog(message)
      .then((decisoes) => {
        console.log(`[catraca] lote processado: ${decisoes.length} registro(s)`);
        const count = message.count ?? message.record.length;
        const logindex = message.logindex ?? 0;
        const ack = buildSendLogAck(count, logindex, decisaoDeAcessoParaDevice(message, decisoes));
        registrarMensagem("out", ack);
        socket.send(ack);
      })
      .catch((error) => {
        console.error("[catraca] erro ao processar sendlog:", error);
      });
    return;
  }

  if (isGetUserInfoReply(message)) {
    importarAlunoDoDispositivo(message.enrollid, message.name ?? "").catch((error) => {
      console.error("[catraca] erro ao importar aluno:", error);
    });
    return;
  }

  if (isSendUserMessage(message)) {
    const tarefa = message.record
      ? importarFotoDoDispositivo(message.enrollid, message.record)
      : Promise.resolve();
    tarefa
      .catch((error) => console.error("[catraca] erro ao importar foto:", error))
      .finally(() => socket.send(buildSendUserAck()));
    return;
  }
}

export function startCatracaWsServer(port: number): void {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (socket) => {
    console.log("[catraca] dispositivo conectado");
    socket.on("message", (data) => handleMessage(socket, data.toString()));
    socket.on("close", () => console.log("[catraca] dispositivo desconectado"));
    socket.on("error", (error) => console.error("[catraca] erro no socket:", error));
  });

  httpServer.listen(port, "0.0.0.0", () => {
    console.log(`[catraca] servidor WS ouvindo em 0.0.0.0:${port}`);
  });
}
