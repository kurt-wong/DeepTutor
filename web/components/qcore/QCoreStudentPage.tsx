"use client";

// QCORE-DEEPTUTOR-STUDENT-INTEGRATION-01 — Student 页面（只读展示）。
// 展示 Question Core Student API 已允许学生消费的内容；结构保真（body/material/小问/图片/表格）。
// B1 验收范围不含答案/解析内容可见性（当前 review_only，按策略隐藏）。
import { useCallback, useEffect, useRef, useState } from "react";
import { QuestionContent } from "@/components/qcore/QCoreBlocks";
import { fetchQuestionDetail, fetchQuestionList } from "@/lib/qcore-adapter/client";
import type {
  QCoreListEntry,
  QCoreMappingReport,
  QCoreStudentQuestion,
} from "@/lib/qcore-adapter/types";

function QuestionDetail({ question }: { question: QCoreStudentQuestion }) {
  // 统一版式（Owner 2026-11-24）：材料 / 小问题干 / 选项一律走
  // QuestionContent，按源行号统一排版（七选五的 A–G 因此落在短文之后）；
  // 不再有「灰色卡片 / 裸行」两套样式，也不再有 materials-first / bodies 两段。
  return (
    <div className="mt-4">
      <QuestionContent
        materials={question.content.materials}
        bodies={question.content.bodies}
      />
      <div className="mt-3 text-xs border-t pt-2 text-gray-600">
        答案：{question.answerVisible ? "（按策略可见）" : question.answersNote ?? "按可见性策略隐藏"} · 解析：
        {question.explanationVisible ? "（按策略可见）" : question.explanationNote ?? "按可见性策略隐藏"}
      </div>
    </div>
  );
}

export function QCoreStudentPage() {
  const [list, setList] = useState<QCoreListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ question: QCoreStudentQuestion; report: QCoreMappingReport } | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  // PBA：?api=<base> 源切换（验收隔离通道用）；缺省=正式同源代理，行为不变。
  const [apiBase] = useState<string | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    return new URLSearchParams(window.location.search).get("api") || undefined;
  });

  // PBA 验收：允许 ?q=<questionId> 直接打开隔离库中的真实 Question。
  const [initialQuestionId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("q");
  });

  const load = useCallback(async () => {
    try {
      setList(await fetchQuestionList(apiBase));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [apiBase]);

  useEffect(() => {
    void load();
  }, [load]);

  const detailRef = useRef<HTMLDivElement | null>(null);

  const open = useCallback(async (id: string) => {
    setLoadingId(id);
    try {
      setDetail(await fetchQuestionDetail(id, { apiBase }));
      setError(null);
      // 详情渲染在列表上方，打开后滚回可视区（长列表下点击必见效）
      requestAnimationFrame(() => {
        detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingId(null);
    }
  }, [apiBase]);

  useEffect(() => {
    if (initialQuestionId) {
      void open(initialQuestionId);
    }
  }, [initialQuestionId, open]);

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="max-w-3xl mx-auto p-4">
      {apiBase && (
        <div className="mb-2 border-l-2 border-border pl-2 text-xs text-muted-foreground">
          验收候选环境（隔离数据源）：{apiBase} — 非正式题库，验收用途。
        </div>
      )}
      <h1 className="text-lg font-semibold mb-1">Question Core · 学生题目（只读）</h1>
      <p className="text-xs text-gray-500 mb-3">
        {apiBase
          ? "数据源：隔离验收候选读取通道（含未发布/未完成候选，供 Owner 目视验收）；答案/解析按可见性保护，经逐题预览核对。"
          : "数据源：Question Core Student API（已审核发布内容）；展示层只做 contract 映射，不做二次加工。"}
      </p>
      <a
        href="/learning/qcore/teach"
        className="mb-3 inline-flex items-center rounded border px-3 py-1.5 text-xs hover:bg-muted"
      >
        拍照讲题（OCR → QCore 匹配 → Interactive Lesson）
      </a>
      {error && <div className="text-sm text-red-600 border border-red-300 rounded p-2 mb-2">{error}</div>}
      <div className="text-sm text-gray-700 mb-2">可消费题目：{list === null ? "加载中…" : list.length}</div>
      {detail && (
        <div ref={detailRef} className="mb-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-500">题目详情</span>
            <button
              type="button"
              onClick={() => setDetail(null)}
              className="text-xs text-gray-500 hover:text-gray-800 border rounded px-2 py-0.5"
            >
              关闭详情
            </button>
          </div>
          <QuestionDetail question={detail.question} />
        </div>
      )}
      <div className="space-y-0">
        {(list ?? []).map((q) => (
          <button
            key={q.questionId}
            onClick={() => void open(q.questionId)}
            className="w-full text-left border-b px-1 py-2 hover:bg-muted/40"
          >
            <span className="font-medium">{q.printedNumber ?? q.questionId.slice(0, 8)}</span>
            <span className="text-xs text-gray-500 ml-2">{q.questionType}</span>
            {q.sourceDocumentId && (
              <span className="text-xs text-gray-500 ml-2">{q.sourceDocumentId}</span>
            )}
            {q.admissionReview && (
              <span
                className={`text-xs ml-2 rounded px-1.5 py-0.5 ${
                  q.admissionReview === "approved"
                    ? "bg-muted text-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {q.admissionReview}
                {q.admissionCompleteness && q.admissionCompleteness !== "complete"
                  ? ` · ${q.admissionCompleteness}（候选，非正式可发布）`
                  : ""}
              </span>
            )}
            <span className="text-xs text-gray-400 ml-2 font-mono">{q.questionId.slice(0, 8)}</span>
            {loadingId === q.questionId && <span className="text-xs ml-2">加载中…</span>}
          </button>
        ))}
      </div>
      </div>
    </div>
  );
}
