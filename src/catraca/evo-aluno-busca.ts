/**
 * Busca de aluno na EVO por nome/documento/idMember, para a tela local de
 * cadastro na catraca. Versão enxuta de
 * apps/web/app/lib/evo-member-membership.server.ts (sem os campos de venda/
 * autorização de pagamento, que são específicos do fluxo de cancelamento).
 */
import { getColaboradorConhecido } from "./colaboradores-conhecidos.js";

const DEFAULT_BASE_URL = "https://evo-integracao-api.w12app.com.br";
const MEMBER_MEMBERSHIP_PATH = "/api/v3/membermembership";
const MEMBERS_PATH = "/api/v2/members";
const DEFAULT_TIMEOUT_MS = 15000;
const STATUS_CONTRATO_ATIVO = 1;

interface MemberMembership {
  idMember?: number | null;
  name?: string | null;
  nameMembership?: string | null;
  membershipStart?: string | null;
  membershipEnd?: string | null;
  statusMemberMembership?: number | null;
}

interface EvoMemberResumo {
  idMember?: number | null;
  name?: string | null;
}

export interface AlunoEvoConsulta {
  encontrado: boolean;
  idMember: number | null;
  nome: string | null;
  plano: string | null;
  tipo: "aluno" | "colaborador";
}

export interface AlunoEvoCandidato {
  idMember: number;
  nome: string;
  planoAtual: string | null;
  statusContrato: "ativo" | "cancelado" | "desconhecido";
}

export interface BuscaAlunoEvoResultado {
  consulta: AlunoEvoConsulta | null;
  candidatos: AlunoEvoCandidato[] | null;
}

function getAuthHeader(): string {
  const apiKey = process.env.EVO_INTEGRACAO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Configure EVO_INTEGRACAO_API_KEY no .env.");
  }
  return apiKey;
}

async function fetchEvoJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json", authorization: getAuthHeader() },
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function onlyDigits(value: string): string {
  return value.replace(/\D/g, "");
}

