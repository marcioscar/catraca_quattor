/**
 * Registros que o `recepcao` publica em `CatracaAluno` (contrato de dados
 * recepcao ↔ catraca-api, fase F0 — ver `docs/migracao-evo/contrato-catraca.md`
 * no repo `recepcao`).
 *
 * Depois da migração, aluno, colaborador e personal novos nascem no `recepcao`
 * com enrollid numa faixa própria (50 000–99 999), longe da sequência da EVO.
 * A EVO não conhece esses ids: se os syncs daqui os tratassem como "não
 * veio na lista de ativos", o aluno recém-convertido seria trancado na porta
 * no ciclo seguinte (achado A1). Esses registros ficam fora dos syncs da EVO.
 *
 * `fonte: "recepcao"` cobre o caso de o `recepcao` publicar um id fora da
 * faixa (aluno vindo da EVO, depois da virada).
 */
export const FAIXA_LOCAL_INICIO = 50_000;
export const FAIXA_LOCAL_FIM_EXCLUSIVO = 100_000;

export function ehRegistroLocal(registro: { idMember: number; fonte?: string | null }): boolean {
  if (registro.fonte === "recepcao") {
    return true;
  }
  return registro.idMember >= FAIXA_LOCAL_INICIO && registro.idMember < FAIXA_LOCAL_FIM_EXCLUSIVO;
}
