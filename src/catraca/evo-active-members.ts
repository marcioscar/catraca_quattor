/**
 * Bulk-fetch mínimo de idMembers ativos na EVO, no molde de
 * fetchMembersPage/fetchTodosMembrosAtivos em
 * apps/web/app/lib/evo-retencao.server.ts — duplicado aqui porque apps/api é
 * um processo separado e só precisa da lista de idMembers (nada de busca por
 * nome/documento, que continua só em apps/web).
 */
const DEFAULT_BASE_URL = "https://evo-integracao-api.w12app.com.br";
const MEMBERS_PATH = "/api/v2/members";
const EMPLOYEES_PATH = "/api/v2/employees";
const DEFAULT_TIMEOUT_MS = 20000;
const PAGE_SIZE = 150;
const MAX_PAGES = 30;
const EMPLOYEES_PAGE_SIZE = 100;
const EMPLOYEES_MAX_PAGES = 10;

interface EvoMemberV2 {
  idMember?: number | null;
}

interface EvoEmployeeV2 {
  idEmployee?: number | null;
  status?: string | null;
}

function getAuthHeader(): string {
  const apiKey = process.env.EVO_INTEGRACAO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Configure EVO_INTEGRACAO_API_KEY no .env.");
  }
  return apiKey;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchMembersPage(skip: number, retries = 2): Promise<EvoMemberV2[]> {
  const search = new URLSearchParams({
    status: "1",
    take: String(PAGE_SIZE),
    skip: String(skip),
  });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${DEFAULT_BASE_URL}${MEMBERS_PATH}?${search}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: getAuthHeader(),
      },
      signal: controller.signal,
    });

    if (response.status === 429 && retries > 0) {
      await sleep(600 * (3 - retries));
      return fetchMembersPage(skip, retries - 1);
    }

    if (!response.ok) {
      throw new Error(`Falha na API EVO (members): HTTP ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    return Array.isArray(payload) ? (payload as EvoMemberV2[]) : [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Todos os idMembers com contrato ativo na EVO (status=1). */
export async function fetchIdMembersAtivos(): Promise<Set<number>> {
  const ids = new Set<number>();

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const lote = await fetchMembersPage(page * PAGE_SIZE);
    for (const membro of lote) {
      if (typeof membro.idMember === "number") {
        ids.add(membro.idMember);
      }
    }
    if (lote.length < PAGE_SIZE) {
      break;
    }
  }

  return ids;
}

async function fetchEmployeesPage(skip: number, retries = 2): Promise<EvoEmployeeV2[]> {
  const search = new URLSearchParams({ take: String(EMPLOYEES_PAGE_SIZE), skip: String(skip) });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${DEFAULT_BASE_URL}${EMPLOYEES_PATH}?${search}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: getAuthHeader(),
      },
      signal: controller.signal,
    });

    if (response.status === 429 && retries > 0) {
      await sleep(600 * (3 - retries));
      return fetchEmployeesPage(skip, retries - 1);
    }

    if (!response.ok) {
      throw new Error(`Falha na API EVO (employees): HTTP ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    return Array.isArray(payload) ? (payload as EvoEmployeeV2[]) : [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Todos os idEmployees com status "Ativo" na EVO — colaboradores (professor,
 * recepção etc.) que também passam pelo leitor facial mas não são "membros".
 * `/api/v2/employees` não tem filtro de status na query, então filtra aqui.
 */
export async function fetchIdEmployeesAtivos(): Promise<Set<number>> {
  const ids = new Set<number>();

  for (let page = 0; page < EMPLOYEES_MAX_PAGES; page += 1) {
    const lote = await fetchEmployeesPage(page * EMPLOYEES_PAGE_SIZE);
    for (const funcionario of lote) {
      if (typeof funcionario.idEmployee === "number" && funcionario.status === "Ativo") {
        ids.add(funcionario.idEmployee);
      }
    }
    if (lote.length < EMPLOYEES_PAGE_SIZE) {
      break;
    }
  }

  return ids;
}
