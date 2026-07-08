import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { enrollAluno, removeAluno } from "./enroll-service.js";
import { isConnected, getLastSeenAt, send } from "./connection-manager.js";
import { buscarAlunoEvo } from "./evo-aluno-busca.js";
import { enriquecerNomesEvo, getProgressoEnriquecimento } from "./enriquecer-nomes-evo.js";
import { NAO_REMOVIDO } from "./filtros.js";

interface EnrollBody {
  idMember?: number;
  nome?: string;
  fotoBase64?: string;
}

export async function catracaRoutes(app: FastifyInstance): Promise<void> {
  app.get("/catraca/status", async () => ({
    conectado: isConnected(),
    ultimaVezVisto: getLastSeenAt(),
  }));

  app.get("/catraca/busca", async (request, reply) => {
    const query = request.query as { termo?: string; idMember?: string };
    const termo = query.termo?.trim() ?? "";
    const idMember = query.idMember ? Number(query.idMember) : undefined;

    if (!termo && idMember === undefined) {
      reply.code(400);
      return { erro: "Informe termo ou idMember." };
    }

    try {
      return await buscarAlunoEvo(termo, idMember);
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
        ativo: true,
        enroladoEm: true,
        atualizadoEm: true,
      },
    });
    return alunos;
  });

  app.post<{ Body: EnrollBody }>("/catraca/alunos", async (request, reply) => {
    const { idMember, nome, fotoBase64 } = request.body;
    if (typeof idMember !== "number" || !nome || !fotoBase64) {
      reply.code(400);
      return { erro: "idMember, nome e fotoBase64 são obrigatórios." };
    }

    const resultado = await enrollAluno(idMember, nome, fotoBase64);
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

  app.get("/catraca/acessos", async (request) => {
    const query = request.query as { take?: string };
    const take = Math.min(Number(query.take) || 50, 200);
    return db.catracaAcessoLog.findMany({
      orderBy: { ocorridoEm: "desc" },
      take,
    });
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
      select: { fotoBase64: true, ativo: true },
    });

    return {
      id: ultimo.id,
      idMember: ultimo.idMember,
      nome: ultimo.nome,
      permitido: ultimo.permitido,
      motivo: ultimo.motivo,
      ocorridoEm: ultimo.ocorridoEm,
      fotoBase64: aluno?.fotoBase64 ?? null,
      ativo: aluno?.ativo ?? null,
    };
  });
}
