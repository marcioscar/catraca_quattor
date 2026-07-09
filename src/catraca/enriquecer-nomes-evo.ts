import { db } from "../db.js";
import { buscarNomeEStatusPorIdMember } from "./evo-aluno-busca.js";
import { NAO_REMOVIDO } from "./filtros.js";

/** Espaça as chamadas — a API da EVO tem rate limit agressivo (ver memória do projeto). */
const INTERVALO_MS = 400;

interface Progresso {
  rodando: boolean;
  processados: number;
  total: number;
  erros: number;
}

const progresso: Progresso = { rodando: false, processados: 0, total: 0, erros: 0 };

export function getProgressoEnriquecimento(): Progresso {
  return { ...progresso };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Preenche nome/ativo dos alunos importados do dispositivo sem nome, consultando a EVO por idMember. */
export async function enriquecerNomesEvo(): Promise<void> {
  if (progresso.rodando) {
    return;
  }
  progresso.rodando = true;
  progresso.processados = 0;
  progresso.erros = 0;

  try {
    const alunos = await db.catracaAluno.findMany({
      where: { AND: [{ OR: [{ nome: null }, { nome: "" }, { nome: { isSet: false } }] }, NAO_REMOVIDO] },
      select: { idMember: true },
    });
    progresso.total = alunos.length;

    for (const aluno of alunos) {
      try {
        const resultado = await buscarNomeEStatusPorIdMember(aluno.idMember);
        if (resultado?.nome) {
          await db.catracaAluno.update({
            where: { idMember: aluno.idMember },
            data: { nome: resultado.nome, ativo: resultado.ativo, tipo: resultado.tipo },
          });
        }
      } catch (error) {
        progresso.erros += 1;
        console.error(`[catraca] erro ao enriquecer idMember=${aluno.idMember}:`, error);
      }
      progresso.processados += 1;
      await sleep(INTERVALO_MS);
    }
  } finally {
    progresso.rodando = false;
  }
}
