import { db } from "../db.js";

/**
 * Importa o cadastro completo de clientes da EVO (`GET /api/v2/members`,
 * paginado) pra uma coleção própria (`EvoCliente`), separada da
 * `CatracaAluno` (que é enxuta, só o necessário pra decisão de acesso).
 *
 * Achado importante: ao contrário de `GET /api/v2/members/{idMember}`
 * (usado em evo-aluno-busca.ts), a lista paginada devolve `gympassId` direto
 * — não precisa mais do relatório de check-in exportado manualmente da EVO
 * pra descobrir o Wellhub ID (ver NOTES.md). Todo cliente com `gympassId`
 * aqui também atualiza `CatracaAluno.wellhubId`, se o aluno já existir.
 */
const DEFAULT_BASE_URL = "https://evo-integracao-api.w12app.com.br";
const MEMBERS_PATH = "/api/v2/members";
const DEFAULT_TIMEOUT_MS = 15000;
const TAKE = 50; // máximo aceito pela EVO
const INTERVALO_MS = 400; // mesmo espaçamento de enriquecer-nomes-evo.ts — rate limit agressivo

interface Progresso {
  rodando: boolean;
  processados: number;
  total: number;
  erros: number;
  ultimoSkip: number; // pra retomar (?skip=N) se a sincronização parar antes do fim
}

const progresso: Progresso = { rodando: false, processados: 0, total: 0, erros: 0, ultimoSkip: 0 };

export function getProgressoSincronizacaoClientes(): Progresso {
  return { ...progresso };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAuthHeader(): string {
  const apiKey = process.env.EVO_INTEGRACAO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Configure EVO_INTEGRACAO_API_KEY no .env.");
  }
  return apiKey;
}

interface EvoContact {
  contactType?: string | null;
  description?: string | null;
}

interface EvoMemberRaw {
  idMember: number;
  firstName?: string | null;
  lastName?: string | null;
  registerName?: string | null;
  registerLastName?: string | null;
  registerDate?: string | null;
  idBranch?: number | null;
  branchName?: string | null;
  accessBlocked?: boolean | null;
  blockedReason?: string | null;
  document?: string | null;
  documentId?: string | null;
  maritalStatus?: string | null;
  gender?: string | null;
  birthDate?: string | null;
  updateDate?: string | null;
  address?: string | null;
  state?: string | null;
  city?: string | null;
  zipCode?: string | null;
  complement?: string | null;
  neighborhood?: string | null;
  accessCardNumber?: string | null;
  number?: string | null;
  totalFitCoins?: number | null;
  membershipStatus?: string | null;
  penalized?: boolean | null;
  status?: string | null;
  contacts?: EvoContact[] | null;
  lastAccessDate?: string | null;
  conversionDate?: string | null;
  idEmployeeConsultant?: number | null;
  nameEmployeeConsultant?: string | null;
  idEmployeeInstructor?: number | null;
  nameEmployeeInstructor?: string | null;
  idEmployeePersonalTrainer?: number | null;
  nameEmployeePersonalTrainer?: string | null;
  photoUrl?: string | null;
  country?: string | null;
  idMemberMigration?: string | null;
  gympassId?: string | null;
  personalTrainer?: boolean | null;
  personalType?: string | null;
  cref?: string | null;
  crefExpirationDate?: string | null;
  codeTotalpass?: string | null;
  userIdGurupass?: string | null;
  clientWithPromotionalRestriction?: boolean | null;
}

function normalizeMembersPayload(payload: unknown): EvoMemberRaw[] {
  if (Array.isArray(payload)) {
    return payload as EvoMemberRaw[];
  }
  if (payload && typeof payload === "object") {
    const list = (payload as { members?: unknown }).members;
    if (Array.isArray(list)) {
      return list as EvoMemberRaw[];
    }
  }
  return [];
}

