"use client";

// EULER-STYLE-INTERACTIVE-LESSON-PILOT-01 — student entry.
// 拍照 → OCR证据 → QCore 候选 → 确认 → Teaching Bundle → Interactive Lesson。
// 本页只做编排：题目事实全部来自 QCore published Revision；页面不写题库、不判分。

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import {
  COMPILER_BASE,
  CompilerError,
  fetchBundle,
  searchPhoto,
  type SearchCandidate,
  type SearchResult,
  type TeachingBundle,
} from "@/lib/qcore-teach/client";
import { askTutor, type FollowUpContext } from "@/components/qcore/LessonTurnAdapter";
import MarkdownRenderer from "@/components/common/MarkdownRenderer";

type Phase = "idle" | "searching" | "candidates" | "lesson";

interface FollowUpEntry {
  id: string;
  stepId: string;
  question: string;
  answer: string;
  status: "pending" | "streaming" | "done" | "error";
  error?: string;
}

interface LessonStepState {
  step_id: string;
  index: number;
  total: number;
  goal?: string;
}

function decisionStyle(decision: SearchResult["decision"]): string {
  switch (decision) {
    case "high_confidence":
      return "border-emerald-300 bg-emerald-50 text-emerald-800";
    case "ambiguous":
      return "border-amber-300 bg-amber-50 text-amber-900";
    case "low_confidence":
    case "no_match":
      return "border-rose-300 bg-rose-50 text-rose-800";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function decisionLabel(decision: SearchResult["decision"]): string {
  switch (decision) {
    case "high_confidence":
      return "高置信匹配";
    case "ambiguous":
      return "需要确认";
    case "low_confidence":
      return "低置信";
    case "no_match":
      return "未找到";
    case "ocr_failed":
      return "OCR 不可用";
    default:
      return decision;
  }
}

function buildTutorQuestion(bundle: TeachingBundle): string {
  const read = bundle.script.steps[0];
  const readText = read.board
    .map((block) => block.text ?? block.latex ?? "")
    .filter(Boolean)
    .join("\n");
  const explanation = bundle.script.steps
    .slice(1)
    .map((step) => `${step.step_id} ${step.goal}：${step.speech}`)
    .join("\n");
  return [
    "题干与选项（QCore revision 原文）：",
    readText.slice(0, 1600),
    "",
    "官方解析（TeachingScript 已绑定来源）：",
    explanation.slice(0, 1600),
    "",
    `标准答案：${bundle.script.final_answer.display}`,
  ].join("\n");
}

export function QCoreTeachPage() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [search, setSearch] = useState<SearchResult | null>(null);
  const [selected, setSelected] = useState<SearchCandidate | null>(null);
  const [bundle, setBundle] = useState<TeachingBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [step, setStep] = useState<LessonStepState | null>(null);
  const [completed, setCompleted] = useState(false);
  const [followUps, setFollowUps] = useState<FollowUpEntry[]>([]);
  const [followUpText, setFollowUpText] = useState("");
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const questionContext = useRef<string>("");
  const turnSessionRef = useRef<string | null>(null);

  useEffect(() => {
    setCompleted(false);
  }, [bundle?.revision_id]);

  const runSearch = useCallback(async (file: File) => {
    setError(null);
    setSearch(null);
    setSelected(null);
    setBundle(null);
    setPhase("searching");
    setPreview(file.type.startsWith("image/") ? URL.createObjectURL(file) : null);
    try {
      const result = await searchPhoto(file);
      setSearch(result);
      setPhase("candidates");
      if (result.decision === "ocr_failed") {
        setError(result.message || "OCR 服务不可用");
      }
    } catch (err) {
      setPhase("idle");
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const onFile = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) void runSearch(file);
    },
    [runSearch],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (file) void runSearch(file);
    },
    [runSearch],
  );

  const startLesson = useCallback(async (candidate: SearchCandidate) => {
    setSelected(candidate);
    setError(null);
    try {
      const loaded = await fetchBundle(candidate.question_id, candidate.revision_id);
      if (loaded.script.validation.status !== "pass") {
        const failed = loaded.script.validation.checks
          .filter((check) => check.status === "fail")
          .map((check) => check.name)
          .join(", ");
        throw new Error(`TeachingScript 未通过校验：${failed}`);
      }
      if (!loaded.lesson_url) {
        throw new Error("未获得讲题访问令牌（lesson_url 缺失），已拒绝进入播放。");
      }
      questionContext.current = buildTutorQuestion(loaded);
      turnSessionRef.current = null;
      setBundle(loaded);
      setStep({
        step_id: loaded.script.steps[0].step_id,
        index: 0,
        total: loaded.script.steps.length,
        goal: loaded.script.steps[0].goal,
      });
      setFollowUps([]);
      setPhase("lesson");
    } catch (err) {
      if (err instanceof CompilerError && err.status === 409) {
        setError("该题已有新的 published revision，请重新拍照检索后再进入讲题。");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, []);

  const sendStepCommand = useCallback((type: "play" | "pause" | "goto_step", stepId?: string) => {
    frameRef.current?.contentWindow?.postMessage(
      type === "goto_step"
        ? { source: "deeptutor", type, payload: { step_id: stepId } }
        : { source: "deeptutor", type },
      "*",
    );
  }, []);

  const handleFollowUp = useCallback(
    async (payload: FollowUpContext & { question?: string }) => {
      if (!bundle) return;
      const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const question = (payload.question ?? followUpText).trim() || "为什么这一步要这样做？";
      setFollowUps((prev) => [
        ...prev,
        { id, stepId: payload.step_id, question, answer: "", status: "pending" },
      ]);
      setFollowUpText("");
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const result = await askTutor(
          {
            ...payload,
            question,
            title: bundle.script.title,
          },
          questionContext.current,
          {
            signal: controller.signal,
            sessionId: turnSessionRef.current,
            onDelta: (text) => {
              setFollowUps((prev) =>
                prev.map((entry) =>
                  entry.id === id ? { ...entry, answer: text, status: "streaming" } : entry,
                ),
              );
            },
          },
        );
        setFollowUps((prev) =>
          prev.map((entry) =>
            entry.id === id ? { ...entry, answer: result.text, status: "done" } : entry,
          ),
        );
        if (result.sessionId) turnSessionRef.current = result.sessionId;
        frameRef.current?.contentWindow?.postMessage(
          { source: "deeptutor", type: "followup_answer", payload: { text: result.text } },
          "*",
        );
      } catch (err) {
        setFollowUps((prev) =>
          prev.map((entry) =>
            entry.id === id
              ? {
                  ...entry,
                  status: "error",
                  error: err instanceof Error ? err.message : String(err),
                }
              : entry,
          ),
        );
      } finally {
        abortRef.current = null;
      }
    },
    [bundle, followUpText],
  );

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data as
        | { source?: string; type?: string; payload?: Record<string, unknown> }
        | undefined;
      if (!data || data.source !== "interactive-lesson") return;
      if (data.type === "step_change" && data.payload) {
        const payload = data.payload;
        setStep({
          step_id: String(payload.step_id ?? ""),
          index: Number(payload.index ?? 0),
          total: Number(payload.total ?? bundle?.script.steps.length ?? 0),
          goal: typeof payload.goal === "string" ? payload.goal : undefined,
        });
      } else if (data.type === "completed") {
        setCompleted(true);
      } else if (data.type === "followup_request" && data.payload) {
        void handleFollowUp(data.payload as unknown as FollowUpContext);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [bundle, handleFollowUp]);

  const reset = () => {
    abortRef.current?.abort();
    setPhase("idle");
    setSearch(null);
    setSelected(null);
    setBundle(null);
    setStep(null);
    setFollowUps([]);
    setError(null);
    setPreview(null);
    turnSessionRef.current = null;
  };

  const candidates = search?.candidates ?? [];
  const teachAllowed =
    search?.decision === "high_confidence" || search?.decision === "ambiguous";

  return (
    <div className="h-full w-full overflow-y-auto" data-testid="teach-page">
      <div className="mx-auto max-w-6xl p-4">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold">拍照讲题 · Question Core → TeachingScript → Interactive Lesson</h1>
            <p className="text-xs text-gray-500">
              题目事实只来自 Question Core 已发布 Revision；OCR 与匹配结果仅作为检索证据，不会改写题目。
            </p>
          </div>
          <div className="text-[11px] text-gray-400 font-mono">
            compiler {COMPILER_BASE}
          </div>
        </div>

        {error && (
          <div
            data-testid="teach-error"
            className="mb-3 rounded border border-rose-300 bg-rose-50 p-2 text-sm text-rose-800"
          >
            {error}
          </div>
        )}

        {phase === "idle" && (
          <div
            data-testid="teach-upload"
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`rounded-lg border-2 border-dashed p-8 text-center transition ${
              dragging ? "border-foreground bg-muted/60" : "border-border bg-muted/20"
            }`}
          >
            <p className="text-sm font-medium">上传或拍摄一道数学题</p>
            <p className="mt-1 text-xs text-gray-500">
              支持 JPG / PNG / WebP / PDF；图片会先做 OCR，再在 QCore 已发布题目中检索。
            </p>
            <label className="mt-4 inline-flex cursor-pointer items-center rounded bg-foreground px-4 py-2 text-sm text-background">
              选择图片 / 拍照
              <input
                data-testid="teach-file-input"
                type="file"
                accept="image/*,application/pdf"
                capture="environment"
                className="hidden"
                onChange={onFile}
              />
            </label>
            {preview && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="待识别题目" className="mx-auto mt-4 max-h-60 rounded border" />
            )}
          </div>
        )}

        {phase === "searching" && (
          <div data-testid="teach-searching" className="rounded border p-6 text-sm">
            <div className="flex items-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-foreground border-t-transparent" />
              OCR 识别中（PaddleOCR-VL）… 随后在 QCore 已发布题目中做候选检索。
            </div>
            {preview && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="待识别题目" className="mt-4 max-h-56 rounded border" />
            )}
          </div>
        )}

        {phase === "candidates" && search && (
          <div data-testid="teach-candidates" className="space-y-3">
            <div className={`rounded border p-3 text-sm ${decisionStyle(search.decision)}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded px-2 py-0.5 text-xs font-medium">
                  {decisionLabel(search.decision)}
                </span>
                <span>{search.message}</span>
                {search.decision_reason && (
                  <span className="text-xs opacity-70">（{search.decision_reason}）</span>
                )}
              </div>
              <div className="mt-1 text-xs opacity-70">
                {search.llm?.enabled
                  ? `LLM 匹配判定：${search.llm.status}`
                  : "LLM 匹配判定：关闭（仅文本/结构检索）"}
                {search.ocr?.engine ? ` · OCR：${search.ocr.engine}` : ""}
                {search.ocr?.duration_s ? ` · ${search.ocr.duration_s}s` : ""}
              </div>
            </div>

            {search.ocr?.text && (
              <details className="rounded border bg-muted/20 p-2 text-xs">
                <summary className="cursor-pointer text-gray-600">
                  OCR 识别文本（检索证据，仅用于匹配）
                </summary>
                <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-[11px] leading-5 text-gray-700">
                  {search.ocr.text}
                </pre>
              </details>
            )}

            <div className="space-y-2">
              {candidates.length === 0 && (
                <div className="rounded border p-4 text-sm text-gray-600">
                  未找到可靠的 QCore 题目。请调整光线/角度后重新拍摄，或换一道题。
                </div>
              )}
              {candidates.map((candidate, index) => {
                const disabled = !teachAllowed;
                return (
                  <div
                    key={candidate.question_id}
                    className={`rounded border p-3 ${
                      index === 0 ? "border-foreground/40" : "border-border"
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          <span>#{candidate.printed_number ?? "?"}</span>
                          <span className="truncate">{candidate.title}</span>
                        </div>
                        <div className="mt-1 text-xs text-gray-500">
                          {candidate.source_document_id ?? "未知来源"} ·{" "}
                          {candidate.question_type ?? "未知题型"} ·{" "}
                          {candidate.question_id.slice(0, 8)} / rev{" "}
                          {candidate.revision_id.slice(0, 8)}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
                          {(candidate.match_evidence ?? []).map((evidence) => (
                            <span
                              key={`${candidate.question_id}-${evidence.type}-${evidence.value}`}
                              className="rounded bg-muted px-1.5 py-0.5 text-gray-700"
                            >
                              {evidence.type}: {evidence.value}
                            </span>
                          ))}
                          {candidate.has_image && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-gray-700">含图</span>
                          )}
                          {candidate.has_table && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-gray-700">含表格</span>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-sm">{candidate.score.toFixed(3)}</div>
                        <button
                          type="button"
                          data-testid={`teach-start-${index}`}
                          disabled={disabled}
                          onClick={() => void startLesson(candidate)}
                          className="mt-1 rounded bg-foreground px-3 py-1.5 text-xs text-background disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          进入讲题
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center gap-2 text-xs text-gray-500">
              <button type="button" onClick={reset} className="rounded border px-3 py-1.5">
                重新拍照
              </button>
              {search.decision === "low_confidence" && (
                <span>低置信结果不提供“进入讲题”，以免把错误题目当作事实。</span>
              )}
            </div>
          </div>
        )}

        {phase === "lesson" && bundle && selected && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-muted px-2 py-0.5 font-mono">
                  QCore {bundle.question_id.slice(0, 8)} / rev {bundle.revision_number}
                </span>
                <span>{bundle.question.source_document_id}</span>
                <span>#{bundle.question.printed_number}</span>
                <span className="text-gray-500">{bundle.script.steps.length} 步</span>
                {completed && <span className="text-emerald-700">已播放完成</span>}
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => sendStepCommand("play")} className="rounded border px-2 py-1">
                  播放
                </button>
                <button type="button" onClick={() => sendStepCommand("pause")} className="rounded border px-2 py-1">
                  暂停
                </button>
                <button type="button" onClick={reset} className="rounded border px-2 py-1">
                  换一道题
                </button>
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div className="overflow-hidden rounded border">
                <iframe
                  ref={frameRef}
                  data-testid="teach-lesson-frame"
                  title="Interactive Lesson"
                  src={bundle.lesson_url}
                  className="h-[70vh] min-h-[520px] w-full bg-white"
                />
              </div>

              <div className="space-y-3">
                <div className="rounded border p-2">
                  <div className="mb-1 text-xs font-medium text-gray-600">教学步骤</div>
                  <ol data-testid="teach-step-list" className="space-y-1">
                    {bundle.script.steps.map((item, index) => {
                      const active = step?.step_id === item.step_id;
                      return (
                        <li key={item.step_id}>
                          <button
                            type="button"
                            onClick={() => sendStepCommand("goto_step", item.step_id)}
                            className={`w-full rounded px-2 py-1 text-left text-xs ${
                              active ? "bg-foreground text-background" : "hover:bg-muted"
                            }`}
                          >
                            <span className="mr-1 font-mono">{index + 1}.</span>
                            {item.goal}
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </div>

                <div className="rounded border p-2">
                  <div className="mb-1 flex items-center justify-between text-xs font-medium text-gray-600">
                    <span>追问这一步</span>
                    <span className="text-[10px] font-normal text-gray-400">
                      DeepTutor Turn · 只带当前步骤上下文
                    </span>
                  </div>
                  <div className="max-h-64 space-y-2 overflow-y-auto">
                    {followUps.length === 0 && (
                      <p className="text-[11px] text-gray-500">
                        例如：“为什么这里要先求导？”回答只依据该题 QCore 官方解析。
                      </p>
                    )}
                    {followUps.map((entry) => (
                      <div
                        key={entry.id}
                        data-testid="teach-followup-entry"
                        data-status={entry.status}
                        className="rounded bg-muted/40 p-2 text-[11px]"
                      >                        <div className="font-medium">
                          [{entry.stepId}] {entry.question}
                        </div>
                        <div className="mt-1 text-gray-700">
                          {entry.answer ? (
                            <MarkdownRenderer content={entry.answer} className="text-[11px]" />
                          ) : entry.status === "pending" ? (
                            "等待 DeepTutor 回答…"
                          ) : (
                            ""
                          )}
                        </div>
                        {entry.status === "error" && (
                          <div className="mt-1 text-rose-700">
                            追问通道不可用：{entry.error}
                            <div className="text-[10px] text-gray-500">
                              上下文已保留；可稍后重试，或等待 Turn 适配接入。
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex gap-1">
                    <input
                      data-testid="teach-followup-input"
                      value={followUpText}
                      onChange={(event) => setFollowUpText(event.target.value)}
                      placeholder="追问当前步骤…"
                      className="min-w-0 flex-1 rounded border px-2 py-1 text-xs"
                    />
                    <button
                      type="button"
                      data-testid="teach-followup-send"
                      disabled={!followUpText.trim()}
                      onClick={() => {
                        const current = step?.step_id ?? bundle.script.steps[0].step_id;
                        const api = frameRef.current?.contentWindow;
                        if (api) {
                          api.postMessage(
                            { source: "deeptutor", type: "followup_question", payload: { text: followUpText } },
                            "*",
                          );
                        }
                        const stepInfo =
                          bundle.script.steps.find((item) => item.step_id === current) ??
                          bundle.script.steps[0];
                        void handleFollowUp({
                          question_id: bundle.question_id,
                          revision_id: bundle.revision_id,
                          step_id: stepInfo.step_id,
                          step_goal: stepInfo.goal,
                          speech: stepInfo.speech,
                          source_refs: stepInfo.source_refs,
                          question: followUpText,
                        });
                      }}
                      className="rounded bg-foreground px-2 py-1 text-xs text-background disabled:opacity-40"
                    >
                      发送
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
