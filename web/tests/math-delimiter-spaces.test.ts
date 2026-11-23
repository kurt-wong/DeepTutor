import test from "node:test";
import assert from "node:assert/strict";
import { processMarkdownContent } from "../lib/latex";

// QCORE-DT-MATH-RENDER-FIX-01 回归：remark-math 要求 `$` 紧贴公式内容；
// 定界符内侧带空白的合法 LaTeX 必须被规范化，且不得把 `$ABC$` 当文本转义。

test("delimiter-inner spaces are trimmed on both sides", () => {
  const out = processMarkdownContent("氧化性： $ \\mathrm{Cl}_{2} > \\mathrm{Br}_{2} $");
  assert.ok(out.includes("$\\mathrm{Cl}_{2} > \\mathrm{Br}_{2}$"), out);
  assert.ok(!out.includes("$ "), out);
});

test("one-sided inner space is trimmed (physics p16 case)", () => {
  const out = processMarkdownContent("当 $ \\sin i = \\frac{1}{6}$ 时，恰好");
  assert.ok(out.includes("$\\sin i = \\frac{1}{6}$"), out);
});

test("uppercase inline math is not escaped into \\$", () => {
  const out = processMarkdownContent("在三棱镜 $ABC$ 的侧面 $AC$ 上");
  assert.ok(!out.includes("\\$"), out);
  assert.ok(out.includes("$ABC$"), out);
});

test("ordinary tight math is untouched", () => {
  const out = processMarkdownContent("已知 $x$ 与 $y$ 两种");
  assert.ok(out.includes("$x$") && out.includes("$y$"), out);
});

test("table cell formula with entity-safe comparison stays math", () => {
  const out = processMarkdownContent("$ 2.5 \\times 10^{-8} $");
  assert.ok(out.includes("$2.5 \\times 10^{-8}$"), out);
});
