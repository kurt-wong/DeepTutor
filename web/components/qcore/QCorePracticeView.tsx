"use client";

// B-2 Spike — QCore 题目的 Practice 作答视图（结构保真）。
// 硬边界：review_only 下揭示=学生对照原题自检；answers/explanation 内容
// 一律不渲染（仅显示 API 的可见性 note），submitted 不作答案授权。
import { useMemo, useState } from "react";
import { QuestionContent } from "@/components/qcore/QCoreBlocks";
import type { QCoreStudentQuestion } from "@/lib/qcore-adapter/types";
import type { QidMapEntry } from "@/lib/qcore-adapter/client";

const CHOICE_TYPES = new Set(["single_choice", "multi_choice", "multiple_select", "choice"]);

function isChoiceBody(body: QCoreStudentQuestion["content"]["bodies"][number]): boolean {
  return CHOICE_TYPES.has(body.questionType) && body.options.length > 0;
}

export function QCorePracticeView({
  question,
  identity,
  revealed,
  answer,
  onAnswer,
}: {
  question: QCoreStudentQuestion;
  identity: QidMapEntry | null;
  revealed: boolean;
  answer: string;
  onAnswer: (value: string) => void;
}) {
  const bodies = question.content.bodies;
  const choiceBodies = useMemo(() => bodies.filter(isChoiceBody), [bodies]);
  // 七选五（QCORE-QIQI-PRACTICE-CHOICE-01）：选项池在父题上，作答单位是短文里的
  // 5 个空位（子问）。此前落到自由文本框，学生看得到题却没法按 A–G 作答。
  const agPool = useMemo(
    () =>
      question.questionType === "seven_to_five"
        ? bodies.find((b) => b.parentQuestionRef === null && b.options.length > 0) ?? null
        : null,
    [bodies, question.questionType],
  );
  const blankBodies = useMemo(
    () => (agPool ? bodies.filter((b) => b.parentQuestionRef !== null) : []),
    [bodies, agPool],
  );
  const freeBodies = useMemo(
    () => bodies.filter((b) => !isChoiceBody(b) && !(agPool && (b === agPool || blankBodies.includes(b)))),
    [bodies, agPool, blankBodies],
  );
  // 选择题：按 localId 记录所选标签；与自由作答合并为单一 answer 串。
  const [picks, setPicks] = useState<Record<string, string[]>>({});

  function togglePick(localId: string, label: string, multi: boolean) {
    setPicks((prev) => {
      const cur = prev[localId] ?? [];
      const next = multi
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : [label];
      const merged = { ...prev, [localId]: next };
      onAnswer(
        Object.entries(merged)
          .filter(([, v]) => v.length > 0)
          .map(([k, v]) => `${k}:${v.join("")}`)
          .join(" "),
      );
      return merged;
    });
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">QCore · {question.questionType}</span>
        {identity && <span>{identity.source_document_id}</span>}
        {identity?.printed_number != null && <span>题号 {identity.printed_number}</span>}
        <span>revision {question.revisionId.slice(0, 8)}</span>
      </div>

      <QuestionContent materials={question.content.materials} bodies={bodies} />

      <div className="mt-4 border-t pt-4">
        <div className="text-xs font-medium text-muted-foreground mb-2">作答</div>
        {agPool && (
          <div className="mb-3 space-y-2">
            <div className="text-xs text-muted-foreground">
              七选五：为每个空位选一个字母（选项池 {agPool.options.map((o) => o.label).join("/")}）
            </div>
            {blankBodies.map((blank) => (
              <div key={`blank-${blank.localId}`} className="flex flex-wrap items-baseline gap-2">
                <span className="w-14 shrink-0 text-xs text-muted-foreground">
                  {blank.printedNumber != null ? `空位 ${blank.printedNumber}` : blank.localId}
                </span>
                <div className="flex flex-wrap gap-2">
                  {agPool.options.map((o) => {
                    const active = (picks[blank.localId] ?? []).includes(o.label);
                    return (
                      <button
                        key={`${blank.localId}-${o.label}`}
                        type="button"
                        disabled={revealed}
                        onClick={() => togglePick(blank.localId, o.label, false)}
                        className={`rounded border px-2.5 py-0.5 text-sm ${
                          active
                            ? "border-foreground font-medium"
                            : "border-border hover:bg-muted/60"
                        }`}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
        {!agPool && choiceBodies.map((body) => (
          <div key={`pick-${body.localId}`} className="mb-3">
            <div className="text-xs text-muted-foreground mb-1">
              {body.printedNumber != null ? `第 ${body.printedNumber} 题` : body.localId}
              {isChoiceBody(body) && body.questionType !== "single_choice" ? "（多选）" : ""}
            </div>
            <div className="flex flex-wrap gap-2">
              {body.options.map((o) => {
                const active = (picks[body.localId] ?? []).includes(o.label);
                return (
                  <button
                    key={o.label}
                    type="button"
                    disabled={revealed}
                    onClick={() =>
                      togglePick(body.localId, o.label, body.questionType !== "single_choice")
                    }
                    className={`rounded border px-3 py-1 text-sm ${
                      active
                        ? "border-foreground font-medium"
                        : "border-border hover:bg-muted/60"
                    }`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {freeBodies.length > 0 && (
          <textarea
            value={(choiceBodies.length > 0 || agPool) && !answer.includes(":") ? "" : answer}
            disabled={revealed}
            onChange={(e) => onAnswer(e.target.value)}
            rows={4}
            placeholder="输入作答（对照原题自检）"
            className="w-full rounded border p-2 text-sm"
          />
        )}
        {(choiceBodies.length > 0 || agPool) && freeBodies.length === 0 && (
          <div className="text-xs text-muted-foreground">已选：{answer || "（未选择）"}</div>
        )}
      </div>

      {revealed && (
        <div className="mt-4 border-t pt-3 text-sm text-muted-foreground">
          <div className="font-medium text-foreground mb-1">自检（无参考答案下发）</div>
          <p>{question.answersNote ?? "答案按可见性策略隐藏（review_only）"}</p>
          <p className="mt-1">{question.explanationNote ?? "解析按可见性策略隐藏（review_only）"}</p>
          <p className="mt-2 text-xs">
            请对照上方原题自检；本记录为「已作答/未判分」，不会伪造对错。
            自评（再练/困难/掌握/简单）仅用于复习安排，不代表系统判分，也不计入正式错题或正确率。
          </p>
        </div>
      )}
    </div>
  );
}
