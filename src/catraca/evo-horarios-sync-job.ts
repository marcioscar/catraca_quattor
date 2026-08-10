import { sincronizarMembershipsEvo } from "./evo-membership-sync.js";
import { sincronizarTurmasEvo } from "./evo-turma-sync.js";

/**
 * Roda os dois syncs de restrição de horário 1x por dia, de madrugada.
 *
 * Até 2026-08-10 eles só rodavam manualmente (POST /catraca/sincronizar-
 * memberships e /sincronizar-turmas), por incerteza sobre o limite diário da
 * chave da EVO. Consequência real: matrícula de turma nova ou remanejada só
 * valia na catraca depois que alguém lembrasse de disparar na mão — o cache
 * `turmaHorarios` da base inteira ficou parado em 2026-07-16 e alunos
 * matriculados depois disso apanhavam `fora_do_horario` no horário certo da
 * aula deles (casos DAVI 20361 e MAYA 24356).
 *
 * Cadência diária (e não 10 min como os syncs baratos) porque juntos são
 * ~600-1500 chamadas à EVO por rodada, com 429 real já observado — o
 * espaçamento e o backoff ficam por conta de cada sync. Madrugada porque a
 * academia está fechada: nenhuma passagem concorre com a rajada, e o dado
 * fica fresco justamente pro início do dia.
 */
const HORA_PADRAO = 3; // 03:00, hora local do PC da catraca

/** Milissegundos até a próxima ocorrência de `hora`:00 no horário local. */
export function msAteProximaHora(hora: number, agora = new Date()): number {
  const alvo = new Date(agora);
  alvo.setHours(hora, 0, 0, 0);
  if (alvo.getTime() <= agora.getTime()) {
    alvo.setDate(alvo.getDate() + 1);
  }
  return alvo.getTime() - agora.getTime();
}

/**
 * Sequencial de propósito: `evo-turma-sync` decide quem é "turma" lendo o
 * `idMembershipsAtivos` gravado pelo `evo-membership-sync` — rodar os dois em
 * paralelo classificaria todo mundo pelo dado da rodada anterior.
 */
export async function sincronizarHorariosEvo(): Promise<void> {
  await sincronizarMembershipsEvo();
  await sincronizarTurmasEvo();
}

/**
 * Reagenda com `setTimeout` a cada rodada em vez de usar `setInterval` de
 * 24h: assim o horário não escorrega quando a rodada demora (são minutos de
 * chamadas espaçadas) nem quando o relógio muda de horário de verão.
 */
export function startEvoHorariosSyncJob(hora = HORA_PADRAO): void {
  const agendar = () => {
    const espera = msAteProximaHora(hora);
    console.log(`[catraca] sync de horários agendado pra daqui ${Math.round(espera / 60000)} min`);
    setTimeout(() => {
      sincronizarHorariosEvo()
        .catch((error) => console.error("[catraca] erro no sync de horários:", error))
        .finally(agendar);
    }, espera);
  };

  agendar();
}
