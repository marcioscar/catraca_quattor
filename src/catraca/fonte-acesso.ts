/**
 * F2 do contrato recepcao ↔ catraca-api (seção 6): de onde vem a decisão de
 * acesso do aluno.
 *
 * - `CATRACA_FONTE_ACESSO=evo` (padrão): como sempre — `ativo`, `comDebito`,
 *   `idMembershipsAtivos` e `turmaHorarios`, escritos pelos jobs da EVO.
 * - `CATRACA_FONTE_ACESSO=recepcao` (a virada, F3): os campos-sombra que o
 *   `recepcao` publica em todo evento e reconcilia a cada 10 min
 *   (`ativoLocal`, `comDebitoLocal`, `acessoLivre`, `janelasAcesso`,
 *   `turmaSemMatricula`). Voltar pra `evo` é só trocar a variável e religar o
 *   serviço — os jobs da EVO continuam escrevendo os campos antigos.
 *
 * Módulo puro (sem banco) pra ser testável — quem lê o Mongo e trata a
 * Wellhub é o access-handler.ts.
 */

export type FonteAcesso = "evo" | "recepcao";

export function fonteAcesso(valor: string | undefined): FonteAcesso {
  return valor?.trim().toLowerCase() === "recepcao" ? "recepcao" : "evo";
}

/** Formato de `CatracaAluno.janelasAcesso` (igual ao `JanelaAcesso` do recepcao). */
export interface JanelaAcessoLocal {
  /** 0 = domingo … 6 = sábado (`Date.getDay()`), ou "feriado". */
  weekDay: number | "feriado";
  inicio: string; // "HH:MM"
  fim: string; // "HH:MM"
  tolAntesMin: number;
  tolDepoisMin: number;
  origem?: string;
}

export interface CamposRecepcao {
  publicadoEm: Date | null;
  ativoLocal: boolean | null;
  comDebitoLocal: boolean | null;
  acessoLivre: boolean | null;
  janelasAcesso: unknown;
  turmaSemMatricula: boolean | null;
}

export type DecisaoLocal =
  /** Nunca publicado pelo recepcao — o access-handler cai nos campos da EVO. */
  | "sem_publicacao"
  | "inativo"
  | "saldo_devedor"
  | "liberado"
  | "turma_sem_matricula"
  | "fora_do_horario";

function minutos(horaMinuto: string): number {
  const [h, m] = horaMinuto.slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

function ehJanela(j: unknown): j is JanelaAcessoLocal {
  if (!j || typeof j !== "object") return false;
  const o = j as Record<string, unknown>;
  return (
    (typeof o.weekDay === "number" || o.weekDay === "feriado") &&
    typeof o.inicio === "string" &&
    typeof o.fim === "string"
  );
}

export function lerJanelas(valor: unknown): JanelaAcessoLocal[] {
  return Array.isArray(valor) ? valor.filter(ehJanela) : [];
}

/**
 * Em feriado valem só as janelas `weekDay: "feriado"`; nos outros dias, as do
 * dia da semana. A tolerância vem de cada janela (o recepcao já grava a da
 * Hora Certa e a da turma).
 */
export function dentroDasJanelas(agora: Date, janelas: JanelaAcessoLocal[], feriado: boolean): boolean {
  const chave: number | "feriado" = feriado ? "feriado" : agora.getDay();
  const agoraMin = agora.getHours() * 60 + agora.getMinutes();
  return janelas.some((j) => {
    if (j.weekDay !== chave) return false;
    const inicio = minutos(j.inicio) - (Number(j.tolAntesMin) || 0);
    const fim = minutos(j.fim) + (Number(j.tolDepoisMin) || 0);
    return agoraMin >= inicio && agoraMin <= fim;
  });
}

/**
 * A decisão pelos campos do recepcao, na mesma ordem das regras da EVO:
 * inativo → débito → plano livre → turma sem matrícula (libera, decisão de
 * 21/07) → janela de horário. Wellhub fica com o access-handler (entra por
 * cima de "inativo" e de "fora_do_horario", igual hoje).
 */
export function decidirPeloRecepcao(aluno: CamposRecepcao, agora: Date, feriado: boolean): DecisaoLocal {
  if (!aluno.publicadoEm || aluno.ativoLocal === null) return "sem_publicacao";
  if (!aluno.ativoLocal) return "inativo";
  if (aluno.comDebitoLocal) return "saldo_devedor";
  if (aluno.acessoLivre) return "liberado";
  if (aluno.turmaSemMatricula) return "turma_sem_matricula";
  return dentroDasJanelas(agora, lerJanelas(aluno.janelasAcesso), feriado) ? "liberado" : "fora_do_horario";
}
