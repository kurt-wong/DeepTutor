import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBareChemicalSubscripts, processMarkdownContent } from "../lib/latex";

test("bare chemical subscript becomes unicode subscript outside math", () => {
  assert.equal(normalizeBareChemicalSubscripts("SiHCl_{3}"), "SiHCl₃");
  assert.equal(normalizeBareChemicalSubscripts("CO_{2} 与 H_{2}O"), "CO₂ 与 H₂O");
});

test("math span content is untouched", () => {
  assert.equal(normalizeBareChemicalSubscripts("$ x_{1} $ 与 CO_{2}"), "$ x_{1} $ 与 CO₂");
});

test("processMarkdownContent keeps formulas intact while fixing bare subscripts", () => {
  const out = processMarkdownContent("制备 SiHCl_{3} 时，$ \\sin i = \\frac{1}{6}$");
  assert.ok(out.includes("SiHCl₃"), out);
  assert.ok(out.includes("$\\sin i = \\frac{1}{6}$"), out);
});
