import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { classificarPessoa, removeAluno } from "./enroll-service.js";
import { isConnected, getLastSeenAt, send } from "./connection-manager.js";
import { buscarAlunoEvo, buscarColaboradorEvo } from "./evo-aluno-busca.js";
import { enriquecerNomesEvo, getProgressoEnriquecimento } from "./enriquecer-nomes-evo.js";
import { sincronizarClientesEvo, getProgressoSincronizacaoClientes } from "./evo-clientes-sync.js";
import { sincronizarPlanosEvo, getProgressoSincronizacaoPlanos } from "./evo-planos-sync.js";
import { sincronizarMembershipsEvo, getProgressoSincronizacaoMembership } from "./evo-membership-sync.js";
import { sincronizarTurmasEvo, getProgressoSincronizacaoTurmas } from "./evo-turma-sync.js";
import { sincronizarHorariosEvo } from "./evo-horarios-sync-job.js";
import { sincronizarDebitosEvo } from "./evo-debito-sync.js";
import { listarCheckinsDoDia, validarCheckinManual } from "./wellhub-checkins.js";
import { NAO_REMOVIDO } from "./filtros.js";
import { PERSON_TYPE_CLIENTE } from "./evo-access-control.js";
import { getUltimasMensagens } from "./debug-log.js";

interface EnrollBody {
  idMember?: number;
  nome?: string;
  tipo?: string;
}

// Segunda-feira 00:00 (hora local) da semana em que a data cai.
function inicioDaSemana(data: Date): Date {
  const inicio = new Date(data);
  inicio.setHours(0, 0, 0, 0);
  inicio.setDate(inicio.getDate() - ((inicio.getDay() + 6) % 7));
  return inicio;
}

function chaveDoDia(data: Date): string {
  return `${data.getFullYear()}-${data.getMonth()}-${data.getDate()}`;
}

// Quantas vezes a pessoa veio na semana (segunda a domingo) em que a data
// cai — conta DIAS distintos com entrada liberada, então várias passagens no
// mesmo dia (inclusive as confirmações tardias da Wellhub) valem uma visita só.
async function contarVisitasNaSemana(idMember: number, data: Date): Promise<number> {
  const inicio = inicioDaSemana(data);
  const fim = new Date(inicio);
  fim.setDate(fim.getDate() + 7);

  const entradas = await db.catracaAcessoLog.findMany({
    where: { idMember, permitido: true, ocorridoEm: { gte: inicio, lt: fim } },
    select: { ocorridoEm: true },
  });
  return new Set(entradas.map((entrada) => chaveDoDia(entrada.ocorridoEm))).size;
}

