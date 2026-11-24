import React from "react";
import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { QuestionContent } from "@/components/qcore/QCoreBlocks";
import type { QCoreBody, QCoreMaterial } from "@/lib/qcore-adapter/types";

// Markdown/KaTeX 渲染器在 jsdom 下走 next/dynamic（ssr:false），测试里替换为纯文本，
// 只验证「排版顺序 + 选项行版式」两条展示层规则。
vi.mock("@/components/common/MarkdownRenderer", () => ({
  default: ({ content }: { content: string }) => <span>{content}</span>,
}));

// 七选五回归（QCORE-QIQI-MATERIAL-LOSS-01 展示侧）：
// - 材料（短文）与小问/选项按源行号统一排版，选项落在短文之后；
// - 源文一行一个选项 → 逐行排版；源文一行四选（完形）→ 仍并排一行。

const material: QCoreMaterial = {
  materialId: "M01",
  lineStart: 177,
  lineEnd: 189,
  blocks: [
    { kind: "text", text: "## Personal Forgiveness", lineStart: 177, lineEnd: 177 },
    { kind: "text", text: "Passage paragraph with blank 16.", lineStart: 179, lineEnd: 179 },
  ],
};

const parent: QCoreBody = {
  localId: "u5",
  questionType: "seven_to_five",
  printedNumber: "16",
  stemBlocks: [
    { kind: "text", text: "阅读下面短文，从短文后的选项中选出可以填入空白处的最佳选项。", lineStart: 175, lineEnd: 175 },
  ],
  options: [
    { label: "A", blocks: [{ kind: "text", text: "A little self-forgiveness also goes a long way.", lineStart: 191, lineEnd: 191 }] },
    { label: "B", blocks: [{ kind: "text", text: "Now list all the characteristics you like about yourself.", lineStart: 193, lineEnd: 193 }] },
  ],
  parentQuestionRef: null,
  subQuestionIds: ["S1"],
  materialIds: ["M01"],
  lineStart: 175,
};

function textOf(el: HTMLElement): string {
  return (el.textContent ?? "").replace(/\s+/g, "");
}

it("renders instruction, passage, then stacked options in source order", () => {
  const { container } = render(<QuestionContent materials={[material]} bodies={[parent]} />);
  const body = container.textContent ?? "";
  const idxInstruction = body.indexOf("阅读下面短文");
  const idxPassage = body.indexOf("Passage paragraph");
  const idxOptionA = body.indexOf("A little self-forgiveness");
  expect(idxInstruction).toBeGreaterThanOrEqual(0);
  expect(idxPassage).toBeGreaterThan(idxInstruction);
  expect(idxOptionA).toBeGreaterThan(idxPassage);
  // 源文一行一个选项 → 每个选项独占一行（stacked 容器）
  const stacked = container.querySelectorAll(".space-y-1 > div.flex.items-start");
  expect(stacked.length).toBe(2);
});

it("keeps same-source-line options on one row (cloze style)", () => {
  const cloze: QCoreBody = {
    localId: "u16-s1",
    questionType: "single_choice",
    printedNumber: "(1)",
    stemBlocks: [{ kind: "text", text: "", lineStart: 300, lineEnd: 300 }],
    options: [
      { label: "A", blocks: [{ kind: "text", text: "ownership", lineStart: 301, lineEnd: 301 }] },
      { label: "B", blocks: [{ kind: "text", text: "membership", lineStart: 301, lineEnd: 301 }] },
    ],
    parentQuestionRef: "u16",
    subQuestionIds: [],
    lineStart: 300,
  };
  const { container } = render(<QuestionContent materials={[]} bodies={[cloze]} />);
  const row = container.querySelector("div.flex.flex-wrap");
  expect(row).not.toBeNull();
  expect(textOf(row as HTMLElement)).toContain("membership");
});
