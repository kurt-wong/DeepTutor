"use client";

// B-2 Spike — QCore 题目的 Practice 作答视图（结构保真）。
// 硬边界：review_only 下揭示=学生对照原题自检；answers/explanation 内容
// 一律不渲染（仅显示 API 的可见性 note），submitted 不作答案授权。
import { useMemo, useState } from "react";
import { BodyView, MaterialView } from "@/components/qcore/QCoreBlocks";
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
  const freeBodies = useMemo(() => bodies.filter((b) => !isChoiceBody(b)), [bodies]);
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
      <div className="mb-2 flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground">
        <span className="rounded bg-primary/10 px-2 py-0.5 font-medium text-primary">
          QCore · {question.questionType}
        </span>
        {identity && <span>{identity.source_document_id}</span>}
        {identity?.printed_number != null && <span>题号 {identity.printed_number}</span>}
        <span>revision {question.revisionId.slice(0, 8)}</span>
      </div>

      {question.content.materials.map((m) => (
        <MaterialView key={m.materialId} material={m} />
      ))}

      {bodies.map((body, i) => (
        <BodyView key={body.localId || i} body={body} showPrintedNumber />
      ))}

      <div className="mt-4 rounded border border-border bg-muted/30 p-3">
        <div className="text-xs font-medium text-muted-foreground mb-2">作答</div>
        {choiceBodies.map((body) => (
          <div key={`pick-${body.localId}`} className="mb-2">
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
                    className={`rounded px-3 py-1 text-sm border ${
                      active
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border hover:bg-muted"
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
            value={choiceBodies.length > 0 && !answer.includes(":") ? "" : answer}
            disabled={revealed}
            onChange={(e) => onAnswer(e.target.value)}
            rows={4}
            placeholder="输入作答（对照原题自检）"
            className="w-full rounded border border-border bg-background p-2 text-sm"
          />
        )}
        {choiceBodies.length > 0 && freeBodies.length === 0 && (
          <div className="text-xs text-muted-foreground">已选：{answer || "（未选择）"}</div>
        )}
      </div>

      {revealed && (
        <div className="mt-3 rounded border border-dashed border-border p-3 text-sm text-muted-foreground">
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
