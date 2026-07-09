/**
 * Preenche nome/ativo/tipo de CatracaAluno usando dados já sincronizados
 * localmente em EvoCliente (populado por evo-clientes-sync.ts) — muito mais
 * rápido que enriquecer-nomes-evo.ts (que bate na API da EVO ao vivo, com
 * rate limit). Só sobra pra enriquecer-nomes-evo.ts quem não aparece nem na
 * lista de colaboradores conhecidos nem em EvoCliente (idEmployee sem
 * colisão registrada, por exemplo).
 *
 * Prioridade igual a `buscarNomeEStatusPorIdMember` (evo-aluno-busca.ts):
 * lista manual de colaboradores conhecidos sempre vence, por causa da
 * colisão de id entre idMember e idEmployee na EVO (ver NOTES.md).
 *
 * Uso: npx tsx scripts/backfill-nomes-evo-cliente.ts
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
  const db = new PrismaClient({ datasources: { db: { url: lerDatabaseUrl() } } });

  const semNome = await db.catracaAluno.findMany({
    where: { OR: [{ nome: null }, { nome: "" }, { nome: { isSet: false } }] },
  });

  let viaColaborador = 0;
  let viaEvoCliente = 0;
  let semDadoLocal = 0;

  for (const aluno of semNome) {
    const colaborador = getColaboradorConhecido(aluno.idMember);
    if (colaborador) {
      await db.catracaAluno.update({
        where: { idMember: aluno.idMember },
        data: { nome: colaborador.nome, tipo: "colaborador", ativo: colaborador.status.toLowerCase() === "ativo" },
      });
      viaColaborador += 1;
      continue;
    }

    const cliente = await db.evoCliente.findUnique({ where: { idMember: aluno.idMember } });
    const nome = cliente ? [cliente.firstName, cliente.lastName].filter(Boolean).join(" ").trim() : "";
    if (cliente && nome) {
      await db.catracaAluno.update({
        where: { idMember: aluno.idMember },
        data: { nome, tipo: "aluno", ativo: cliente.status === "Active" },
      });
      viaEvoCliente += 1;
      continue;
    }

    semDadoLocal += 1;
  }

  console.log(
    JSON.stringify(
      {
        total: semNome.length,
        viaColaborador,
        viaEvoCliente,
        semDadoLocal, // esses precisam de enriquecer-nomes-evo.ts (API ao vivo) ou não existem na EVO
      },
      null,
      2
    )
  );

  await db.$disconnect();
  process.exit(0);
}

main();
