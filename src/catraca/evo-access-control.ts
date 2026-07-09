/**
 * Autorização de entrada em tempo real via EVO (`/api/v2/accessControl/entryAuthorize`).
 *
 * A EVO já integra Wellhub (Gympass) e Totalpass por trás desse endpoint —
 * um aluno pode estar "inativo" no nosso cache local (sem contrato direto na
 * EVO) mas ainda assim ter feito check-in via Wellhub minutos antes, o que só
 * esse endpoint sabe validar (checagem depende de horário do check-in, não
 * dá pra cachear como o `ativo` normal). Por isso só chamamos isso como
 * fallback, quando a decisão local já deu negado — pra não pagar latência de
 * rede em toda passagem (ver `decidirAcesso` em access-handler.ts).
 */
const DEFAULT_BASE_URL = "https://evo-integracao-api.w12app.com.br";
const ENTRY_AUTHORIZE_PATH = "/api/v2/accessControl/entryAuthorize";
const DEFAULT_TIMEOUT_MS = 8000;

const DEVICE_FACIAL = 3;

export const PERSON_TYPE_CLIENTE = 1;
export const PERSON_TYPE_COLABORADOR = 3;

interface EntryAuthorizeResponse {
  authorized?: boolean;
  message?: string;
  blockedtype?: number;
}

function getAuthHeader(): string {
  const apiKey = process.env.EVO_INTEGRACAO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Configure EVO_INTEGRACAO_API_KEY no .env.");
  }
  return apiKey;
}

function getIdTurnstile(): number | null {
  const raw = process.env.EVO_ID_TURNSTILE_FACIAL?.trim();
  const id = raw ? Number(raw) : NaN;
  return Number.isInteger(id) ? id : null;
}

export interface AutorizacaoEvo {
  autorizado: boolean;
  mensagem: string | null;
}

/**
 * Retorna `null` (não `autorizado: false`) em qualquer falha de rede/config —
 * quem chama deve tratar `null` como "não deu pra confirmar", mantendo a
 * decisão local original em vez de negar por causa de uma falha nossa.
 */
export async function autorizarEntradaEvo(
  idMember: number,
  personType: typeof PERSON_TYPE_CLIENTE | typeof PERSON_TYPE_COLABORADOR
): Promise<AutorizacaoEvo | null> {
  const idTurnstile = getIdTurnstile();
  if (idTurnstile === null) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${DEFAULT_BASE_URL}${ENTRY_AUTHORIZE_PATH}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: getAuthHeader(),
      },
      body: JSON.stringify({
        id: idMember,
        personType,
        device: DEVICE_FACIAL,
        idTurnstile,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as EntryAuthorizeResponse;
    return { autorizado: payload.authorized === true, mensagem: payload.message ?? null };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
