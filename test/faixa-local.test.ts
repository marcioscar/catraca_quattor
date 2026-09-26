import { test } from "node:test";
import assert from "node:assert/strict";
import { ehRegistroLocal } from "../src/catraca/faixa-local.js";

test("id da sequência da EVO não é local", () => {
  assert.equal(ehRegistroLocal({ idMember: 24_905 }), false);
  assert.equal(ehRegistroLocal({ idMember: 49_999, fonte: null }), false);
});

test("faixa 50 000–99 999 é local", () => {
  assert.equal(ehRegistroLocal({ idMember: 50_000 }), true);
  assert.equal(ehRegistroLocal({ idMember: 90_001 }), true);
  assert.equal(ehRegistroLocal({ idMember: 99_999 }), true);
});

test("ids legados do device acima de 100 000 não são locais", () => {
  assert.equal(ehRegistroLocal({ idMember: 100_000 }), false);
  assert.equal(ehRegistroLocal({ idMember: 209_566 }), false);
});

test("fonte recepcao é local em qualquer faixa", () => {
  assert.equal(ehRegistroLocal({ idMember: 1_234, fonte: "recepcao" }), true);
});
