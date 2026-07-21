import { db } from "../db.js";
import { fetchIdEmployeesAtivos, fetchIdMembersAtivos } from "./evo-active-members.js";
import { sincronizarDebitosEvo } from "./evo-debito-sync.js";
import { sincronizarPersonais } from "./personal-sync.js";
import { autoValidarCheckinsPendentes } from "./wellhub-checkins.js";
import { NAO_REMOVIDO } from "./filtros.js";

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

function sincronizarContra(
  cadastrados: { idMember: number; ativo: boolean }[],
  idsAtivosNaEvo: Set<number>
): Promise<unknown>[] {
  return cadastrados
    .filter((registro) => registro.ativo !== idsAtivosNaEvo.has(registro.idMember))
    .map((registro) =>
      db.catracaAluno.update({
        where: { idMember: registro.idMember },
        data: { ativo: idsAtivosNaEvo.has(registro.idMember) },
      })
    );
}

/**
 * Atualiza `ativo` só de quem já está cadastrado na catraca — não há motivo
 * para sincronizar quem nunca foi cadastrado no dispositivo. Alunos e
 * colaboradores vivem em APIs/espaços de id diferentes na EVO (`idMember` x
 * `idEmployee`), então cada grupo sincroniza contra a lista certa.
 */
async function syncAtivos(): Promise<void> {
  const cadastrados = await db.catracaAluno.findMany({
    where: NAO_REMOVIDO,
    select: { idMember: true, ativo: true, tipo: true },
  });
  if (cadastrados.length === 0) {
    return;
  }

  // Personal (tipo "personal") tem `ativo` vindo da validade do contrato
  // (personal-sync.ts) — não sincroniza contra member/employee (o enrollid
  // dele colide com outra pessoa, daria status errado).
  const alunos = cadastrados.filter((r) => r.tipo !== "colaborador" && r.tipo !== "personal");
  const colaboradores = cadastrados.filter((registro) => registro.tipo === "colaborador");

  const [idsAlunosAtivos, idsColaboradoresAtivos] = await Promise.all([
    alunos.length > 0 ? fetchIdMembersAtivos() : Promise.resolve(new Set<number>()),
    colaboradores.length > 0 ? fetchIdEmployeesAtivos() : Promise.resolve(new Set<number>()),
  ]);

  await Promise.all([
    ...sincronizarContra(alunos, idsAlunosAtivos),
    ...sincronizarContra(colaboradores, idsColaboradoresAtivos),
  ]);
}

/** Roda os syncs de forma independente — falha de um não impede os outros. */
function rodarSyncs(): void {
  syncAtivos().catch((error) => console.error("[catraca] erro no sync de ativos:", error));
  sincronizarDebitosEvo().catch((error) => console.error("[catraca] erro no sync de débitos:", error));
  sincronizarPersonais().catch((error) => console.error("[catraca] erro no sync de personais:", error));
  autoValidarCheckinsPendentes().catch((error) => console.error("[catraca] erro na auto-validação Wellhub:", error));
}

export function startEvoSyncJob(intervalMs = DEFAULT_INTERVAL_MS): void {
  rodarSyncs();
  setInterval(rodarSyncs, intervalMs);
}
