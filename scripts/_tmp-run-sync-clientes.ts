import { db } from "../src/db.js";
import { sincronizarClientesEvo, getProgressoSincronizacaoClientes } from "../src/catraca/evo-clientes-sync.js";

async function main() {
  const antesWellhub = await db.catracaAluno.count({ where: { wellhubId: { not: null } } });
  console.log("wellhubId vinculados ANTES:", antesWellhub);
  console.log("iniciando sync completo (pode levar alguns minutos)...");

  const inicio = Date.now();
  const promessa = sincronizarClientesEvo();

  const intervalo = setInterval(() => {
    const p = getProgressoSincronizacaoClientes();
    console.log(`  progresso: ${p.processados}/${p.total || "?"} | erros: ${p.erros} | skip: ${p.ultimoSkip}`);
  }, 15000);

  await promessa;
  clearInterval(intervalo);

  const duracaoS = Math.round((Date.now() - inicio) / 1000);
  const depoisWellhub = await db.catracaAluno.count({ where: { wellhubId: { not: null } } });
  console.log(`\nconcluído em ${duracaoS}s`);
  console.log("wellhubId vinculados DEPOIS:", depoisWellhub, `(+${depoisWellhub - antesWellhub})`);

  await db.$disconnect(); process.exit(0);
}
main();
