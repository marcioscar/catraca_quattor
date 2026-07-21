import { db } from "../db.js";

export const PERSON_TYPE_PERSONAL = 4; // EVO entryAuthorize: 4 = Personal

interface Contrato {
  inicio: Date;
  fim: Date;
}

/**
 * Personal tem contrato válido hoje se existe ALGUM contrato já iniciado
 * (`inicio <= agora`) e ainda não vencido (`fim >= início do dia de hoje` —
 * o dia inteiro do vencimento conta como válido). Checa todos os contratos,
 * não só o mais recente, pra cobrir renovação (ver coleção `Personal`).
 */
export function temContratoValido(contratos: Contrato[]): boolean {
  const agora = Date.now();
  const inicioHoje = new Date();
  inicioHoje.setHours(0, 0, 0, 0);

  return contratos.some(
    (c) => c.inicio.getTime() <= agora && c.fim.getTime() >= inicioHoje.getTime()
  );
}

export interface PersonalInfo {
  evoPersonalId: number;
  nome: string | null;
  valido: boolean;
}

/**
 * Busca um personal pelo enrollid do leitor (= `evoPersonalId`, a
 * "Carteirinha" na EVO). Retorna null se o enrollid não é de um personal.
 */
export async function getPersonalPorEnrollid(enrollid: number): Promise<PersonalInfo | null> {
  const personal = await db.personal.findFirst({ where: { evoPersonalId: enrollid } });
  if (!personal) {
    return null;
  }
  return {
    evoPersonalId: personal.evoPersonalId,
    nome: personal.nome,
    valido: temContratoValido(personal.contratos),
  };
}
