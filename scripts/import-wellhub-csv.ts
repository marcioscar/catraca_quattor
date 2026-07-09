/**
 * Popula CatracaAluno.wellhubId em lote a partir do relatório de check-ins
 * Wellhub exportado do painel da EVO (colunas `ID` = idMember, `ID
 * Agregador` = gympass_id). Não existe endpoint de API pra isso (ver
 * NOTES.md) — o relatório exportado manualmente é a única fonte em lote.
 *
 * Uso: npx tsx scripts/import-wellhub-csv.ts /caminho/para/wellhub.csv
 */
import { readFileSync } from "node:fs";
import { db } from "../src/db.js";

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error("Uso: npx tsx scripts/import-wellhub-csv.ts /caminho/para/wellhub.csv");
    process.exit(1);
  }

  const raw = readFileSync(csvPath, "utf-8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const [, ...rows] = lines; // drop header

  const idToWellhubIds = new Map<number, Map<string, number>>(); // idMember -> (wellhubId -> ocorrências)

  for (const row of rows) {
    const cols = row.split(";");
    const idMember = Number(cols[0]);
    const wellhubId = cols[5]?.trim();
    if (!idMember || !wellhubId) continue; // id=0 = check-in não vinculado a cadastro na EVO

    if (!idToWellhubIds.has(idMember)) idToWellhubIds.set(idMember, new Map());
    const counts = idToWellhubIds.get(idMember)!;
    counts.set(wellhubId, (counts.get(wellhubId) ?? 0) + 1);
  }

  // Se o mesmo aluno aparece com mais de um gympass_id ao longo do
  // histórico (trocou de conta Wellhub), usa o mais frequente.
  const conflicts: { idMember: number; options: string[] }[] = [];
  const resolved = new Map<number, string>();
  for (const [idMember, counts] of idToWellhubIds) {
    if (counts.size > 1) {
      conflicts.push({ idMember, options: [...counts.entries()].map(([id, c]) => `${id} (x${c})`) });
    }
    const [bestId] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    resolved.set(idMember, bestId);
  }

  console.log(JSON.stringify({ totalRows: rows.length, uniqueIdMembers: resolved.size, conflicts }, null, 2));

  let atualizados = 0;
  const naoEncontrados: number[] = [];

  for (const [idMember, wellhubId] of resolved) {
    const aluno = await db.catracaAluno.findUnique({ where: { idMember } });
    if (!aluno) {
      naoEncontrados.push(idMember);
      continue;
    }
    await db.catracaAluno.update({ where: { idMember }, data: { wellhubId } });
    atualizados += 1;
  }

  console.log(JSON.stringify({ atualizados, naoEncontrados: naoEncontrados.length, naoEncontradosLista: naoEncontrados }, null, 2));

  process.exit(0);
}

main();
