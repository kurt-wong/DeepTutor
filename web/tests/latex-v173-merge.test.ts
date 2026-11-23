import test from "node:test";
import assert from "node:assert/strict";

import { processMarkdownContent } from "../lib/latex";

// v1.7.3 semantic merge: upstream escapeStrayDollars + local stray-dollar
// cleanup must not leave escaped artifacts (`\$`) behind.
test("empty inline math disappears without leaving a backslash", () => {
  assert.equal(processMarkdownContent("$ $"), "");
  assert.equal(processMarkdownContent("值 $ $ 结束"), "值  结束");
});

test("OCR stray trailing dollar is removed, formula kept", () => {
  assert.equal(
    processMarkdownContent("值 $ 2.5\\times10^{-8}$ $ 结束"),
    "值 $2.5\\times10^{-8}$  结束",
  );
});

test("unmatched dollar is dropped at render time", () => {
  assert.equal(processMarkdownContent("公式 $x+1 未闭合"), "公式 x+1 未闭合");
});

test("legitimate inline math and paired dollars survive", () => {
  assert.equal(processMarkdownContent("$x$ 与 $y$"), "$x$ 与 $y$");
  assert.equal(processMarkdownContent("A $B$ C $D$"), "A $B$ C $D$");
});

test("chemical subscripts outside math are normalised, math untouched", () => {
  assert.equal(
    processMarkdownContent("SiHCl_{3} 与 $x_{1}$"),
    "SiHCl₃ 与 $x_{1}$",
  );
});
