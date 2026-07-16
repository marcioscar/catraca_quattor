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
    // Mesmo formato do device real: lote com record[], time local recente.
    const pad = (v: number) => String(v).padStart(2, "0");
    const agora = new Date();
    const time = `${agora.getFullYear()}-${pad(agora.getMonth() + 1)}-${pad(agora.getDate())} ${pad(agora.getHours())}:${pad(agora.getMinutes())}:${pad(agora.getSeconds())}`;
    socket.send(
      JSON.stringify({
        cmd: "sendlog",
        sn: "FAKE-DEVICE-001",
        count: 1,
        logindex: 0,
        record: [{ enrollid, name: "", time, mode: 8, inout: 0, event: 0 }],
      })
    );
    return;
  }

  if (message.ret === "sendlog") {
    console.log(`[fake-device] resposta do servidor: access=${message.access} (undefined = sem decisão)`);
    socket.close();
  }
});

socket.on("error", (error) => {
  console.error("[fake-device] erro:", error);
  process.exit(1);
});
