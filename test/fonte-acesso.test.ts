import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decidirPeloRecepcao,
  dentroDasJanelas,
  fonteAcesso,
  type CamposRecepcao,
  type JanelaAcessoLocal,
} from "../src/catraca/fonte-acesso.js";

// Segunda-feira, 28/09/2026 (Date.getDay() === 1), no fuso local do PC.
const segunda = (h: number, m = 0) => new Date(2026, 8, 28, h, m);

const publicado = (campos: Partial<CamposRecepcao> = {}): CamposRecepcao => ({
  publicadoEm: new Date(2026, 8, 28),
  ativoLocal: true,
  comDebitoLocal: false,
  acessoLivre: true,
  janelasAcesso: [],
  turmaSemMatricula: false,
  ...campos,
});

const pilatesSegunda: JanelaAcessoLocal = {
  weekDay: 1,
  inicio: "19:00",
  fim: "20:00",
  tolAntesMin: 30,
  tolDepoisMin: 20,
  origem: "turma",
};
const feriadoManha: JanelaAcessoLocal = {
  weekDay: "feriado",
  inicio: "08:00",
  fim: "12:00",
  tolAntesMin: 15,
  tolDepoisMin: 15,
  origem: "turma",
};

test("flag: só 'recepcao' liga; ausente ou qualquer outro valor é evo", () => {
  assert.equal(fonteAcesso(undefined), "evo");
  assert.equal(fonteAcesso(""), "evo");
  assert.equal(fonteAcesso("evo"), "evo");
  assert.equal(fonteAcesso("recepção"), "evo");
  assert.equal(fonteAcesso(" RECEPCAO "), "recepcao");
});

test("nunca publicado pelo recepcao cai na EVO", () => {
  assert.equal(decidirPeloRecepcao(publicado({ publicadoEm: null }), segunda(10), false), "sem_publicacao");
  assert.equal(decidirPeloRecepcao(publicado({ ativoLocal: null }), segunda(10), false), "sem_publicacao");
});

test("inativo (vencido, cancelado, trancado) é barrado", () => {
  assert.equal(decidirPeloRecepcao(publicado({ ativoLocal: false }), segunda(10), false), "inativo");
});

test("débito barra mesmo com plano livre", () => {
  assert.equal(decidirPeloRecepcao(publicado({ comDebitoLocal: true }), segunda(10), false), "saldo_devedor");
});

test("plano livre entra a qualquer hora", () => {
  assert.equal(decidirPeloRecepcao(publicado(), segunda(3), false), "liberado");
});

test("turma sem matrícula libera (decisão de 21/07)", () => {
  const aluno = publicado({ acessoLivre: false, turmaSemMatricula: true });
  assert.equal(decidirPeloRecepcao(aluno, segunda(3), false), "turma_sem_matricula");
});

test("plano restrito: dentro da janela com tolerância entra, fora não", () => {
  const aluno = publicado({ acessoLivre: false, janelasAcesso: [pilatesSegunda] });
  assert.equal(decidirPeloRecepcao(aluno, segunda(18, 30), false), "liberado"); // 30 min antes
  assert.equal(decidirPeloRecepcao(aluno, segunda(20, 20), false), "liberado"); // 20 min depois
  assert.equal(decidirPeloRecepcao(aluno, segunda(18, 29), false), "fora_do_horario");
  assert.equal(decidirPeloRecepcao(aluno, segunda(20, 21), false), "fora_do_horario");
});

test("feriado usa só a janela de feriado", () => {
  const aluno = publicado({ acessoLivre: false, janelasAcesso: [pilatesSegunda, feriadoManha] });
  assert.equal(decidirPeloRecepcao(aluno, segunda(10), true), "liberado");
  assert.equal(decidirPeloRecepcao(aluno, segunda(19), true), "fora_do_horario");
});

test("janelas malformadas são ignoradas, não derrubam", () => {
  const aluno = publicado({ acessoLivre: false, janelasAcesso: [{ weekDay: 1 }, null, "x", pilatesSegunda] });
  assert.equal(decidirPeloRecepcao(aluno, segunda(19), false), "liberado");
  assert.equal(dentroDasJanelas(segunda(19), [], false), false);
});
