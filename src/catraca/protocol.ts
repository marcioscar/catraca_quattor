/**
 * Protocolo do leitor facial TopData (WebSocket, JSON com campos `cmd`/`ret`) —
 * modelo real "AiFace" (família ZKTeco). Confirmado contra o dispositivo real
 * no bring-up on-site: `reg` traz `devinfo` com contagens de usuários/logs, e
 * `sendlog` vem em LOTE (`record[]`, com `count`/`logindex` para paginação),
 * não um evento por mensagem como versões anteriores deste arquivo assumiam.
 */

export interface RegMessage {
  cmd: "reg";
  sn?: string;
  devinfo?: Record<string, unknown>;
}

export interface SendLogRecord {
  enrollid: number;
  name?: string;
  time?: string;
  mode?: number;
  inout?: number;
  event?: number;
}

export interface SendLogMessage {
  cmd: "sendlog";
  sn?: string;
  count?: number;
  logindex?: number;
  record: SendLogRecord[];
}

/** Resposta do dispositivo a um `getuserinfo` que nós enviamos. */
export interface GetUserInfoReply {
  ret: "getuserinfo";
  sn?: string;
  enrollid: number;
  name?: string;
  result: boolean;
}

/**
 * O dispositivo empurra isso por conta própria (não pedimos) — parece uma
 * sincronização de usuário+foto, um de cada vez, junto com o `record` sendo
 * a foto em base64 JPEG puro (sem prefixo `data:`).
 */
export interface SendUserMessage {
  cmd: "senduser";
  sn?: string;
  enrollid: number;
  name?: string;
  record?: string;
}

export type DeviceMessage =
  | RegMessage
  | SendLogMessage
  | GetUserInfoReply
  | SendUserMessage
  | { cmd: string; [key: string]: unknown }
  | { ret: string; [key: string]: unknown };

export function parseDeviceMessage(raw: string): DeviceMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  // Mensagens iniciadas pelo device usam "cmd" (reg, sendlog); respostas a
  // comandos que nós enviamos usam "ret" (getuserinfo, etc) — sem "cmd".
  if (!parsed || typeof parsed !== "object" || (!("cmd" in parsed) && !("ret" in parsed))) {
    return null;
  }

  return parsed as DeviceMessage;
}

export function isRegMessage(message: DeviceMessage): message is RegMessage {
  return "cmd" in message && message.cmd === "reg";
}

export function isSendLogMessage(message: DeviceMessage): message is SendLogMessage {
  return "cmd" in message && message.cmd === "sendlog" && Array.isArray((message as SendLogMessage).record);
}

export function isGetUserInfoReply(message: DeviceMessage): message is GetUserInfoReply {
  return (
    "ret" in message &&
    message.ret === "getuserinfo" &&
    typeof (message as GetUserInfoReply).enrollid === "number" &&
    (message as GetUserInfoReply).result === true
  );
}

export function isSendUserMessage(message: DeviceMessage): message is SendUserMessage {
  return "cmd" in message && message.cmd === "senduser" && typeof (message as SendUserMessage).enrollid === "number";
}

export function buildSendUserAck(): string {
  return JSON.stringify({ ret: "senduser", result: true });
}

export function buildRegAck(): string {
  return JSON.stringify({ ret: "reg", result: true });
}

/**
 * Ack do lote de sendlog — sem confirmação oficial do formato exato, mas
 * ecoar `count`/`logindex` recebidos segue a convenção já validada do `reg`
 * (campo `ret` + `result`) e é a suposição mais segura para o dispositivo
 * avançar o cursor de log em vez de reenviar o mesmo lote.
 */
export function buildSendLogAck(count: number, logindex: number): string {
  return JSON.stringify({ ret: "sendlog", result: true, count, logindex });
}

export function buildAccessReply(enrollid: number, access: boolean): string {
  return JSON.stringify({ ret: "sendlog", enrollid, access });
}

/**
 * Remove o prefixo `data:image/...;base64,` (presente quando a foto vem de
 * `canvas.toDataURL()` na tela local de cadastro) — o device manda fotos
 * nesse mesmo formato só que em base64 puro (confirmado via `senduser`, ver
 * `SendUserMessage`), então é o que ele deve esperar receber também.
 */
function paraBase64Puro(fotoBase64: string): string {
  const virgula = fotoBase64.indexOf(",");
  return fotoBase64.startsWith("data:") && virgula !== -1 ? fotoBase64.slice(virgula + 1) : fotoBase64;
}

export function buildSetUserInfo(enrollid: number, nome: string, fotoBase64: string): string {
  // Campos exatos (nome do campo, limites) ainda não confirmados contra o
  // dispositivo real — só o encoding (base64 puro) é conhecido com certeza.
  return JSON.stringify({
    cmd: "setuserinfo",
    enrollid,
    name: nome,
    record: paraBase64Puro(fotoBase64),
  });
}

export function buildGetUserInfo(enrollid: number): string {
  return JSON.stringify({ cmd: "getuserinfo", enrollid });
}
