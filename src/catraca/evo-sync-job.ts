import { db } from "../db.js";
import { fetchIdMembersAtivos } from "./evo-active-members.js";
import { NAO_REMOVIDO } from "./filtros.js";

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Atualiza `ativo` só dos alunos já cadastrados na catraca — não há motivo
 * para sincronizar quem nunca foi cadastrado no dispositivo.
 */
async function syncAtivos(): Promise<void> {
  const cadastrados = await db.catracaAluno.findMany({
    where: NAO_REMOVIDO,
    select: { idMember: true, ativo: true },
  });
  if (cadastrados.length === 0) {
    return;
  }

  const idsAtivosNaEvo = await fetchIdMembersAtivos();

  await Promise.all(
    cadastrados
      .filter((aluno) => aluno.ativo !== idsAtivosNaEvo.has(aluno.idMember))
      .map((aluno) =>
        db.catracaAluno.update({
          where: { idMember: aluno.idMember },
          data: { ativo: idsAtivosNaEvo.has(aluno.idMember) },
        })
      )
  );
}

export function startEvoSyncJob(intervalMs = DEFAULT_INTERVAL_MS): void {
  syncAtivos().catch((error) => console.error("[catraca] erro no sync inicial da EVO:", error));

  setInterval(() => {
    syncAtivos().catch((error) => console.error("[catraca] erro no sync periódico da EVO:", error));
  }, intervalMs);
}
