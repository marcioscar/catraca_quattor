/**
 * Simula a catraca conectando no bridge WS local para validar o roundtrip
 * reg/sendlog sem precisar do hardware real.
 *
 * Uso:
 *   pnpm --filter api fake-device -- <enrollid>
 */
import WebSocket from "ws";

const port = Number(process.env.CATRACA_WS_PORT) || 7792;
const enrollid = Number(process.argv[2]);

if (!Number.isInteger(enrollid)) {
  console.error("Uso: pnpm --filter api fake-device -- <enrollid>");
  process.exit(1);
}

const socket = new WebSocket(`ws://localhost:${port}`);

socket.on("open", () => {
  console.log("[fake-device] conectado, enviando reg");
  socket.send(JSON.stringify({ cmd: "reg", sn: "FAKE-DEVICE-001" }));
});

socket.on("message", (data) => {
  console.log(`[fake-device] recebido: ${data.toString()}`);

  const message = JSON.parse(data.toString());
  if (message.ret === "reg") {
    console.log(`[fake-device] enviando sendlog para enrollid=${enrollid}`);
    socket.send(JSON.stringify({ cmd: "sendlog", enrollid, time: new Date().toISOString() }));
    return;
  }

  if (message.ret === "sendlog") {
    console.log(`[fake-device] decisão: access=${message.access}`);
    socket.close();
  }
});

socket.on("error", (error) => {
  console.error("[fake-device] erro:", error);
  process.exit(1);
});
