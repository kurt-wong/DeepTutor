import test from "node:test";
import assert from "node:assert/strict";
import { normalizeStrayMathDelimiters } from "../lib/latex";

// OCR 常见缺陷：答案/表格里出现成对公式后残留一个 `$`（如 `$...$ $`）。

test("trailing stray dollar after a valid inline formula is removed", () => {
  assert.equal(
    normalizeStrayMathDelimiters("$ 2.5\\times 10^{-8}$ $"),
    "$ 2.5\\times 10^{-8}$",
  );
});

test("empty math pair is removed", () => {
  assert.equal(normalizeStrayMathDelimiters("值 $ $ 结束"), "值  结束");
});

test("balanced inline math is untouched", () => {
  const s = "已知 $ z = \\frac{1}{2} $，则";
  assert.equal(normalizeStrayMathDelimiters(s), s);
});

test("display math block is untouched", () => {
  const s = "$$\nx = 1\n$$";
  assert.equal(normalizeStrayMathDelimiters(s), s);
});

test("unmatched opening dollar in a prose line is dropped", () => {
  assert.equal(normalizeStrayMathDelimiters("公式 $x+1 未闭合"), "公式 x+1 未闭合");
});
