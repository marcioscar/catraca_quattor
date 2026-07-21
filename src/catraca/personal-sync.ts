import { db } from "../db.js";
import { temContratoValido } from "./personal.js";

/**
 * Espelha a coleção `Personal` no `CatracaAluno` (nome + tipo "personal" +
 * ativo pela validade do contrato) — só pra o NOME e o status aparecerem
 * certos nas telas (log/monitor/cadastro). A DECISÃO de acesso não depende
 * disso: `access-handler` lê a coleção `Personal` direto (sempre atual, ver
 * personal.ts). Corrige registros enriquecidos errado (ex.: enrollid 119
 * estava como "Maiara" — colisão de id, ver NOTES.md).
 *
 * Barato (poucos personais, leitura local no Mongo, sem chamar a EVO), então
 * roda automático a cada ciclo junto do sync de `ativo` (evo-sync-job.ts).
 * Não sobrescreve a foto (mantém a que veio do device).
 */
export async function sincronizarPersonais(): Promise<number> {
  const personais = await db.personal.findMany();

  for (const p of personais) {
    const ativo = temContratoValido(p.contratos);
    await db.catracaAluno.upsert({
      where: { idMember: p.evoPersonalId },
      create: { idMember: p.evoPersonalId, nome: p.nome, tipo: "personal", ativo },
      update: { nome: p.nome, tipo: "personal", ativo },
    });
  }

  return personais.length;
}
