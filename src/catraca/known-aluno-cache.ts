import { db } from "../db.js";

/**
 * Cache em memória dos idMembers já conhecidos (cadastrados no nosso Mongo)
 * — evita perguntar `getuserinfo` de novo pra quem já importamos, e evita
 * uma query no Mongo por registro de sendlog (que chegam aos milhares).
 */
const conhecidos = new Set<number>();
const perguntados = new Set<number>();

export async function carregarCacheInicial(): Promise<void> {
  const alunos = await db.catracaAluno.findMany({ select: { idMember: true } });
  for (const aluno of alunos) {
    conhecidos.add(aluno.idMember);
  }
}

export function jaConhecido(idMember: number): boolean {
  return conhecidos.has(idMember);
}

export function marcarConhecido(idMember: number): void {
  conhecidos.add(idMember);
  perguntados.delete(idMember);
}

/** Marca como perguntado e retorna true só na primeira vez (evita perguntar 2x). */
export function marcarPerguntadoSePrimeiraVez(idMember: number): boolean {
  if (perguntados.has(idMember)) {
    return false;
  }
  perguntados.add(idMember);
  return true;
}
