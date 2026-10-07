import { db } from "../db.js";
import { autorizarEntradaEvo, PERSON_TYPE_CLIENTE, PERSON_TYPE_COLABORADOR } from "./evo-access-control.js";
import { jaValidadoNaWellhub, validarCheckInWellhub, wellhubConfigurado } from "./wellhub-access-control.js";
import { checkinDeHoje, checkinValidadoHoje, passagemWellhubRecente } from "./wellhub-checkins.js";
import { classificarPlanosAtivos } from "./evo-plano-classificacao.js";
import { dentroDoHorarioFeriado, dentroDoHorarioHoraCerta, dentroDoHorarioTurma, type TurmaHorario } from "./horario-restricao.js";
import { ehFeriado } from "./feriados.js";
import { getPersonalPorEnrollid, PERSON_TYPE_PERSONAL } from "./personal.js";
import { decidirPeloRecepcao, fonteAcesso, type DecisaoLocal } from "./fonte-acesso.js";
import type { SendLogMessage, SendLogRecord } from "./protocol.js";

export interface AccessDecision {
  enrollid: number;
  access: boolean;
  motivo:
    | "ok"
    | "plano_inativo"
    | "nao_cadastrado"
    | "wellhub_provisorio"
    | "wellhub_ok"
    | "fora_do_horario"
    | "dia_nao_permitido"
    | "saldo_devedor"
    | "personal_vencido"
    | "turma_sem_matricula"
    | "wellhub_sem_checkin";
  /** Só presente quando access=true — gravado no log pra sincronizar com a EVO depois (ver NOTES.md). */
  personType?: number;
}

type ResultadoHorario = "liberado" | "fora_do_horario" | "turma_sem_matricula";

/**
 * Checa restrição de horário (Hora Certa / turma) — só pra "aluno", nunca
 * pra colaborador. Sempre local (classificação via `EvoPlano` já
 * sincronizado + cálculo de data), nunca chama a EVO nesse caminho. Ver
 * horario-restricao.ts e evo-plano-classificacao.ts.
 *
 * Cada plano ativo abre a janela dele, e **basta uma bater** pra liberar: quem
 * tem "HORA CERTA" + um plano de turma entra na janela da Hora Certa e também
 * na aula, não na interseção das duas (que costuma ser vazia — a aula quase
 * sempre cai fora da janela da Hora Certa, e o aluno apanhava na porta).
 *
 * Classificado "turma" mas SEM nenhuma matrícula de turma sincronizada
 * (`turmaHorarios` vazio) é um caso à parte: não é "fora do horário", é
 * ausência de cadastro na EVO (aluno tem o plano mas ninguém marcou o
 * horário de aula dele) — decisão do dono da academia (2026-07-21): libera
 * em vez de travar por um problema de cadastro que não é culpa do aluno.
 *
 * Em **feriado** a janela do dia da semana não vale pra ninguém: a academia
 * abre só das 08:00 às 12:00 e qualquer plano ativo entra nessa janela (não
 * tem aula de turma no feriado, e a Hora Certa segue a linha "Feriado" da
 * tabela do painel — ver feriados.ts e horario-restricao.ts).
 */
async function checarHorario(aluno: { idMembershipsAtivos: number[]; turmaHorarios: unknown }): Promise<ResultadoHorario> {
  const classificacoes = await classificarPlanosAtivos(aluno.idMembershipsAtivos);
  if (classificacoes.includes("livre")) {
    return "liberado";
  }

  const agora = new Date();
  const turmas = Array.isArray(aluno.turmaHorarios) ? (aluno.turmaHorarios as TurmaHorario[]) : [];

  // Antes do feriado: quem está sem matrícula nenhuma continua liberado em
  // qualquer dia/hora, feriado ou não — o motivo pra liberar é a falha de
  // cadastro, que independe do calendário.
  if (classificacoes.includes("turma") && turmas.length === 0) {
    return "turma_sem_matricula";
  }

  if (ehFeriado(agora)) {
    return dentroDoHorarioFeriado(agora) ? "liberado" : "fora_do_horario";
  }

  if (classificacoes.includes("horaCerta") && dentroDoHorarioHoraCerta(agora)) {
    return "liberado";
  }

  if (classificacoes.includes("turma") && dentroDoHorarioTurma(agora, turmas)) {
    return "liberado";
  }

  return "fora_do_horario";
}

/** Registros mais antigos que isso são backlog acumulado (reader ficou
 * offline), não uma passagem em tempo real — não gravamos no log de acessos
 * pra não inflar o histórico com dados antigos a cada reconexão. */
const HISTORICO_LIMITE_MS = 10 * 60 * 1000;

export function isHistorico(record: SendLogRecord): boolean {
  if (!record.time) {
    return false;
  }
  const registradoEm = new Date(record.time.replace(" ", "T")).getTime();
  return Number.isFinite(registradoEm) && Date.now() - registradoEm > HISTORICO_LIMITE_MS;
}

