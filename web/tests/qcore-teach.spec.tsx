import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QCoreTeachPage } from "@/components/qcore/QCoreTeachPage";
import { buildFollowUpPrompt } from "@/components/qcore/LessonTurnAdapter";
import type { SearchResult, TeachingBundle } from "@/lib/qcore-teach/client";

const searchPhoto = vi.fn();
const fetchBundle = vi.fn();

vi.mock("@/components/common/MarkdownRenderer", () => ({
  default: ({ content }: { content: string }) => <span>{content}</span>,
}));

vi.mock("@/lib/qcore-teach/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/qcore-teach/client")>(
    "@/lib/qcore-teach/client",
  );
  return {
    ...actual,
    searchPhoto: (...args: unknown[]) => searchPhoto(...args),
    fetchBundle: (...args: unknown[]) => fetchBundle(...args),
    lessonUrl: () => "http://lesson.test/?question_id=q1",
  };
});

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    question_id: "11111111-1111-1111-1111-111111111111",
    revision_id: "22222222-2222-2222-2222-222222222222",
    score: 0.81,
    score_parts: { lexical: 0.8, semantic: 0.7, structure: 0.6, llm: 0.9 },
    match_evidence: [{ type: "number", value: "1" }],
    source_document_id: "synthetic-paper",
    printed_number: "1",
    question_type: "single_choice",
    title: "已知集合",
    has_image: false,
    has_table: false,
    llm: { match: 0.9, verdict: "match" },
    needs_confirmation: false,
    ...overrides,
  };
}

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    search_id: "s1",
    decision: "high_confidence",
    requires_confirmation: false,
    may_teach: true,
    message: "已找到高置信题目，可直接进入讲题。",
    candidates: [candidate()],
    ...overrides,
  };
}

function bundle(): TeachingBundle {
  return {
    question_id: "11111111-1111-1111-1111-111111111111",
    revision_id: "22222222-2222-2222-2222-222222222222",
    revision_number: 2,
    language: "zh-CN",
    init_step: "s1",
    question: {
      subject: "数学",
      source_document_id: "synthetic-paper",
      printed_number: "1",
      question_type: "single_choice",
      title: "1题 · 已知集合",
      content_hash: "a".repeat(64),
    },
    lesson_url: "http://lesson.test/?question_id=q1&access_token=scoped-token",
    script: {
      script_id: "ts_x",
      question_id: "11111111-1111-1111-1111-111111111111",
      revision_id: "22222222-2222-2222-2222-222222222222",
      revision_number: 2,
      question_type: "single_choice",
      title: "1题 · 已知集合",
      final_answer: { display: "A", value: "A", answer_type: "single_choice" },
      steps: [
        {
          step_id: "s1",
          goal: "读题",
          source_refs: ["cb:u1:stem:0"],
          board: [{ id: "b101", kind: "text", text: "已知集合 M={1,2}" }],
          speech: "已知集合",
          subtitle: "已知集合",
          duration_ms: 5000,
          effects: [],
        },
        {
          step_id: "s2",
          goal: "结论",
          source_refs: ["ans:0"],
          board: [{ id: "b201", kind: "callout", tone: "answer", text: "答案为 A" }],
          speech: "答案为 A",
          subtitle: "答案为 A",
          duration_ms: 5000,
          effects: [],
        },
      ],
      validation: { status: "pass", checks: [] },
    },
  };
}

async function upload() {
  const input = await screen.findByTestId("teach-file-input");
  const file = new File([new Uint8Array([1, 2, 3])], "q.png", { type: "image/png" });
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
    await Promise.resolve();
  });
}

describe("QCoreTeachPage", () => {
  beforeEach(() => {
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:test") });
    searchPhoto.mockReset();
    fetchBundle.mockReset();
  });

  it("disables teaching for a low-confidence match (fail closed)", async () => {
    searchPhoto.mockResolvedValue(
      result({
        decision: "low_confidence",
        may_teach: false,
        message: "未找到可靠的 QCore 题目",
        candidates: [candidate({ score: 0.21 })],
      }),
    );
    render(<QCoreTeachPage />);
    await upload();
    const button = await screen.findByTestId("teach-start-0");
    expect(button).toBeDisabled();
  });

  it("loads the teaching bundle only after an explicit confirmation", async () => {
    searchPhoto.mockResolvedValue(result());
    fetchBundle.mockResolvedValue(bundle());
    const { container } = render(<QCoreTeachPage />);
    await upload();
    const button = await screen.findByTestId("teach-start-0");
    expect(button).not.toBeDisabled();
    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(fetchBundle).toHaveBeenCalledWith(
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
      );
    });
    await waitFor(() => {
      const frame = container.querySelector('[data-testid="teach-lesson-frame"]');
      expect(frame).toBeTruthy();
      expect(frame?.getAttribute("src")).toContain("question_id=q1");
    });
  });

  it("blocks playback when the script failed validation", async () => {
    searchPhoto.mockResolvedValue(result());
    const bad = bundle();
    bad.script.validation = {
      status: "fail",
      checks: [{ name: "answer_consistent", status: "fail" }],
    };
    fetchBundle.mockResolvedValue(bad);
    render(<QCoreTeachPage />);
    await upload();
    const startButton = await screen.findByTestId("teach-start-0");
    await act(async () => {
      fireEvent.click(startButton);
      await Promise.resolve();
    });
    expect(await screen.findByTestId("teach-error")).toHaveTextContent("answer_consistent");
  });
});

describe("buildFollowUpPrompt", () => {
  it("binds the turn to the exact revision and current step", () => {
    const prompt = buildFollowUpPrompt(
      {
        question_id: "q1",
        revision_id: "r1",
        step_id: "s3",
        step_goal: "分析",
        speech: "先求导",
        source_refs: ["exp:1"],
        question: "为什么先求导？",
      },
      "题干：f(x)=x^2",
    );
    expect(prompt).toContain("question_id: q1");
    expect(prompt).toContain("revision_id: r1");
    expect(prompt).toContain("当前教学步骤：s3");
    expect(prompt).toContain("为什么先求导？");
    expect(prompt).toContain("不要新增题目条件");
  });
});
