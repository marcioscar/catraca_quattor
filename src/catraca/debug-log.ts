/**
 * Buffer temporário (em memória) das últimas mensagens WS trocadas com o
 * device, nos dois sentidos — pra depurar remotamente sem precisar puxar
 * `logs/out.log` no PC da catraca a cada teste. Remover depois que o
 * protocolo de cadastro (`setuserinfo`) estiver confirmado contra o device
 * real (ver NOTES.md).
 */
const TAMANHO_MAX = 100;

export interface EntradaLog {
  direcao: "in" | "out";
  raw: string;
  em: string;
}

const buffer: EntradaLog[] = [];

export function registrarMensagem(direcao: "in" | "out", raw: string): void {
  buffer.push({ direcao, raw, em: new Date().toISOString() });
  if (buffer.length > TAMANHO_MAX) {
    buffer.shift();
  }
}

export function getUltimasMensagens(): EntradaLog[] {
  return [...buffer].reverse();
}
