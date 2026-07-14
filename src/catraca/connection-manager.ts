import type { WebSocket } from "ws";
import { registrarMensagem } from "./debug-log.js";

/**
 * Guarda a única conexão viva da catraca (escopo: um único dispositivo).
 * A cada `reg` a conexão anterior (se ainda aberta) é fechada, já que o
 * dispositivo físico só mantém uma sessão por vez.
 */
let activeSocket: WebSocket | null = null;
let lastSeenAt: Date | null = null;

export function setActiveConnection(socket: WebSocket): void {
  if (activeSocket && activeSocket !== socket && activeSocket.readyState === activeSocket.OPEN) {
    activeSocket.close();
  }
  activeSocket = socket;
  lastSeenAt = new Date();

  socket.on("close", () => {
    if (activeSocket === socket) {
      activeSocket = null;
    }
  });
}

export function touchLastSeen(): void {
  lastSeenAt = new Date();
}

export function isConnected(): boolean {
  return activeSocket !== null && activeSocket.readyState === activeSocket.OPEN;
}

export function getLastSeenAt(): Date | null {
  return lastSeenAt;
}

export function send(message: string): boolean {
  if (!isConnected() || !activeSocket) {
    return false;
  }
  registrarMensagem("out", message);
  activeSocket.send(message);
  return true;
}
