import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { QCorePracticeView } from "@/components/qcore/QCorePracticeView";
import type { QCoreStudentQuestion } from "@/lib/qcore-adapter/types";

// 七选五作答控件（QCORE-QIQI-PRACTICE-CHOICE-01）：选项池在父题，作答单位是
// 短文里的 5 个空位（子问）；此前落到自由文本框，学生看得到题却没法按 A–G 作答。
vi.mock("@/components/common/MarkdownRenderer", () => ({
  default: ({ content }: { content: string }) => <span>{content}</span>,
}));

const option = (label: string) => ({
  label,
  blocks: [{ kind: "text" as const, text: `option ${label} text`, lineStart: 190 }],
});

const question: QCoreStudentQuestion = {
  questionId: "q-1",
  revisionId: "rev-4",
  revisionNumber: 4,
  questionType: "seven_to_five",
  content: {
    materials: [],
    assets: [],
    bodies: [
      {
        localId: "u5",
        questionType: "seven_to_five",
        printedNumber: "16",
        stemBlocks: [{ kind: "text", text: "从短文后的选项中选出最佳选项。", lineStart: 175 }],
        options: ["A", "B", "C", "D", "E", "F", "G"].map(option),
        parentQuestionRef: null,
        subQuestionIds: ["S1", "S2"],
        lineStart: 175,
      },
      {
        localId: "S1",
        questionType: "seven_to_five",
        printedNumber: "16",
        stemBlocks: [{ kind: "text", text: "", lineStart: 179 }],
        options: [],
        parentQuestionRef: "u5",
        subQuestionIds: [],
        lineStart: 179,
      },
      {
        localId: "S2",
        questionType: "seven_to_five",
        printedNumber: "17",
        stemBlocks: [{ kind: "text", text: "", lineStart: 181 }],
        options: [],
        parentQuestionRef: "u5",
        subQuestionIds: [],
        lineStart: 181,
      },
    ],
  },
  answerVisible: false,
  explanationVisible: false,
  answers: [],
  answersNote: null,
  explanationBlocks: [],
  explanationNote: null,
};

it("renders one A–G picker per blank instead of a free textarea", () => {
  const onAnswer = vi.fn();
  render(
    <QCorePracticeView
      question={question}
      identity={null}
      revealed={false}
      answer=""
      onAnswer={onAnswer}
    />,
  );
  expect(screen.getByText(/七选五：为每个空位选一个字母/)).toBeTruthy();
  expect(screen.getByText("空位 16")).toBeTruthy();
  expect(screen.getByText("空位 17")).toBeTruthy();
  expect(document.querySelector("textarea")).toBeNull();
});

it("records one letter per blank in the answer string", () => {
  const onAnswer = vi.fn();
  render(
    <QCorePracticeView
      question={question}
      identity={null}
      revealed={false}
      answer=""
      onAnswer={onAnswer}
    />,
  );
  const buttons = screen.getAllByRole("button", { name: "A" });
  // blank 16 -> A ; blank 17 -> B (each row renders its own A–G buttons)
  fireEvent.click(buttons[0]);
  fireEvent.click(screen.getAllByRole("button", { name: "B" })[1]);
  const last = onAnswer.mock.calls[onAnswer.mock.calls.length - 1][0] as string;
  expect(last).toContain("S1:A");
  expect(last).toContain("S2:B");
});

it("disables the pickers once revealed", () => {
  render(
    <QCorePracticeView
      question={question}
      identity={null}
      revealed
      answer="S1:A"
      onAnswer={() => {}}
    />,
  );
  for (const b of screen.getAllByRole("button", { name: "C" })) {
    expect((b as HTMLButtonElement).disabled).toBe(true);
  }
});
