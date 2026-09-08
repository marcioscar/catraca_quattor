/**
 * Calendário de feriados — no feriado a academia abre só das 08:00 às 12:00
 * (linha "Feriado" da tabela de "Horários de contrato" do plano Hora Certa,
 * ver horario-restricao.ts). Decisão sempre local, calculada na hora: a EVO
 * não expõe esse calendário por API (mesmo bloqueio da tabela de horários,
 * ver NOTES.md).
 *
 * Cobre os feriados **nacionais** (fixos + os móveis, que dependem da Páscoa,
 * por isso são calculados em vez de listados ano a ano — assim o arquivo não
 * "vence" na virada do ano). Feriado municipal/estadual e ponto facultativo
 * (Quarta-feira de Cinzas, 24/12, 31/12...) não entram automaticamente:
 * cadastrar em `FERIADOS_EXTRAS` abaixo.
 */

/** Feriados nacionais de data fixa. Chave "MM-DD". */
const FERIADOS_FIXOS: Record<string, string> = {
  "01-01": "Confraternização Universal",
  "04-21": "Tiradentes",
  "05-01": "Dia do Trabalho",
  "09-07": "Independência",
  "10-12": "Nossa Senhora Aparecida",
  "11-02": "Finados",
  "11-15": "Proclamação da República",
  "11-20": "Consciência Negra",
  "12-25": "Natal",
};

/** Feriados móveis nacionais, em dias de distância do Domingo de Páscoa. */
const FERIADOS_MOVEIS: { offsetDias: number; nome: string }[] = [
  { offsetDias: -48, nome: "Carnaval (segunda)" },
  { offsetDias: -47, nome: "Carnaval (terça)" },
  { offsetDias: -2, nome: "Sexta-feira Santa" },
  { offsetDias: 0, nome: "Páscoa" },
  { offsetDias: 60, nome: "Corpus Christi" },
];

/**
 * Feriados que não são nacionais e datas em que a academia decide abrir em
 * horário de feriado. Formato "YYYY-MM-DD" pra data única ou "MM-DD" pra data
 * que se repete todo ano.
 *
 * A academia é em **Brasília (DF)**. O único feriado distrital com data
 * própria é o Dia do Evangélico; a Fundação de Brasília (21/04) cai no mesmo
 * dia de Tiradentes e Corpus Christi (feriado no DF) já entra pela lista de
 * móveis nacionais acima. **Ponto facultativo ficou de fora de propósito**
 * (Quarta-feira de Cinzas, 28/10 Dia do Servidor Público, 24/12, 31/12): a
 * academia costuma abrir nesses dias, e a janela de feriado é mais curta que
 * a normal — se algum deles virar feriado de verdade aqui, cadastrar abaixo.
 */
export const FERIADOS_EXTRAS: Record<string, string> = {
  "11-30": "Dia do Evangélico (DF)",
};

/** Domingo de Páscoa do ano (algoritmo de Meeus/Jones/Butcher). */
function calcularPascoa(ano: number): Date {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31); // 3=Março, 4=Abril
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(ano, mes - 1, dia);
}

/** "YYYY-MM-DD" no fuso local (não usar toISOString, que converte pra UTC). */
function paraDataLocal(data: Date): string {
  const mes = String(data.getMonth() + 1).padStart(2, "0");
  const dia = String(data.getDate()).padStart(2, "0");
  return `${data.getFullYear()}-${mes}-${dia}`;
}

/** Cache por ano — o cálculo é barato, mas roda a cada passagem na catraca. */
const cachePorAno = new Map<number, Record<string, string>>();

function feriadosDoAno(ano: number): Record<string, string> {
  const emCache = cachePorAno.get(ano);
  if (emCache) {
    return emCache;
  }

  const feriados: Record<string, string> = {};
  for (const [mesDia, nome] of Object.entries(FERIADOS_FIXOS)) {
    feriados[`${ano}-${mesDia}`] = nome;
  }

  const pascoa = calcularPascoa(ano);
  for (const { offsetDias, nome } of FERIADOS_MOVEIS) {
    const data = new Date(pascoa.getFullYear(), pascoa.getMonth(), pascoa.getDate() + offsetDias);
    feriados[paraDataLocal(data)] = nome;
  }

  for (const [data, nome] of Object.entries(FERIADOS_EXTRAS)) {
    feriados[data.length === 5 ? `${ano}-${data}` : data] = nome;
  }

  cachePorAno.set(ano, feriados);
  return feriados;
}

/** Nome do feriado da data, ou `null` se for dia normal. */
export function nomeDoFeriado(data: Date): string | null {
  return feriadosDoAno(data.getFullYear())[paraDataLocal(data)] ?? null;
}

export function ehFeriado(data: Date): boolean {
  return nomeDoFeriado(data) !== null;
}
