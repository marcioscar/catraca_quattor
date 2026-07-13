/**
 * Diagnóstico rápido de um idMember específico: mostra o que está salvo em
 * CatracaAluno, EvoCliente, colaboradores conhecidos, e os últimos acessos
 * registrados em CatracaAcessoLog.
 *
 * Uso: npx tsx scripts/check-idmember.ts 24418
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { getColaboradorConhecido } from "../src/catraca/colaboradores-conhecidos.js";

function lerDatabaseUrl(): string {
  const raw = readFileSync(new URL("../.env", import.meta.url), "utf-8");
  const linha = raw.split("\n").find((l) => l.startsWith("DATABASE_URL="));
  if (!linha) throw new Error("DATABASE_URL não encontrada no .env");
  return linha.slice("DATABASE_URL=".length).trim().replace(/^"|"$/g, "");
}

async function main() {
  const idMember = Number(process.argv[2]);
  if (!idMember) throw new Error("Uso: npx tsx scripts/check-idmember.ts <idMember>");

  const db = new PrismaClient({ datasources: { db: { url: lerDatabaseUrl() } } });

  const aluno = await db.catracaAluno.findUnique({ where: { idMember } });
  const cliente = await db.evoCliente.findUnique({ where: { idMember } });
  const colaborador = getColaboradorConhecido(idMember);
  const acessos = await db.catracaAcessoLog.findMany({
    where: { idMember },
    orderBy: { ocorridoEm: "desc" },
    take: 5,
  });

  const alunoSemFoto = aluno ? { ...aluno, fotoBase64: aluno.fotoBase64 ? "[omitido]" : null } : null;

  console.log(JSON.stringify({ aluno: alunoSemFoto, cliente, colaborador, acessos }, null, 2));

  await db.$disconnect();
  process.exit(0);
}

main();