/**
 * Tenta liberar pela Wellhub — devolve o motivo da liberação ou `null` quando
 * a Wellhub não autoriza. Vale tanto pra quem está inativo na EVO (só
 * Wellhub) quanto pra quem tem contrato ativo mas esbarrou numa restrição do
 * plano: o acesso Wellhub é pago à parte e não depende do contrato da EVO.
 *
 * Enquanto as credenciais da Wellhub não estiverem configuradas
 * (`wellhubConfigurado() === false`), libera provisoriamente só por ter
 * `wellhubId` cadastrado, sem confirmar o check-in de verdade (ver NOTES.md).
 *
 * Reentrada no mesmo dia (ex.: foi no carro pegar algo e voltou, ou volta à
 * noite depois de já ter validado de manhã) não chama a Wellhub de novo — o
 * check-in é de uso único e uma segunda tentativa de /validate falharia mesmo
 * com a pessoa presente.
 *
 * Desde 29/09/2026 o recepcao valida o check-in assim que ele chega do app
 * (`WellhubCheckin.validadoEm`): a porta libera na hora, sem chamada externa.
 * A chamada ao vivo fica para quando o recepcao não validou (fora do ar,
 * validação desligada). Se ela responder "already validated" e houver
 * check-in de hoje desse token, é a corrida com o recepcao — libera também.
 */
async function tentarLiberarPelaWellhub(
  enrollid: number,
  wellhubId: string
): Promise<"wellhub_ok" | "wellhub_provisorio" | null> {
  if (!wellhubConfigurado()) {
    return "wellhub_provisorio";
  }
  if (await passagemWellhubRecente(enrollid)) {
    return "wellhub_ok";
  }
  if (await checkinValidadoHoje(wellhubId)) {
    return "wellhub_ok";
  }
  const autorizacao = await validarCheckInWellhub(wellhubId);
  if (autorizacao?.autorizado) {
    return "wellhub_ok";
  }
  if (autorizacao && jaValidadoNaWellhub(autorizacao.mensagem) && (await checkinDeHoje(wellhubId))) {
    return "wellhub_ok";
  }
  return null;
}

/**
 * Decide liberar/negar com base só no Mongo local — nunca chama serviço
 * externo aqui pro caminho normal, já que essa decisão precisa ser
 * instantânea a cada passagem na catraca. Única exceção: quando o cache
 * local diz "inativo", confirma em tempo real antes de negar — é o único
 * jeito de pegar um check-in Wellhub/Totalpass feito minutos antes (não dá
 * pra cachear isso como o `ativo` normal, sincronizado a cada 10 min).
 *
 * Se o aluno tem `wellhubId` cadastrado, valida direto na API da Wellhub
 * (independente da EVO, ver `tentarLiberarPelaWellhub` logo acima).
 */
async function decidirAcesso(enrollid: number): Promise<AccessDecision> {
  // Personal trainer é decidido ANTES do CatracaAluno: o enrollid dele
  // (Carteirinha/`evoPersonalId`) colide com member/employee de outra pessoa,
  // então o registro em CatracaAluno pode estar com o nome/status errado (ex.:
  // enrollid 119 = personal Italo, mas CatracaAluno 119 foi enriquecido como
  // "Maiara", employee inativa). A coleção `Personal` é a fonte autoritativa.
  const personal = await getPersonalPorEnrollid(enrollid);
  if (personal) {
    return {
      enrollid,
      access: personal.valido,
      motivo: personal.valido ? "ok" : "personal_vencido",
      personType: PERSON_TYPE_PERSONAL,
    };
  }

  const aluno = await db.catracaAluno.findUnique({ where: { idMember: enrollid } });

  if (!aluno) {
    return { enrollid, access: false, motivo: "nao_cadastrado" };
  }

  const personType = aluno.tipo === "colaborador" ? PERSON_TYPE_COLABORADOR : PERSON_TYPE_CLIENTE;

  // F2: aluno decidido pelos campos que o recepcao publica. Colaborador segue
  // no `ativo` de sempre (os da EVO pela lista de funcionários; os nascidos no
  // recepcao já entram com ativo=true e a F0 tira dos syncs).
  if (aluno.tipo === "aluno") {
    const agora = new Date();
    const local = decidirPeloRecepcao(aluno, agora, ehFeriado(agora));
    if (fonteAcesso(process.env.CATRACA_FONTE_ACESSO) === "recepcao" && local !== "sem_publicacao") {
      return decidirComRecepcao(enrollid, aluno.wellhubId, local, personType);
    }
    // Modo sombra: a porta segue a EVO, e a divergência vai pro log do
    // serviço pra conferir antes de virar a flag.
    const pelaEvo = await decidirPelaEvo(enrollid, aluno, personType);
    const localLibera = local === "liberado" || local === "turma_sem_matricula";
    const viaWellhub = pelaEvo.motivo === "wellhub_ok" || pelaEvo.motivo === "wellhub_provisorio";
    if (local !== "sem_publicacao" && !viaWellhub && localLibera !== pelaEvo.access) {
      console.info("[fonte-acesso] divergência", { enrollid, evo: pelaEvo.motivo, recepcao: local });
    }
    return pelaEvo;
  }

  return decidirPelaEvo(enrollid, aluno, personType);
}

