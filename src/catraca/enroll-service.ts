import { db } from "../db.js";
import { buildSetUserInfo } from "./protocol.js";
import { isConnected, send } from "./connection-manager.js";
import { marcarConhecido } from "./known-aluno-cache.js";

export type EnrollResult =
  | { ok: true }
  | { ok: false; reason: "device_offline" };

export async function enrollAluno(
  idMember: number,
  nome: string,
  fotoBase64: string
): Promise<EnrollResult> {
  await db.catracaAluno.upsert({
    where: { idMember },
    create: { idMember, nome, fotoBase64, ativo: true },
    update: { nome, fotoBase64, ativo: true, removidoEm: null },
  });
  marcarConhecido(idMember);

  if (!isConnected()) {
    return { ok: false, reason: "device_offline" };
  }

  send(buildSetUserInfo(idMember, nome, fotoBase64));
  return { ok: true };
}

/**
 * Importa um aluno que já está cadastrado no dispositivo (descoberto via
 * sendlog + getuserinfo) — sem foto local, já que o rosto já está no
 * dispositivo e não precisamos reenviar nada.
 */
export async function importarAlunoDoDispositivo(idMember: number, nome: string): Promise<void> {
  await db.catracaAluno.upsert({
    where: { idMember },
    create: { idMember, nome: nome || null, ativo: true },
    update: { nome: nome || undefined },
  });
  marcarConhecido(idMember);
}

/**
 * Foto empurrada espontaneamente pelo dispositivo (`senduser`) — vem como
 * base64 JPEG puro, sem prefixo `data:`, então adicionamos aqui para o
 * `<img src>` da tela funcionar direto.
 */
export async function importarFotoDoDispositivo(idMember: number, fotoBase64Pura: string): Promise<void> {
  await db.catracaAluno.upsert({
    where: { idMember },
    create: { idMember, fotoBase64: `data:image/jpeg;base64,${fotoBase64Pura}`, ativo: true },
    update: { fotoBase64: `data:image/jpeg;base64,${fotoBase64Pura}` },
  });
  marcarConhecido(idMember);
}

export async function removeAluno(idMember: number): Promise<EnrollResult> {
  await db.catracaAluno.update({
    where: { idMember },
    data: { ativo: false, removidoEm: new Date() },
  });

  // Sem comando de exclusão confirmado no protocolo — marcar inativo no
  // Mongo já é suficiente para negar acesso (modo online consulta o Mongo a
  // cada sendlog). Envio ao device é só para limpeza de PII, best-effort.
  if (!isConnected()) {
    return { ok: false, reason: "device_offline" };
  }

  send(buildSetUserInfo(idMember, "", ""));
  return { ok: true };
}
