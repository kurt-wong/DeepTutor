"use client";

// C1 阶段1 — QCore Practice 学生链路入口（正式发布集消费）。
// 题源唯一：:8811 Student API（经同源代理）；发布集每次进入即取即用。
// 筛选元数据（学科/卷/印刷号）来自 qid-map 辅助索引；**入队资格只由 API 发布集决定**。
import { useEffect, useMemo, useState } from "react";
import { PracticeSession } from "@/components/learning/practice/PracticeSession";
import {
  listQcorePracticeRefs,
} from "@/lib/qcore-adapter/practice-provider";
import { qidMap, QcNotFoundError, QcUnavailableError } from "@/lib/qcore-adapter/client";
import type { PracticeSourceRef } from "@/lib/practice-source";

type QueueItem = {
  kind: "qcore";
  questionId: string;
  revisionId: string;
  subject: string;
  paper: string;
  printedNumber: string | null;
};

export default function QCorePracticePage() {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState("");
  const [started, setStarted] = useState(false);
  const [subjectFilter, setSubjectFilter] = useState<string>("");
  const [paperFilter, setPaperFilter] = useState<string>("");

  useEffect(() => {
    let active = true;
    listQcorePracticeRefs()
      .then((refs) => {
        if (!active) return;
        setItems(
          refs.map((r) => {
            const meta = qidMap[r.questionId];
            return {
              kind: "qcore" as const,
              questionId: r.questionId,
              revisionId: r.revisionId,
              subject: meta?.subject ?? "未映射",
              paper: meta?.source_document_id ?? "未映射",
              printedNumber: meta?.printed_number ?? null,
            };
          }),
        );
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof QcNotFoundError) {
          setError("发布集当前不可读取（未发布或不存在）。");
        } else if (err instanceof QcUnavailableError) {
          setError("Student API 暂不可达，请稍后重试。");
        } else {
          setError(String((err as Error).message || err));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const subjects = useMemo(
    () => Array.from(new Set((items ?? []).map((i) => i.subject))).sort(),
    [items],
  );
  const papers = useMemo(() => {
    const pool = (items ?? []).filter(
      (i) => !subjectFilter || i.subject === subjectFilter,
    );
    return Array.from(new Set(pool.map((i) => i.paper))).sort();
  }, [items, subjectFilter]);

  const filtered = useMemo(
    () =>
      (items ?? []).filter(
        (i) =>
          (!subjectFilter || i.subject === subjectFilter) &&
          (!paperFilter || i.paper === paperFilter),
      ),
    [items, subjectFilter, paperFilter],
  );

  return (
    <section className="mx-auto max-w-3xl">
      <div className="mb-4 border-l-2 border-border pl-3 text-xs text-muted-foreground">
        学生链路 · Question Core 唯一题源（:8811 Student API，图片 :8812 白名单）。
        不读旧题库；未发布题不可达。
      </div>
      {error && (
        <div role="alert" className="mb-4 rounded border border-destructive/30 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {!items ? (
        <p role="status" className="py-8 text-sm text-muted-foreground">
          加载 Question Core 发布集…
        </p>
      ) : started ? (
        <PracticeSession
          sourceItems={filtered.map(({ kind, questionId, revisionId }) => ({
            kind,
            questionId,
            revisionId,
          }))}
          onClose={() => setStarted(false)}
          backLabel="返回 QCore 练习"
        />
      ) : (
        <div className="rounded-2xl border border-border bg-card p-6">
          <h1 className="font-serif text-xl font-semibold">QCore 真题练习</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            当前发布集共 {items.length} 道（Student API 实时结果）。作答记录以
            question_id + revision_id 关联，题目内容零复制。
          </p>

          <div className="mt-4 space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">学科：</span>
              <button
                type="button"
                onClick={() => {
                  setSubjectFilter("");
                  setPaperFilter("");
                }}
                className={`rounded px-2 py-1 border ${!subjectFilter ? "border-primary bg-primary/10" : "border-border"}`}
              >
                全部
              </button>
              {subjects.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setSubjectFilter(s);
                    setPaperFilter("");
                  }}
                  className={`rounded px-2 py-1 border ${subjectFilter === s ? "border-primary bg-primary/10" : "border-border"}`}
                >
                  {s}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">试卷：</span>
              <button
                type="button"
                onClick={() => setPaperFilter("")}
                className={`rounded px-2 py-1 border ${!paperFilter ? "border-primary bg-primary/10" : "border-border"}`}
              >
                全部
              </button>
              {papers.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPaperFilter(p)}
                  className={`rounded px-2 py-1 border ${paperFilter === p ? "border-primary bg-primary/10" : "border-border"}`}
                >
                  {p.replace(/（教师版）\(1\)$/, "")}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              待练习：{filtered.length} 道
              {filtered.length > 0 && (
                <>（{filtered.map((i) => `第${i.printedNumber ?? "?"}题`).join("、")}）</>
              )}
            </p>
          </div>

          <button
            type="button"
            disabled={filtered.length === 0}
            onClick={() => setStarted(true)}
            className="mt-4 rounded-xl bg-primary px-5 py-2.5 text-sm text-primary-foreground disabled:opacity-40"
          >
            开始练习
          </button>
        </div>
      )}
    </section>
  );
}
