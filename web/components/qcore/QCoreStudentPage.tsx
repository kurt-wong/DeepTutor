"use client";

// QCORE-DEEPTUTOR-STUDENT-INTEGRATION-01 — Student 页面（只读展示）。
// 展示 Question Core Student API 已允许学生消费的内容；结构保真（body/material/小问/图片/表格）。
// B1 验收范围不含答案/解析内容可见性（当前 review_only，按策略隐藏）。
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { BlockView, BodyView, InlineBlocks } from "@/components/qcore/QCoreBlocks";
import { fetchQuestionDetail, fetchQuestionList } from "@/lib/qcore-adapter/client";
import type {
  QCoreBlock,
  QCoreBody,
  QCoreListEntry,
  QCoreMappingReport,
  QCoreMaterial,
  QCoreStudentQuestion,
} from "@/lib/qcore-adapter/types";

function normText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** PDF 原卷式紧凑行：题号 + 选项一行排开（子问句与通篇材料重复时不重复显示句子）。 */
function CompactOptionRow({ body }: { body: QCoreBody }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 my-1 text-sm">
      <span className="font-medium">{body.printedNumber}.</span>
      {body.options.map((o) => (
        <div key={o.label} className="flex items-baseline gap-1">
          <span className="font-medium">{o.label}.</span>
          <BlockView block={o.blocks[0]} />
        </div>
      ))}
    </div>
  );
}

function segLineStart(blocks: QCoreBlock[]): number | null {
  const vals = blocks
    .map((b) => ("lineStart" in b ? b.lineStart ?? null : null))
    .filter((v): v is number => typeof v === "number");
  return vals.length ? Math.min(...vals) : null;
}

function QuestionDetail({ question }: { question: QCoreStudentQuestion }) {
  const materialNorm = normText(
    question.content.materials
      .map((m) => m.blocks.map((b) => (b.kind === "text" ? b.text : "")).join(" "))
      .join(" "),
  );

  const renderBody = (b: QCoreBody) => {
    const stemText = normText(
      b.stemBlocks.map((x) => (x.kind === "text" ? x.text : "")).join(" "),
    );
    // 空父卡（stem 全空且无选项）不渲染；含图片/表格的父卡必须保留
    // （AF2-C/Q16：只带图的父卡曾被此分支丢弃 → 图片"缺失"）。
    const hasVisual = b.stemBlocks.some((x) => (x.kind === "text" ? x.text.trim() !== "" : true));
    if (!hasVisual && b.options.length === 0) return null;
    const allSingleText = b.options.every((o) => o.blocks.length === 1 && o.blocks[0].kind === "text");
    // 子问句与材料重复（完形类）→ 题号+选项行；否则完整卡片
    const passageEmbedded =
      Boolean(b.parentQuestionRef) &&
      b.options.length > 0 &&
      allSingleText &&
      stemText !== "" &&
      materialNorm.includes(stemText);
    if (passageEmbedded) return <CompactOptionRow key={b.localId} body={b} />;
    return <BodyView key={b.localId} body={b} />;
  };

  const renderMaterial = (m: QCoreMaterial) => (
    <div key={m.materialId} className="border rounded p-2 my-1 bg-amber-50/40">
      {/* AF7：材料块走 InlineBlocks（与 BodyView 同一渲染口），否则 AF6/AF7
          行内规则在学生页材料上不生效（此前材料是唯一漏接的渲染口）。 */}
      <InlineBlocks blocks={m.blocks} />
    </div>
  );

  // AF2-C：带顺序元数据（验收通道）→ 按源行序合并 materials/bodies，
  // 修复 materials-first 错位（Q19 (1)-(3) 应在步骤材料前；语文材料在题目要求后）。
  // 无元数据（正式通道）→ 保持 materials-first，行为不变。
  const mats = question.content.materials;
  const bodies = question.content.bodies;
  const hasOrder =
    mats.some((m) => m.lineStart != null) || bodies.some((b) => b.lineStart != null);

  let orderedContent: ReactNode;
  if (hasOrder) {
    const items = [
      ...mats.map((m) => ({
        key: `m-${m.materialId}`,
        sort: m.lineStart ?? segLineStart(m.blocks),
        tie: 0,
        node: renderMaterial(m),
      })),
      ...bodies.map((b) => ({
        key: `b-${b.localId}`,
        sort: b.lineStart ?? segLineStart(b.stemBlocks),
        tie: 1,
        node: renderBody(b),
      })),
    ];
    items.sort((x, y) => {
      const lx = x.sort ?? Number.MAX_SAFE_INTEGER;
      const ly = y.sort ?? Number.MAX_SAFE_INTEGER;
      return lx !== ly ? lx - ly : x.tie - y.tie;
    });
    orderedContent = items.map((it) => (
      <div key={it.key}>{it.node}</div>
    ));
  } else {
    orderedContent = (
      <>
        {mats.length > 0 && (
          <div className="mt-3">
            <div className="text-sm font-medium mb-1">共享材料（{mats.length}）</div>
            {mats.map(renderMaterial)}
          </div>
        )}
        <div className="mt-2">{bodies.map(renderBody)}</div>
      </>
    );
  }

  return (
    <div className="mt-4">
      {orderedContent}
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
        <div className="mb-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          验收候选环境（隔离数据源）：{apiBase} — 非正式题库，验收用途。
        </div>
      )}
      <h1 className="text-lg font-semibold mb-1">Question Core · 学生题目（只读）</h1>
      <p className="text-xs text-gray-500 mb-3">
        {apiBase
          ? "数据源：隔离验收候选读取通道（含未发布/未完成候选，供 Owner 目视验收）；答案/解析按可见性保护，经逐题预览核对。"
          : "数据源：Question Core Student API（已审核发布内容）；展示层只做 contract 映射，不做二次加工。"}
      </p>
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
      <div className="space-y-1">
        {(list ?? []).map((q) => (
          <button
            key={q.questionId}
            onClick={() => void open(q.questionId)}
            className="w-full text-left border rounded px-3 py-2 hover:bg-slate-50"
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
                    ? "bg-emerald-100 text-emerald-800"
                    : "bg-amber-100 text-amber-800"
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
