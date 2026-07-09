/**
 * Validação de check-in via Access Control API da Wellhub (Gympass), direto
 * com eles — sem passar pela EVO. Objetivo: independência futura da EVO (o
 * `entryAuthorize` dela está bloqueado por permissão, ver
 * `evo-access-control.ts`/NOTES.md, e o dono da academia não quer depender
 * mais da EVO de qualquer forma).
 *
 * Modelo usado: "Gate System Trigger" — a facial já decide fisicamente quem
 * passa, então só confirmamos o check-in feito no app quando o aluno está
 * "inativo" no nosso cache local (mesmo esquema do fallback EVO). Um
 * check-in expira 30min depois de criado no app.
 *
 * Credenciais (`WELLHUB_ACCESS_TOKEN`/`WELLHUB_GYM_ID`) obtidas com o time de
 * Tech Sales da Wellhub (integrations@gympass.com) — ainda não solicitadas
 * nesta academia.
 */
const DEFAULT_BASE_URL = "https://api.partners.gympass.com";
const VALIDATE_PATH = "/access/v1/validate";
const DEFAULT_TIMEOUT_MS = 8000;

interface ValidateErrorResponse {
  message?: string;
  error?: string;
}

export interface AutorizacaoWellhub {
  autorizado: boolean;
  mensagem: string | null;
}

function getConfig(): { token: string; gymId: string; baseUrl: string } | null {
  const token = process.env.WELLHUB_ACCESS_TOKEN?.trim();
  const gymId = process.env.WELLHUB_GYM_ID?.trim();
  if (!token || !gymId) {
    return null;
  }
  const baseUrl = process.env.WELLHUB_BASE_URL?.trim() || DEFAULT_BASE_URL;
  return { token, gymId, baseUrl };
}

/**
 * `false` enquanto `WELLHUB_ACCESS_TOKEN`/`WELLHUB_GYM_ID` não forem
 * configurados — usado por `access-handler.ts` pra decidir entre validar o
 * check-in de verdade ou liberar provisoriamente só por ter `wellhubId`
 * cadastrado (ver NOTES.md, seção "Wellhub direto").
 */
export function wellhubConfigurado(): boolean {
  return getConfig() !== null;
}

/**
 * Retorna `null` (não `autorizado: false`) quando as credenciais ainda não
 * foram configuradas ou em qualquer falha de rede — quem chama deve tratar
 * `null` como "não deu pra confirmar", mantendo a decisão local original em
 * vez de negar por causa de uma falha nossa.
 */
export async function validarCheckInWellhub(wellhubId: string): Promise<AutorizacaoWellhub | null> {
  const config = getConfig();
  if (!config) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${config.baseUrl}${VALIDATE_PATH}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${config.token}`,
        "x-gym-id": config.gymId,
      },
      body: JSON.stringify({ gympass_id: wellhubId }),
      signal: controller.signal,
    });

    if (response.ok) {
      return { autorizado: true, mensagem: null };
    }

    const payload = (await response.json().catch(() => null)) as ValidateErrorResponse | null;
    return { autorizado: false, mensagem: payload?.message ?? payload?.error ?? response.statusText };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