export async function catracaRoutes(app: FastifyInstance): Promise<void> {
  app.get("/catraca/status", async () => ({
    conectado: isConnected(),
    ultimaVezVisto: getLastSeenAt(),
  }));

  app.get("/catraca/busca", async (request, reply) => {
    const query = request.query as { termo?: string; idMember?: string; tipo?: string };
    const termo = query.termo?.trim() ?? "";
    const idMember = query.idMember ? Number(query.idMember) : undefined;
    const tipo = query.tipo === "colaborador" ? "colaborador" : "aluno";

    if (!termo && idMember === undefined) {
      reply.code(400);
      return { erro: "Informe termo ou idMember." };
    }

    try {
      return tipo === "colaborador"
        ? await buscarColaboradorEvo(termo, idMember)
        : await buscarAlunoEvo(termo, idMember);
    } catch (error) {
      reply.code(502);
      return { erro: error instanceof Error ? error.message : "Falha ao consultar EVO." };
    }
  });

  app.get("/catraca/alunos", async () => {
    const alunos = await db.catracaAluno.findMany({
      where: NAO_REMOVIDO,
      orderBy: { enroladoEm: "desc" },
      select: {
        idMember: true,
        nome: true,
        tipo: true,
        ativo: true,
        enroladoEm: true,
        atualizadoEm: true,
      },
    });
    return alunos;
  });

  app.post<{ Body: EnrollBody }>("/catraca/alunos", async (request, reply) => {
    const { idMember, nome, tipo } = request.body;
    if (typeof idMember !== "number" || !nome) {
      reply.code(400);
      return { erro: "idMember e nome são obrigatórios." };
    }

    const tipoFinal = tipo === "colaborador" ? "colaborador" : "aluno";
    await classificarPessoa(idMember, nome, tipoFinal);
    return { ok: true };
  });

  app.delete<{ Params: { idMember: string } }>(
    "/catraca/alunos/:idMember",
    async (request, reply) => {
      const idMember = Number(request.params.idMember);
      if (!Number.isInteger(idMember)) {
        reply.code(400);
        return { erro: "idMember inválido." };
      }

      const resultado = await removeAluno(idMember);
      if (!resultado.ok) {
        reply.code(202);
        return { ok: false, motivo: resultado.reason };
      }
      return { ok: true };
    }
  );

  // Cadastro manual do gympass_id (Wellhub) do aluno — ainda não tem origem
  // automática, ver NOTES.md. `wellhubId: null` remove o vínculo.
  app.patch<{ Params: { idMember: string }; Body: { wellhubId?: string | null } }>(
    "/catraca/alunos/:idMember/wellhub-id",
    async (request, reply) => {
      const idMember = Number(request.params.idMember);
      if (!Number.isInteger(idMember)) {
        reply.code(400);
        return { erro: "idMember inválido." };
      }
      const { wellhubId } = request.body;
      if (wellhubId !== null && typeof wellhubId !== "string") {
        reply.code(400);
        return { erro: "wellhubId deve ser string ou null." };
      }

      await db.catracaAluno.update({
        where: { idMember },
        data: { wellhubId: wellhubId?.trim() || null },
      });
      return { ok: true };
    }
  );

  // Rota temporária de bring-up: manda um comando cru pro dispositivo pra
  // descobrir o formato real de respostas (resposta chega via log do WS, não
  // no corpo desta rota). Remover depois que o protocolo estiver confirmado.
  app.post<{ Body: Record<string, unknown> }>("/catraca/debug/send", async (request, reply) => {
    const enviado = send(JSON.stringify(request.body));
    if (!enviado) {
      reply.code(202);
      return { ok: false, motivo: "device_offline" };
    }
    return { ok: true };
  });

  // Companheira da rota acima — mostra as últimas mensagens WS trocadas com
  // o device (os dois sentidos), pra depurar sem precisar puxar logs no PC
  // da catraca. Remover junto com /catraca/debug/send.
  app.get("/catraca/debug/log", async () => getUltimasMensagens());

  app.post("/catraca/enriquecer-nomes", async () => {
    enriquecerNomesEvo().catch((error) => console.error("[catraca] erro no enriquecimento:", error));
    return { ok: true };
  });

  app.get("/catraca/enriquecer-nomes", async () => getProgressoEnriquecimento());

  // Importa cadastro completo (CPF, telefone, endereço, gympassId etc.) de
  // GET /api/v2/members (EVO) pra coleção EvoCliente — ver evo-clientes-sync.ts.
  // ?skip=N retoma de onde uma rodada anterior parou (ver GET .../ultimoSkip).
  app.post("/catraca/sincronizar-clientes", async (request) => {
    const query = request.query as { skip?: string };
    const skipInicial = Number(query.skip) || 0;
    sincronizarClientesEvo(skipInicial).catch((error) =>
      console.error("[catraca] erro na sincronização de clientes:", error)
    );
    return { ok: true };
  });

  app.get("/catraca/sincronizar-clientes", async () => getProgressoSincronizacaoClientes());

  // Importa o catálogo de planos de GET /api/v3/membership (EVO) pra coleção
  // EvoPlano — ver evo-planos-sync.ts. Pensando na migração futura pra fora
  // da EVO; NÃO inclui "Horários de contrato" (a API não expõe esse dado).
  app.post("/catraca/sincronizar-planos", async (request) => {
    const query = request.query as { skip?: string };
    const skipInicial = Number(query.skip) || 0;
    sincronizarPlanosEvo(skipInicial).catch((error) =>
      console.error("[catraca] erro na sincronização de planos:", error)
    );
    return { ok: true };
  });

  app.get("/catraca/sincronizar-planos", async () => getProgressoSincronizacaoPlanos());

  // Contratos ativos por aluno (idMembership[]) + horário de turma — usados
  // pra restrição de horário (Hora Certa/turma), ver horario-restricao.ts.
  // Rodam sozinhos 1x por dia de madrugada (evo-horarios-sync-job.ts); as
  // rotas abaixo são pra forçar na hora, quando alguém acabou de ser
  // matriculado numa turma e precisa entrar hoje, sem esperar a madrugada.
  //
  // Os dois na ordem certa (memberships → turmas), que é o que quase sempre
  // se quer — as rotas individuais continuam existindo pra depurar cada etapa.
  app.post("/catraca/sincronizar-horarios", async () => {
    sincronizarHorariosEvo().catch((error) => console.error("[catraca] erro na sincronização de horários:", error));
    return { ok: true };
  });

  app.get("/catraca/sincronizar-horarios", async () => ({
    memberships: getProgressoSincronizacaoMembership(),
    turmas: getProgressoSincronizacaoTurmas(),
  }));

  app.post("/catraca/sincronizar-memberships", async () => {
    sincronizarMembershipsEvo().catch((error) =>
      console.error("[catraca] erro na sincronização de memberships:", error)
    );
    return { ok: true };
  });

  app.get("/catraca/sincronizar-memberships", async () => getProgressoSincronizacaoMembership());

  app.post("/catraca/sincronizar-turmas", async () => {
    sincronizarTurmasEvo().catch((error) => console.error("[catraca] erro na sincronização de turmas:", error));
    return { ok: true };
  });

  app.get("/catraca/sincronizar-turmas", async () => getProgressoSincronizacaoTurmas());

  // Débito vencido em aberto (bloqueia acesso) — roda sozinho a cada 10 min
  // junto do sync de `ativo` (é barato). Rota aqui só pra forçar na hora.
  app.post("/catraca/sincronizar-debitos", async (_request, reply) => {
    try {
      const total = await sincronizarDebitosEvo();
      return { ok: true, comDebito: total };
    } catch (error) {
      reply.code(502);
      return { ok: false, erro: error instanceof Error ? error.message : "falha ao sincronizar débitos" };
    }
  });

  // Check-ins Wellhub do dia (validados na catraca x não validados), pra tela
  // /wellhub.html. Fonte: coleção WellhubCheckin (escrita pelo webhook do
  // recepcao, ver wellhub-checkins.ts).
  app.get("/catraca/wellhub/checkins", async (request) => {
    const query = request.query as { dia?: string };
    return listarCheckinsDoDia(query.dia);
  });

  // Validação manual (recepção confirma quem está na academia mas não passou
  // na catraca) — chama o /validate da Wellhub e loga como wellhub_manual.
  app.post<{ Body: { gympassId?: string } }>("/catraca/wellhub/validar", async (request, reply) => {
    const gympassId = request.body?.gympassId?.trim();
    if (!gympassId) {
      reply.code(400);
      return { ok: false, mensagem: "Informe o gympassId." };
    }
    return validarCheckinManual(gympassId);
  });

  app.get("/catraca/acessos", async (request) => {
    const query = request.query as { take?: string; dia?: string };
    const take = Math.min(Number(query.take) || 50, 500);

    // Filtro opcional por dia (YYYY-MM-DD, hora local do servidor).
    let filtroDia: { ocorridoEm: { gte: Date; lt: Date } } | undefined;
    if (query.dia && /^\d{4}-\d{2}-\d{2}$/.test(query.dia)) {
      const inicio = new Date(`${query.dia}T00:00:00`);
      const fim = new Date(inicio);
      fim.setDate(fim.getDate() + 1);
      if (!Number.isNaN(inicio.getTime())) {
        filtroDia = { ocorridoEm: { gte: inicio, lt: fim } };
      }
    }

    const acessos = await db.catracaAcessoLog.findMany({
      where: filtroDia,
      orderBy: { ocorridoEm: "desc" },
      take,
    });

    if (acessos.length === 0) {
      return [];
    }

    const idMembers = [...new Set(acessos.map((acesso) => acesso.idMember))];
    const alunos = await db.catracaAluno.findMany({
      where: { idMember: { in: idMembers } },
      select: { idMember: true, nome: true, fotoBase64: true },
    });
    const alunoPorIdMember = new Map(alunos.map((aluno) => [aluno.idMember, aluno]));

    // Visitas na semana de cada acesso (mesma contagem de `contarVisitasNaSemana`,
    // mas em lote: uma query só cobrindo a faixa de semanas da lista).
    const semanas = acessos.map((acesso) => inicioDaSemana(acesso.ocorridoEm).getTime());
    const inicioFaixa = new Date(Math.min(...semanas));
    const fimFaixa = new Date(Math.max(...semanas));
    fimFaixa.setDate(fimFaixa.getDate() + 7);

    const entradasDaFaixa = await db.catracaAcessoLog.findMany({
      where: {
        idMember: { in: idMembers },
        permitido: true,
        ocorridoEm: { gte: inicioFaixa, lt: fimFaixa },
      },
      select: { idMember: true, ocorridoEm: true },
    });

    const diasPorMembroSemana = new Map<string, Set<string>>();
    for (const entrada of entradasDaFaixa) {
      const chave = `${entrada.idMember}:${inicioDaSemana(entrada.ocorridoEm).getTime()}`;
      const dias = diasPorMembroSemana.get(chave) ?? new Set<string>();
      dias.add(chaveDoDia(entrada.ocorridoEm));
      diasPorMembroSemana.set(chave, dias);
    }

    // Prefere o nome já enriquecido via EVO; o do sendlog (device) costuma vir vazio.
    return acessos.map((acesso) => ({
      ...acesso,
      nome: alunoPorIdMember.get(acesso.idMember)?.nome ?? acesso.nome,
      fotoBase64: alunoPorIdMember.get(acesso.idMember)?.fotoBase64 ?? null,
      visitasNaSemana:
        diasPorMembroSemana.get(`${acesso.idMember}:${inicioDaSemana(acesso.ocorridoEm).getTime()}`)?.size ?? 0,
    }));
  });

  // Último acesso + dados do aluno (foto, status), para o monitor ao vivo da recepção.
  // Exclui "wellhub_auto": é uma confirmação tardia (job em background, não
  // uma passagem física na hora) — mostrar isso como "acesso ao vivo" no
  // monitor enganaria quem está vendo a tela (ver NOTES.md).
  app.get("/catraca/acessos/ultimo", async () => {
    const ultimo = await db.catracaAcessoLog.findFirst({
      where: { motivo: { not: "wellhub_auto" } },
      orderBy: { ocorridoEm: "desc" },
    });
    if (!ultimo) {
      return null;
    }

    const aluno = await db.catracaAluno.findUnique({
      where: { idMember: ultimo.idMember },
      select: { nome: true, fotoBase64: true, ativo: true },
    });

    return {
      id: ultimo.id,
      idMember: ultimo.idMember,
      // Prefere o nome já enriquecido via EVO; o do sendlog (device) costuma vir vazio.
      nome: aluno?.nome ?? ultimo.nome,
      permitido: ultimo.permitido,
      motivo: ultimo.motivo,
      ocorridoEm: ultimo.ocorridoEm,
      fotoBase64: aluno?.fotoBase64 ?? null,
      ativo: aluno?.ativo ?? null,
      visitasNaSemana: await contarVisitasNaSemana(ultimo.idMember, ultimo.ocorridoEm),
    };
  });

  // Pódio pro monitor: quem mais veio nos ÚLTIMOS 7 DIAS (janela deslizante,
  // não a semana seg–dom). Motivo: numa semana calendário o teto é o número de
  // dias já corridos, então numa quinta dezenas de alunos empatam no máximo
  // (59 na medição que fizemos) e o pódio vira ordem alfabética. Com 7 dias
  // cheios o topo é raro (~1 aluno com 7 dias, ~8 com 6) e o pódio significa
  // algo todo dia. Conta dias distintos com entrada liberada; só alunos —
  // colaboradores batem o rosto todo dia de trabalho e ganhariam sempre.
  app.get("/catraca/ranking-semana", async (request) => {
    const query = request.query as { take?: string };
    const take = Math.min(Number(query.take) || 3, 20);

    const fim = new Date();
    fim.setHours(0, 0, 0, 0);
    fim.setDate(fim.getDate() + 1); // amanhã 00:00, pra incluir o dia de hoje inteiro
    const inicio = new Date(fim);
    inicio.setDate(inicio.getDate() - 7);

    // `personType` filtra a passagem; o `tipo: "aluno"` lá embaixo filtra a
    // pessoa. Os dois são necessários: o enrollid do personal vem de outro
    // espaço de numeração e COLIDE com idMember de aluno (ver NOTES.md), então
    // sem checar o personType da passagem um personal poderia engordar o placar
    // do aluno com quem ele colide. Todos os writers de log já setam
    // personType quando permitido=true (inclusive os da Wellhub, com 1).
    const entradas = await db.catracaAcessoLog.findMany({
      where: {
        permitido: true,
        personType: PERSON_TYPE_CLIENTE,
        ocorridoEm: { gte: inicio, lt: fim },
      },
      select: { idMember: true, ocorridoEm: true },
    });
    // `ate` é o último dia contado (hoje), não o limite exclusivo da query.
    const ate = new Date(fim);
    ate.setDate(ate.getDate() - 1);
    const periodo = { desde: inicio, ate };

    if (entradas.length === 0) {
      return { ...periodo, podio: [] };
    }

    const diasPorMembro = new Map<number, Set<string>>();
    const ultimaEntradaPorMembro = new Map<number, number>();
    for (const entrada of entradas) {
      const dias = diasPorMembro.get(entrada.idMember) ?? new Set<string>();
      dias.add(chaveDoDia(entrada.ocorridoEm));
      diasPorMembro.set(entrada.idMember, dias);

      const quando = entrada.ocorridoEm.getTime();
      if (quando > (ultimaEntradaPorMembro.get(entrada.idMember) ?? 0)) {
        ultimaEntradaPorMembro.set(entrada.idMember, quando);
      }
    }

    // Sem `fotoBase64` nesta primeira query: são centenas de alunos na janela,
    // e puxar a foto de todos são megabytes de base64 à toa (deixava a rota em
    // ~8s). Só o pódio precisa de foto.
    const alunos = await db.catracaAluno.findMany({
      where: { idMember: { in: [...diasPorMembro.keys()] }, tipo: "aluno", ...NAO_REMOVIDO },
      select: { idMember: true, nome: true },
    });

    const podio = alunos
      .map((aluno) => ({
        ...aluno,
        visitas: diasPorMembro.get(aluno.idMember)?.size ?? 0,
        ultimaEntrada: ultimaEntradaPorMembro.get(aluno.idMember) ?? 0,
      }))
      // Empate no número de dias é comum (o teto é 7). Desempata por quem
      // treinou mais recentemente — assim o pódio se mexe durante o dia em vez
      // de virar uma lista alfabética congelada. Nome só como último critério.
      .sort(
        (a, b) =>
          b.visitas - a.visitas ||
          b.ultimaEntrada - a.ultimaEntrada ||
          (a.nome ?? "").localeCompare(b.nome ?? ""),
      )
      .slice(0, take);

    const fotos = await db.catracaAluno.findMany({
      where: { idMember: { in: podio.map((aluno) => aluno.idMember) } },
      select: { idMember: true, fotoBase64: true },
    });
    const fotoPorIdMember = new Map(fotos.map((foto) => [foto.idMember, foto.fotoBase64]));

    return {
      ...periodo,
      podio: podio.map(({ ultimaEntrada: _ultimaEntrada, ...aluno }) => ({
        ...aluno,
        fotoBase64: fotoPorIdMember.get(aluno.idMember) ?? null,
      })),
    };
  });

  // Contador do dia pro monitor — entradas liberadas desde a meia-noite (hora local do servidor).
  app.get("/catraca/acessos/contagem-hoje", async () => {
    const inicioDoDia = new Date();
    inicioDoDia.setHours(0, 0, 0, 0);

    const total = await db.catracaAcessoLog.count({
      where: { ocorridoEm: { gte: inicioDoDia }, permitido: true, personType: PERSON_TYPE_CLIENTE },
    });
    return { total };
  });
}
