/**
 * Lista os idMembers de CatracaAluno sem nome no momento (diagnóstico).
 * Usa `isSet: false` além de null/"" porque o Prisma no Mongo não considera
 * campo ausente igual a null num filtro `{ nome: null }` simples.
 * Uso: npx tsx scripts/list-sem-nome.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

function lerDatabaseUrl(): string {
  const raw = readFileSync(new URL("../.env", import.meta.url), "utf-8");
  const linha = raw.split("\n").find((l) => l.startsWith("DATABASE_URL="));
  if (!linha) throw new Error("DATABASE_URL não encontrada no .env");
  return linha.slice("DATABASE_URL=".length).trim().replace(/^"|"$/g, "");
}

async function main() {
  const db = new PrismaClient({ datasources: { db: { url: lerDatabaseUrl() } } });
  const semNome = await db.catracaAluno.findMany({
    where: { OR: [{ nome: null }, { nome: "" }, { nome: { isSet: false } }] },
    select: { idMember: true, nome: true, atualizadoEm: true },
  });
  console.log("total:", semNome.length);
  console.log(JSON.stringify(semNome, null, 2));
  await db.$disconnect();
  process.exit(0);
}

main();
