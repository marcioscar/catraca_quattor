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
  // NÃO rodam sozinhos ainda (custo alto de chamadas à EVO, ver NOTES.md) —
  // disparar manualmente por aqui.
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

    const idMembers = [...new Set(acessos.map((acesso) => acesso.idMember))];
    const alunos = await db.catracaAluno.findMany({
      where: { idMember: { in: idMembers } },
      select: { idMember: true, nome: true, fotoBase64: true },
    });
    const alunoPorIdMember = new Map(alunos.map((aluno) => [aluno.idMember, aluno]));

    // Prefere o nome já enriquecido via EVO; o do sendlog (device) costuma vir vazio.
    return acessos.map((acesso) => ({
      ...acesso,
      nome: alunoPorIdMember.get(acesso.idMember)?.nome ?? acesso.nome,
      fotoBase64: alunoPorIdMember.get(acesso.idMember)?.fotoBase64 ?? null,
    }));
  });

  // Último acesso + dados do aluno (foto, status), para o monitor ao vivo da recepção.
  app.get("/catraca/acessos/ultimo", async () => {
    const ultimo = await db.catracaAcessoLog.findFirst({
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
