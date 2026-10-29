import { test } from "node:test";
import assert from "node:assert/strict";
import { evoJobsLigados } from "../src/catraca/evo-jobs.js";

test("sem variável os jobs da EVO seguem ligados", () => {
  assert.equal(evoJobsLigados(undefined), true);
  assert.equal(evoJobsLigados(""), true);
  assert.equal(evoJobsLigados("ligado"), true);
});

test("desligado/off/false/0 desligam", () => {
  for (const v of ["desligado", "OFF", " false ", "0"]) {
    assert.equal(evoJobsLigados(v), false, v);
  }
});
