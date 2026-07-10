/**
 * Roda o enriquecimento de nomes via API ao vivo da EVO (enriquecer-nomes-evo.ts)
 * fora do processo principal, pra alunos sem nome que não têm dado local em
 * EvoCliente/colaboradores (ver backfill-nomes-evo-cliente.ts).
 *
 * Uso: npx tsx scripts/rodar-enriquecimento.ts
 */
import { readFileSync } from "node:fs";

const raw = readFileSync(new URL("../.env", import.meta.url), "utf-8");
for (const linha of raw.split("\n")) {
  const match = linha.match(/^([A-Z_]+)=(.*)$/);
  if (match) {
    const [, chave, valor] = match;
    if (!process.env[chave]) process.env[chave] = valor.trim().replace(/^"|"$/g, "");
  }
}

const { enriquecerNomesEvo, getProgressoEnriquecimento } = await import("../src/catraca/enriquecer-nomes-evo.js");

await enriquecerNomesEvo();
console.log(JSON.stringify(getProgressoEnriquecimento(), null, 2));
process.exit(0);
