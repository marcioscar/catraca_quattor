import { db } from "../db.js";
import { buildSetUserInfo } from "./protocol.js";
import { isConnected, send } from "./connection-manager.js";
import { marcarConhecido } from "./known-aluno-cache.js";
import { buscarNomeEStatusPorIdMember } from "./evo-aluno-busca.js";

export type EnrollResult =
  | { ok: true }
  | { ok: false; reason: "device_offline" };

/**
 * Classifica (cria/corrige) um aluno ou colaborador no nosso banco — usado
 * pela tela local `/`. Não mexe no rosto do device: cadastro de rosto
 * confirmado em 2026-07-14 que só funciona pelo painel touch do leitor
 * (`setuserinfo` aceita o comando mas não gera reconhecimento de verdade,
 * ver NOTES.md). A foto real chega sozinha depois via `senduser`, assim que
 * a pessoa for cadastrada fisicamente.
 */
export async function classificarPessoa(
  idMember: number,
  nome: string,
  tipo: "aluno" | "colaborador"
): Promise<void> {
  await db.catracaAluno.upsert({
    where: { idMember },
    create: { idMember, nome, tipo, ativo: true },
    update: { nome, tipo, removidoEm: null },
  });
  marcarConhecido(idMember);
}

/**
 * Importa um aluno/colaborador que já está cadastrado no dispositivo
 * (descoberto via sendlog + getuserinfo) — sem foto local (chega depois via
 * `senduser`). Consulta a EVO pra descobrir o `tipo` certo (aluno x
 * colaborador) em vez de assumir aluno por padrão — mesma lógica usada no
 * enriquecimento em lote (`buscarNomeEStatusPorIdMember`), que já sabe
 * checar a lista de colaboradores conhecidos e os dois espaços de id da EVO.
 */
export async function importarAlunoDoDispositivo(idMember: number, nomeDoDevice: string): Promise<void> {
  const evo = await buscarNomeEStatusPorIdMember(idMember).catch(() => null);
  const nome = evo?.nome || nomeDoDevice || null;

  await db.catracaAluno.upsert({
    where: { idMember },
    create: { idMember, nome, tipo: evo?.tipo ?? "aluno", ativo: true },
    update: { nome: nome ?? undefined, tipo: evo?.tipo },
  });
  marcarConhecido(idMember);
}

/**
 * Foto empurrada espontaneamente pelo dispositivo (`senduser`) — vem como
 * base64 JPEG puro, sem prefixo `data:`, então adicionamos aqui para o
 * `<img src>` da tela funcionar direto.
 *
 * Só consulta a EVO (pra descobrir o `tipo`) quando o registro ainda não
 * existe — `senduser` pode reenviar a mesma foto de gente já conhecida
 * repetidas vezes (ver NOTES.md), e um lookup por evento aqui estouraria o
 * rate limit da EVO fácil. `importarAlunoDoDispositivo` já não tem esse
 * risco porque só pergunta uma vez por enrollid (`marcarPerguntadoSePrimeiraVez`).
 */
export async function importarFotoDoDispositivo(idMember: number, fotoBase64Pura: string): Promise<void> {
  const fotoBase64 = `data:image/jpeg;base64,${fotoBase64Pura}`;
  const existente = await db.catracaAluno.findUnique({ where: { idMember }, select: { id: true } });

  if (existente) {
    await db.catracaAluno.update({ where: { idMember }, data: { fotoBase64 } });
  } else {
    const evo = await buscarNomeEStatusPorIdMember(idMember).catch(() => null);
    await db.catracaAluno.create({
      data: { idMember, fotoBase64, nome: evo?.nome ?? null, tipo: evo?.tipo ?? "aluno", ativo: true },
    });
  }
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
