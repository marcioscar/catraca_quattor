import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { enrollAluno, removeAluno } from "./enroll-service.js";
import { isConnected, getLastSeenAt, send } from "./connection-manager.js";
import { buscarAlunoEvo, buscarColaboradorEvo } from "./evo-aluno-busca.js";
import { enriquecerNomesEvo, getProgressoEnriquecimento } from "./enriquecer-nomes-evo.js";
import { sincronizarClientesEvo, getProgressoSincronizacaoClientes } from "./evo-clientes-sync.js";
import { NAO_REMOVIDO } from "./filtros.js";
import { PERSON_TYPE_CLIENTE } from "./evo-access-control.js";

interface EnrollBody {
  idMember?: number;
  nome?: string;
  fotoBase64?: string;
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
    const { idMember, nome, fotoBase64, tipo } = request.body;
    if (typeof idMember !== "number" || !nome || !fotoBase64) {
      reply.code(400);
      return { erro: "idMember, nome e fotoBase64 são obrigatórios." };
    }

    const tipoFinal = tipo === "colaborador" ? "colaborador" : "aluno";
    const resultado = await enrollAluno(idMember, nome, fotoBase64, tipoFinal);
    if (!resultado.ok) {
      reply.code(202);
      return { ok: false, motivo: resultado.reason };
    }
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

  app.get("/catraca/acessos", async (request) => {
    const query = request.query as { take?: string };
    const take = Math.min(Number(query.take) || 50, 200);
    const acessos = await db.catracaAcessoLog.findMany({
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
