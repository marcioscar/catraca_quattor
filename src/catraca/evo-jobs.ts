/**
 * Virada (E4 passo 5): `EVO_JOBS=desligado` para de chamar a EVO em segundo
 * plano — sync de `ativo` e de débitos (10 min), full-crawl de clientes,
 * ids Wellhub e horários da madrugada. O que não fala com a EVO segue
 * rodando: personais (leitura local) e auto-validação Wellhub.
 *
 * Só faz sentido com `CATRACA_FONTE_ACESSO=recepcao`: no modo `evo` a porta
 * decide pelos campos que esses jobs escrevem, que congelariam.
 *
 * Módulo puro pra ser testável.
 */
export function evoJobsLigados(valor: string | undefined): boolean {
  const v = valor?.trim().toLowerCase();
  return !(v === "desligado" || v === "off" || v === "false" || v === "0");
}
