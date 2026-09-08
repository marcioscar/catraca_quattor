/**
 * Restrição de horário pra planos "Hora Certa" e "turma" — ver
 * evo-plano-classificacao.ts pra saber como um aluno é classificado.
 * Em feriado vale a janela única de feriado pra todo plano restrito (a
 * academia abre só das 08:00 às 12:00) — ver feriados.ts.
 * Decisão sempre local (Mongo + cálculo de data), nunca chama a EVO na hora
 * da passagem — ver access-handler.ts.
 */

export interface JanelaHorario {
  inicio: string; // "HH:MM"
  fim: string; // "HH:MM"
}

/**
 * Tabela fixa de "Horários de contrato" do plano Hora Certa — a API da EVO
 * não expõe esse dado (confirmado em 2026-07-15, ver NOTES.md), então foi
 * passada manualmente pelo dono da academia, direto do painel admin. Chave:
 * `Date.getDay()` (0=Domingo...6=Sábado). A linha "Feriado 08:00-12:00" do
 * painel fica em `JANELA_FERIADO` logo abaixo, e substitui o dia da semana
 * quando a data é feriado (ver feriados.ts).
 */
export const HORA_CERTA_JANELAS: Record<number, JanelaHorario[]> = {
  0: [{ inicio: "08:00", fim: "12:00" }], // Domingo
  1: [
    { inicio: "05:00", fim: "07:00" },
    { inicio: "11:00", fim: "16:00" },
    { inicio: "21:00", fim: "23:00" },
  ], // Segunda
  2: [
    { inicio: "05:00", fim: "07:00" },
    { inicio: "11:00", fim: "16:00" },
    { inicio: "21:00", fim: "23:00" },
  ], // Terça
  3: [
    { inicio: "05:00", fim: "07:00" },
    { inicio: "11:00", fim: "16:00" },
    { inicio: "21:00", fim: "23:00" },
  ], // Quarta
  4: [
    { inicio: "05:00", fim: "07:00" },
    { inicio: "11:00", fim: "16:00" },
    { inicio: "21:00", fim: "23:00" },
  ], // Quinta
  5: [
    { inicio: "05:00", fim: "07:00" },
    { inicio: "11:00", fim: "16:00" },
    { inicio: "21:00", fim: "23:00" },
  ], // Sexta
  6: [{ inicio: "08:00", fim: "12:00" }], // Sábado
};

/**
 * Linha "Feriado" da mesma tabela do painel admin da EVO: em feriado a
 * academia abre só das 08:00 às 12:00, e essa janela vale pra **qualquer**
 * plano restrito (Hora Certa ou turma) — a aula não acontece no feriado, mas
 * quem tem plano ativo entra no horário em que a academia está aberta
 * (decisão do dono da academia). Ver `checarHorario` em access-handler.ts.
 */
export const JANELA_FERIADO: JanelaHorario = { inicio: "08:00", fim: "12:00" };

const TOLERANCIA_HORA_CERTA_MIN = 15;
const TOLERANCIA_TURMA_ANTES_MIN = 30;
const TOLERANCIA_TURMA_DEPOIS_MIN = 20;

function paraMinutosDoDia(horaMinuto: string): number {
  const [h, m] = horaMinuto.split(":").map(Number);
  return h * 60 + m;
}

function minutosDoDiaAgora(agora: Date): number {
  return agora.getHours() * 60 + agora.getMinutes();
}

function dentroDeAlgumaJanela(agora: Date, janelas: JanelaHorario[], toleranciaMin: number): boolean {
  const minutosAgora = minutosDoDiaAgora(agora);

  return janelas.some((janela) => {
    const inicio = paraMinutosDoDia(janela.inicio) - toleranciaMin;
    const fim = paraMinutosDoDia(janela.fim) + toleranciaMin;
    return minutosAgora >= inicio && minutosAgora <= fim;
  });
}

export function dentroDoHorarioHoraCerta(agora: Date): boolean {
  return dentroDeAlgumaJanela(agora, HORA_CERTA_JANELAS[agora.getDay()] ?? [], TOLERANCIA_HORA_CERTA_MIN);
}

/** Janela de feriado (08:00-12:00), com a mesma tolerância da Hora Certa. */
export function dentroDoHorarioFeriado(agora: Date): boolean {
  return dentroDeAlgumaJanela(agora, [JANELA_FERIADO], TOLERANCIA_HORA_CERTA_MIN);
}

export interface TurmaHorario {
  weekDay: number; // 0=Domingo...6=Sábado, mesma convenção de Date.getDay() — confirmado contra dado real da EVO
  startTime: string; // "HH:MM:SS" ou "HH:MM"
  endTime: string;
}

export function dentroDoHorarioTurma(agora: Date, turmas: TurmaHorario[]): boolean {
  const minutosAgora = minutosDoDiaAgora(agora);
  const hoje = agora.getDay();

  return turmas.some((turma) => {
    if (turma.weekDay !== hoje) {
      return false;
    }
    const inicio = paraMinutosDoDia(turma.startTime.slice(0, 5)) - TOLERANCIA_TURMA_ANTES_MIN;
    const fim = paraMinutosDoDia(turma.endTime.slice(0, 5)) + TOLERANCIA_TURMA_DEPOIS_MIN;
    return minutosAgora >= inicio && minutosAgora <= fim;
  });
}
