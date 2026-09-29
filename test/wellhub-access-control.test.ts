import { test } from "node:test";
import assert from "node:assert/strict";
import { jaValidadoNaWellhub } from "../src/catraca/wellhub-access-control.js";

test("reconhece o 'already validated' da Wellhub", () => {
  assert.equal(jaValidadoNaWellhub("Check-In already validated"), true);
  assert.equal(jaValidadoNaWellhub("check-in ALREADY VALIDATED"), true);
});

test("outros erros não contam como validado", () => {
  assert.equal(jaValidadoNaWellhub("Check-In expired"), false);
  assert.equal(jaValidadoNaWellhub("Check-In not found in database"), false);
  assert.equal(jaValidadoNaWellhub(null), false);
});
