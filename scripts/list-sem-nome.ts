/**
 * Diagnóstico: confirma que `isSet: false` pega também documentos onde o
 * campo `nome` nunca foi gravado (não só null/"").
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
    select: { idMember: true, nome: true },
  });
  console.log("total com isSet:false incluso:", semNome.length);
  console.log(semNome.map((a) => a.idMember));

  await db.$disconnect();
  process.exit(0);
}

main();