/**
 * Decisão pelos campos-sombra do recepcao (`CATRACA_FONTE_ACESSO=recepcao`).
 * A Wellhub entra por cima de "inativo" e de "fora do horário", igual ao
 * caminho da EVO. Não consulta a EVO em tempo real: depois da virada ela não
 * sabe das vendas e renovações feitas no recepcao.
 */
async function decidirComRecepcao(
  enrollid: number,
  wellhubId: string | null,
  local: Exclude<DecisaoLocal, "sem_publicacao">,
  personType: number
): Promise<AccessDecision> {
  if (local === "liberado") return { enrollid, access: true, motivo: "ok", personType };
  if (local === "turma_sem_matricula") return { enrollid, access: true, motivo: "turma_sem_matricula", personType };
  if (local === "saldo_devedor") return { enrollid, access: false, motivo: "saldo_devedor", personType };

  const motivoWellhub = wellhubId ? await tentarLiberarPelaWellhub(enrollid, wellhubId) : null;
  if (motivoWellhub) return { enrollid, access: true, motivo: motivoWellhub, personType };

  if (local === "fora_do_horario" || local === "dia_nao_permitido") {
    return { enrollid, access: false, motivo: local, personType };
  }
  if (wellhubId) return { enrollid, access: false, motivo: "wellhub_sem_checkin" };
  return { enrollid, access: false, motivo: "plano_inativo" };
}

type CatracaAlunoDoc = NonNullable<Awaited<ReturnType<typeof db.catracaAluno.findUnique>>>;

/** A decisão de sempre, pelos campos que os jobs da EVO escrevem. */
async function decidirPelaEvo(
  enrollid: number,
  aluno: CatracaAlunoDoc,
  personType: Parameters<typeof autorizarEntradaEvo>[1]
): Promise<AccessDecision> {
  if (aluno.ativo) {
    // Débito vencido em aberto trava mesmo o aluno ativo (regra: qualquer
    // atraso, ver NOTES.md). Só pra "aluno" — colaborador não tem débito de
    // mensalidade, e o flag nunca é setado pra ele.
    if (aluno.tipo === "aluno" && aluno.comDebito) {
      return { enrollid, access: false, motivo: "saldo_devedor", personType };
    }
    if (aluno.tipo === "aluno") {
      const resultadoHorario = await checarHorario(aluno);
      if (resultadoHorario === "fora_do_horario") {
        // Fora da janela do plano da EVO, mas quem também é Wellhub tem
        // direito a entrar pelo check-in do app: o plano de turma (pilates,
        // judô...) restringe a aula, não o acesso Wellhub, que é pago à
        // parte. Sem isso, quem tinha contrato ativo de outra modalidade
        // nunca chegava no caminho Wellhub (que só rodava pra `ativo=false`)
        // e apanhava na porta fora do horário da aula.
        const motivoWellhub = aluno.wellhubId ? await tentarLiberarPelaWellhub(enrollid, aluno.wellhubId) : null;
        if (motivoWellhub) {
          return { enrollid, access: true, motivo: motivoWellhub, personType };
        }
        return { enrollid, access: false, motivo: "fora_do_horario", personType };
      }
      if (resultadoHorario === "turma_sem_matricula") {
        return { enrollid, access: true, motivo: "turma_sem_matricula", personType };
      }
    }
    return { enrollid, access: true, motivo: "ok", personType };
  }

  if (aluno.wellhubId) {
    const motivoWellhub = await tentarLiberarPelaWellhub(enrollid, aluno.wellhubId);
    if (motivoWellhub) {
      return { enrollid, access: true, motivo: motivoWellhub, personType };
    }
  }

  const autorizacao = await autorizarEntradaEvo(enrollid, personType);
  if (autorizacao?.autorizado) {
    return { enrollid, access: true, motivo: "ok", personType };
  }

  // Tem wellhubId cadastrado mas nem a Wellhub nem a EVO autorizaram — o
  // motivo mais provável é que ele não fez check-in no app ainda, não que o
  // "plano" em si tenha algum problema (ele não tem plano na EVO, só Wellhub).
  // Mensagem específica pra recepção não confundir com plano vencido/cancelado.
  if (aluno.wellhubId) {
    return { enrollid, access: false, motivo: "wellhub_sem_checkin" };
  }

  return { enrollid, access: false, motivo: "plano_inativo" };
}

/** Processa um lote de sendlog (pode ter 1 evento em tempo real ou vários de backlog). */
export async function handleSendLog(message: SendLogMessage): Promise<AccessDecision[]> {
  const decisoes: AccessDecision[] = [];

  for (const record of message.record) {
    const decisao = await decidirAcesso(record.enrollid);
    decisoes.push(decisao);

    if (isHistorico(record)) {
      continue;
    }

    await db.catracaAcessoLog.create({
      data: {
        idMember: record.enrollid,
        nome: record.name ?? null,
        permitido: decisao.access,
        motivo: decisao.motivo,
        personType: decisao.personType ?? null,
      },
    });
  }

  return decisoes;
}
