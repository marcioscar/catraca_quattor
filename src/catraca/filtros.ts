/**
 * Peculiaridade do conector MongoDB do Prisma: campos `DateTime?` nunca
 * setados ficam AUSENTES no documento, não `null` — e `{ campo: null }` só
 * bate com "null explícito", não com "ausente". Cobre os dois casos.
 */
export const NAO_REMOVIDO = {
  OR: [{ removidoEm: null }, { removidoEm: { isSet: false as const } }],
};