function isNumericId(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

function isDocumento(value: string): boolean {
  const digits = onlyDigits(value);
  return digits.length === 11 || digits.length === 14;
}

function filtrarContratosAtivos(memberships: MemberMembership[]): MemberMembership[] {
  return memberships.filter((m) => m.statusMemberMembership === STATUS_CONTRATO_ATIVO);
}

function buildMembershipUrl(params: Record<string, string>, somenteAtivos: boolean): string {
  const query = somenteAtivos
    ? { ...params, statusMemberMembership: String(STATUS_CONTRATO_ATIVO) }
    : params;
  const search = new URLSearchParams({ take: "25", skip: "0", ...query });
  return `${DEFAULT_BASE_URL}${MEMBER_MEMBERSHIP_PATH}?${search}`;
}

async function getMembershipsByIdMember(
  idMember: number,
  somenteAtivos: boolean
): Promise<MemberMembership[]> {
  const url = buildMembershipUrl({ idMember: String(idMember) }, somenteAtivos);
  const payload = await fetchEvoJson<MemberMembership[]>(url);
  const memberships = Array.isArray(payload) ? payload : [];
  return somenteAtivos ? filtrarContratosAtivos(memberships) : memberships;
}

async function getMembershipsByName(
  nome: string,
  somenteAtivos: boolean
): Promise<MemberMembership[]> {
  const url = buildMembershipUrl({ memberName: nome }, somenteAtivos);
  const payload = await fetchEvoJson<MemberMembership[]>(url);
  const memberships = Array.isArray(payload) ? payload : [];
  return somenteAtivos ? filtrarContratosAtivos(memberships) : memberships;
}

function buildMembersUrl(params: Record<string, string>): string {
  const search = new URLSearchParams({ take: "25", skip: "0", ...params });
  return `${DEFAULT_BASE_URL}${MEMBERS_PATH}?${search}`;
}

function normalizeMembersPayload(payload: unknown): EvoMemberResumo[] {
  if (Array.isArray(payload)) {
    return payload as EvoMemberResumo[];
  }
  if (payload && typeof payload === "object") {
    const list = (payload as { members?: unknown }).members;
    if (Array.isArray(list)) {
      return list as EvoMemberResumo[];
    }
  }
  return [];
}

async function getMembersByDocument(documento: string): Promise<EvoMemberResumo[]> {
  const payload = await fetchEvoJson<unknown>(buildMembersUrl({ document: onlyDigits(documento) }));
  return normalizeMembersPayload(payload);
}

async function getMembersByName(nome: string): Promise<EvoMemberResumo[]> {
  const payload = await fetchEvoJson<unknown>(buildMembersUrl({ name: nome.trim() }));
  return normalizeMembersPayload(payload);
}

interface MemberPerfil {
  idMember?: number | null;
  firstName?: string | null;
  lastName?: string | null;
}

/**
 * `/api/v2/members` (lista) não tem filtro por idMember — só name/document/etc.
 * Pra buscar um membro específico por id é `/api/v2/members/{idMember}` (path,
 * não query), que devolve o perfil completo mesmo sem nenhum contrato.
 */
async function getMemberPorId(idMember: number): Promise<MemberPerfil | null> {
  return fetchEvoJson<MemberPerfil>(`${DEFAULT_BASE_URL}${MEMBERS_PATH}/${idMember}`);
}

const EMPLOYEES_PATH = "/api/v2/employees";

interface EmployeeResumo {
  idEmployee?: number | null;
  name?: string | null;
  status?: string | null;
}

/**
 * Colaboradores (professores, recepção etc.) usam o mesmo leitor facial mas
 * não são "membros" na EVO — vivem num espaço de id separado (`idEmployee`),
 * com seu próprio endpoint e status ("Ativo"/"Inativo"/"Bloqueado").
 */
async function getFuncionarioPorId(idEmployee: number): Promise<EmployeeResumo | null> {
  const search = new URLSearchParams({ idEmployee: String(idEmployee), take: "1", skip: "0" });
  const payload = await fetchEvoJson<EmployeeResumo[]>(`${DEFAULT_BASE_URL}${EMPLOYEES_PATH}?${search}`);
  return Array.isArray(payload) ? (payload.find((e) => e.idEmployee === idEmployee) ?? null) : null;
}

async function getFuncionariosByName(nome: string): Promise<EmployeeResumo[]> {
  const search = new URLSearchParams({ name: nome.trim(), take: "25", skip: "0" });
  const payload = await fetchEvoJson<EmployeeResumo[]>(`${DEFAULT_BASE_URL}${EMPLOYEES_PATH}?${search}`);
  return Array.isArray(payload) ? payload : [];
}

function pickMembershipPrincipal(memberships: MemberMembership[]): MemberMembership | null {
  const ativos = filtrarContratosAtivos(memberships);
  if (!ativos.length) {
    return null;
  }
  return ativos.sort((a, b) => {
    const dateA = new Date(a.membershipEnd ?? a.membershipStart ?? 0).getTime();
    const dateB = new Date(b.membershipEnd ?? b.membershipStart ?? 0).getTime();
    return dateB - dateA;
  })[0];
}

function extrairCandidatosUnicos(
  memberships: MemberMembership[],
  membros: EvoMemberResumo[]
): AlunoEvoCandidato[] {
  const porId = new Map<number, MemberMembership[]>();
  for (const membership of filtrarContratosAtivos(memberships)) {
    if (typeof membership.idMember !== "number") {
      continue;
    }
    const lista = porId.get(membership.idMember) ?? [];
    lista.push(membership);
    porId.set(membership.idMember, lista);
  }

  const candidatos: AlunoEvoCandidato[] = [];
  for (const [idMember, contratos] of porId.entries()) {
    const principal = pickMembershipPrincipal(contratos);
    if (!principal) {
      continue;
    }
    const nome =
      principal.name ?? membros.find((m) => m.idMember === idMember)?.name ?? `Membro ${idMember}`;
    candidatos.push({
      idMember,
      nome,
      planoAtual: principal.nameMembership ?? null,
      statusContrato: "ativo",
    });
  }

  return candidatos.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" }));
}

async function membershipParaConsulta(membership: MemberMembership | null): Promise<AlunoEvoConsulta> {
  if (!membership) {
    return { encontrado: false, idMember: null, nome: null, plano: null, tipo: "aluno" };
  }
  return {
    encontrado: true,
    idMember: membership.idMember ?? null,
    nome: membership.name ?? null,
    plano: membership.nameMembership ?? null,
    tipo: "aluno",
  };
}

async function consultarAlunoPorIdMember(idMember: number): Promise<AlunoEvoConsulta> {
  const memberships = await getMembershipsByIdMember(idMember, true);
  return membershipParaConsulta(pickMembershipPrincipal(memberships));
}

export interface AlunoEvoNomeStatus {
  idMember: number;
  nome: string | null;
  ativo: boolean;
  tipo: "aluno" | "colaborador";
}

/**
 * Nome + status por idMember/enrollid SEM filtrar só contratos ativos — usado
 * para enriquecer o cadastro importado do dispositivo (queremos o nome mesmo
 * de quem está inativo/cancelado, para exibir na lista).
 *
 * O enrollid do device pode ser tanto um `idMember` (aluno) quanto um
 * `idEmployee` (colaborador — professor, recepção etc.) — os dois usam o
 * mesmo leitor facial mas são espaços de id **separados** na EVO, que podem
 * colidir numericamente mesmo com nomes reais dos dois lados (confirmado:
 * idMember 54 é uma aluna inativa real, idEmployee 54 é um professor ativo
 * real — não dá pra resolver isso só por heurística). Por isso a ordem é:
 *
 * 1. Lista manual de colaboradores conhecidos (`colaboradores-conhecidos.ts`,
 *    fornecida pelo dono da academia) — vence qualquer outra coisa, porque é
 *    o único sinal confiável quando os dois espaços de id colidem.
 * 2. Contrato com nome de verdade (sinal forte de aluno).
 * 3. Se o contrato vier anonimizado (LGPD), tenta funcionário antes de
 *    aceitar o dado anonimizado.
 * 4. Funcionário (fallback quando não há contrato nenhum).
 * 5. Perfil puro de membro sem contrato (último recurso).
 */
const MARCADOR_ANONIMIZADO = "dados removidos";

function pareceAnonimizado(nome: string | null | undefined): boolean {
  return nome?.toLowerCase().includes(MARCADOR_ANONIMIZADO) ?? false;
}

export async function buscarNomeEStatusPorIdMember(idMember: number): Promise<AlunoEvoNomeStatus | null> {
  const colaboradorConhecido = getColaboradorConhecido(idMember);
  if (colaboradorConhecido) {
    return {
      idMember,
      nome: colaboradorConhecido.nome,
      ativo: colaboradorConhecido.status.toLowerCase() === "ativo",
      tipo: "colaborador",
    };
  }

  const memberships = await getMembershipsByIdMember(idMember, false);
  if (memberships.length > 0) {
    const maisRecente = [...memberships].sort((a, b) => {
      const dateA = new Date(a.membershipEnd ?? a.membershipStart ?? 0).getTime();
      const dateB = new Date(b.membershipEnd ?? b.membershipStart ?? 0).getTime();
      return dateB - dateA;
    })[0];
    const nomeContrato = maisRecente.name ?? null;

    if (!pareceAnonimizado(nomeContrato)) {
      return {
        idMember,
        nome: nomeContrato,
        ativo: memberships.some((m) => m.statusMemberMembership === STATUS_CONTRATO_ATIVO),
        tipo: "aluno",
      };
    }

    // Contrato existe mas o nome foi anonimizado (LGPD) — antes de aceitar
    // esse dado "morto", checa se esse id também é um funcionário ativo.
    const funcionarioDoAnonimizado = await getFuncionarioPorId(idMember);
    if (funcionarioDoAnonimizado?.name) {
      return {
        idMember,
        nome: funcionarioDoAnonimizado.name.trim(),
        ativo: funcionarioDoAnonimizado.status === "Ativo",
        tipo: "colaborador",
      };
    }

    return {
      idMember,
      nome: nomeContrato,
      ativo: memberships.some((m) => m.statusMemberMembership === STATUS_CONTRATO_ATIVO),
      tipo: "aluno",
    };
  }

  const funcionario = await getFuncionarioPorId(idMember);
  if (funcionario?.name) {
    return { idMember, nome: funcionario.name.trim(), ativo: funcionario.status === "Ativo", tipo: "colaborador" };
  }

  // Sem contrato e sem cadastro de funcionário — último recurso: perfil puro
  // de membro (existe mesmo sem nenhum membermembership associado).
  const perfil = await getMemberPorId(idMember);
  if (perfil) {
    const nome = [perfil.firstName, perfil.lastName].filter(Boolean).join(" ").trim() || null;
    return { idMember, nome, ativo: false, tipo: "aluno" };
  }

  return null;
}

async function buscarMembershipsPorTermo(
  termo: string
): Promise<{ memberships: MemberMembership[]; membros: EvoMemberResumo[] }> {
  const termoTrimmed = termo.trim();
  if (!termoTrimmed) {
    return { memberships: [], membros: [] };
  }

  if (isNumericId(termoTrimmed)) {
    return { memberships: await getMembershipsByIdMember(Number(termoTrimmed), true), membros: [] };
  }

  if (isDocumento(termoTrimmed)) {
    const membros = await getMembersByDocument(termoTrimmed);
    const idMember = membros[0]?.idMember;
    if (idMember) {
      return { memberships: await getMembershipsByIdMember(idMember, true), membros };
    }
    return { memberships: [], membros };
  }

  const [porNome, membrosPorNome] = await Promise.all([
    getMembershipsByName(termoTrimmed, true),
    getMembersByName(termoTrimmed),
  ]);
  return { memberships: porNome, membros: membrosPorNome };
}

export async function buscarAlunoEvo(
  termo: string,
  idMemberSelecionado?: number
): Promise<BuscaAlunoEvoResultado> {
  if (typeof idMemberSelecionado === "number") {
    return { consulta: await consultarAlunoPorIdMember(idMemberSelecionado), candidatos: null };
  }

  const { memberships, membros } = await buscarMembershipsPorTermo(termo);
  const candidatos = extrairCandidatosUnicos(memberships, membros);

  if (candidatos.length > 1) {
    return { consulta: null, candidatos };
  }
  if (candidatos.length === 1) {
    return { consulta: await consultarAlunoPorIdMember(candidatos[0].idMember), candidatos: null };
  }
  return { consulta: await membershipParaConsulta(null), candidatos: null };
}

function funcionarioParaConsulta(funcionario: EmployeeResumo | null): AlunoEvoConsulta {
  if (!funcionario || typeof funcionario.idEmployee !== "number") {
    return { encontrado: false, idMember: null, nome: null, plano: null, tipo: "colaborador" };
  }
  return {
    encontrado: true,
    idMember: funcionario.idEmployee,
    nome: funcionario.name ?? null,
    plano: funcionario.status ?? null,
    tipo: "colaborador",
  };
}

/**
 * Mesma forma de `buscarAlunoEvo`, mas contra `/api/v2/employees` — espaço de
 * id separado (`idEmployee`), reaproveitado como `idMember`/enrollid no
 * `CatracaAluno` (ver comentário no schema.prisma).
 */
export async function buscarColaboradorEvo(
  termo: string,
  idEmployeeSelecionado?: number
): Promise<BuscaAlunoEvoResultado> {
  if (typeof idEmployeeSelecionado === "number") {
    return { consulta: funcionarioParaConsulta(await getFuncionarioPorId(idEmployeeSelecionado)), candidatos: null };
  }

  const termoTrimmed = termo.trim();
  if (!termoTrimmed) {
    return { consulta: funcionarioParaConsulta(null), candidatos: null };
  }

  const funcionarios = isNumericId(termoTrimmed)
    ? [await getFuncionarioPorId(Number(termoTrimmed))].filter((f): f is EmployeeResumo => f !== null)
    : await getFuncionariosByName(termoTrimmed);

  const candidatosUnicos = funcionarios.filter(
    (f): f is EmployeeResumo & { idEmployee: number; name: string } =>
      typeof f.idEmployee === "number" && typeof f.name === "string"
  );

  if (candidatosUnicos.length > 1) {
    const candidatos: AlunoEvoCandidato[] = candidatosUnicos
      .map((f) => ({
        idMember: f.idEmployee,
        nome: f.name,
        planoAtual: f.status ?? null,
        statusContrato: (f.status?.toLowerCase() === "ativo" ? "ativo" : "desconhecido") as
          | "ativo"
          | "desconhecido",
      }))
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" }));
    return { consulta: null, candidatos };
  }
  if (candidatosUnicos.length === 1) {
    return { consulta: funcionarioParaConsulta(candidatosUnicos[0]), candidatos: null };
  }
  return { consulta: funcionarioParaConsulta(null), candidatos: null };
}