async function buscarPaginaClientes(skip: number): Promise<EvoMemberRaw[]> {
  const search = new URLSearchParams({
    take: String(TAKE),
    skip: String(skip),
    showMemberships: "true", // necessário pra `status` vir corretamente (ver doc da EVO)
  });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${DEFAULT_BASE_URL}${MEMBERS_PATH}?${search}`, {
      method: "GET",
      headers: { accept: "application/json", authorization: getAuthHeader() },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`EVO respondeu ${response.status} em skip=${skip}`);
    }
    return normalizeMembersPayload(await response.json());
  } finally {
    clearTimeout(timeoutId);
  }
}

function extrairContato(contacts: EvoContact[] | null | undefined, tipo: string): string | null {
  return contacts?.find((c) => c.contactType === tipo)?.description ?? null;
}

function parseData(valor: string | null | undefined): Date | undefined {
  if (!valor) return undefined;
  const data = new Date(valor);
  return Number.isNaN(data.getTime()) ? undefined : data;
}

async function upsertCliente(raw: EvoMemberRaw): Promise<void> {
  const data = {
    firstName: raw.firstName ?? null,
    lastName: raw.lastName ?? null,
    registerName: raw.registerName ?? null,
    registerLastName: raw.registerLastName ?? null,
    registerDate: parseData(raw.registerDate),
    idBranch: raw.idBranch ?? null,
    branchName: raw.branchName ?? null,
    accessBlocked: raw.accessBlocked ?? null,
    blockedReason: raw.blockedReason ?? null,
    document: raw.document ?? null,
    documentId: raw.documentId ?? null,
    maritalStatus: raw.maritalStatus ?? null,
    gender: raw.gender ?? null,
    birthDate: parseData(raw.birthDate),
    updateDateEvo: parseData(raw.updateDate),
    address: raw.address ?? null,
    state: raw.state ?? null,
    city: raw.city ?? null,
    zipCode: raw.zipCode ?? null,
    complement: raw.complement ?? null,
    neighborhood: raw.neighborhood ?? null,
    accessCardNumber: raw.accessCardNumber ?? null,
    number: raw.number ?? null,
    totalFitCoins: raw.totalFitCoins ?? null,
    membershipStatus: raw.membershipStatus ?? null,
    penalized: raw.penalized ?? null,
    status: raw.status ?? null,
    email: extrairContato(raw.contacts, "E-mail"),
    telefone: extrairContato(raw.contacts, "Cellphone"),
    lastAccessDate: parseData(raw.lastAccessDate),
    conversionDate: parseData(raw.conversionDate),
    idEmployeeConsultant: raw.idEmployeeConsultant ?? null,
    nameEmployeeConsultant: raw.nameEmployeeConsultant ?? null,
    idEmployeeInstructor: raw.idEmployeeInstructor ?? null,
    nameEmployeeInstructor: raw.nameEmployeeInstructor ?? null,
    idEmployeePersonalTrainer: raw.idEmployeePersonalTrainer ?? null,
    nameEmployeePersonalTrainer: raw.nameEmployeePersonalTrainer ?? null,
    photoUrl: raw.photoUrl ?? null,
    country: raw.country ?? null,
    idMemberMigration: raw.idMemberMigration ?? null,
    gympassId: raw.gympassId ?? null,
    personalTrainer: raw.personalTrainer ?? null,
    personalType: raw.personalType ?? null,
    cref: raw.cref ?? null,
    crefExpirationDate: parseData(raw.crefExpirationDate),
    codeTotalpass: raw.codeTotalpass ?? null,
    userIdGurupass: raw.userIdGurupass ?? null,
    clientWithPromotionalRestriction: raw.clientWithPromotionalRestriction ?? null,
    raw: raw as object,
  };

  await db.evoCliente.upsert({
    where: { idMember: raw.idMember },
    create: { idMember: raw.idMember, ...data },
    update: data,
  });

  if (raw.gympassId) {
    const aluno = await db.catracaAluno.findUnique({ where: { idMember: raw.idMember } });
    if (aluno && aluno.wellhubId !== raw.gympassId) {
      await db.catracaAluno.update({ where: { idMember: raw.idMember }, data: { wellhubId: raw.gympassId } });
    }
  }
}

const MAX_TENTATIVAS_POR_PAGINA = 3;
const MAX_FALHAS_CONSECUTIVAS = 5; // desiste de vez só se a EVO ficar fora por várias páginas seguidas

/** Busca uma página com algumas tentativas (a EVO tem rate limit agressivo, ver NOTES.md). */
async function buscarPaginaComRetentativa(skip: number): Promise<EvoMemberRaw[] | null> {
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_POR_PAGINA; tentativa++) {
    try {
      return await buscarPaginaClientes(skip);
    } catch (error) {
      console.error(`[catraca] erro ao buscar página de clientes (skip=${skip}, tentativa=${tentativa}):`, error);
      if (tentativa < MAX_TENTATIVAS_POR_PAGINA) {
        await sleep(INTERVALO_MS * tentativa * 2);
      }
    }
  }
  return null;
}

/**
 * Pagina `GET /api/v2/members` até a página vir vazia/menor que TAKE. Uma
 * falha isolada de página (rede/rate limit) não aborta a sincronização —
 * tenta de novo, e se continuar falhando pula pra próxima página. Só desiste
 * de vez depois de várias páginas seguidas falhando.
 *
 * `skipInicial` permite retomar de onde uma rodada anterior parou, sem
 * reprocessar tudo de novo (o upsert é idempotente, mas evita gastar tempo
 * à toa com o rate limit da EVO).
 */
export async function sincronizarClientesEvo(skipInicial = 0): Promise<void> {
  if (progresso.rodando) {
    return;
  }
  progresso.rodando = true;
  progresso.processados = 0;
  progresso.total = 0;
  progresso.erros = 0;

  try {
    let skip = skipInicial;
    let falhasConsecutivas = 0;
    for (;;) {
      progresso.ultimoSkip = skip;
      const pagina = await buscarPaginaComRetentativa(skip);
      if (pagina === null) {
        progresso.erros += 1;
        falhasConsecutivas += 1;
        if (falhasConsecutivas >= MAX_FALHAS_CONSECUTIVAS) {
          console.error(`[catraca] desistindo da sincronização — ${MAX_FALHAS_CONSECUTIVAS} páginas seguidas falharam (parou em skip=${skip})`);
          break;
        }
        skip += TAKE;
        await sleep(INTERVALO_MS);
        continue;
      }
      falhasConsecutivas = 0;

      if (pagina.length === 0) {
        break;
      }
      progresso.total += pagina.length;

      for (const cliente of pagina) {
        try {
          await upsertCliente(cliente);
        } catch (error) {
          progresso.erros += 1;
          console.error(`[catraca] erro ao gravar cliente idMember=${cliente.idMember}:`, error);
        }
        progresso.processados += 1;
      }

      if (pagina.length < TAKE) {
        break;
      }
      skip += TAKE;
      await sleep(INTERVALO_MS);
    }
  } finally {
    progresso.rodando = false;
  }
}

const INTERVALO_SYNC_CLIENTES_MS = 24 * 60 * 60 * 1000;

/**
 * Roda `sincronizarClientesEvo` sozinho 1x por dia — é o único jeito
 * automático de manter `CatracaAluno.wellhubId` em dia (backfill via
 * `gympassId`, ver comentário no topo do arquivo), sem isso alunos que
 * vincularam o Wellhub depois da última sincronização manual aparecem como
 * "não cadastrado" na tela de check-ins até alguém notar e rodar na mão.
 *
 * Cadência diária (não a cada 10min como os outros syncs) porque é uma
 * varredura completa da base de clientes (~444 páginas) — mais pesado que os
 * outros jobs automáticos, mas ainda uma fração do custo dos syncs de
 * horário (600-1500 chamadas cada, esses sim mantidos manuais por incerteza
 * sobre o limite diário da chave da EVO, ver NOTES.md).
 */
export function startEvoClientesSyncJob(intervalMs = INTERVALO_SYNC_CLIENTES_MS): void {
  sincronizarClientesEvo().catch((error) => console.error("[catraca] erro na sincronização de clientes:", error));
  setInterval(() => {
    sincronizarClientesEvo().catch((error) => console.error("[catraca] erro na sincronização de clientes:", error));
  }, intervalMs);
}
