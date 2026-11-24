// Read-only client for the Teaching Script Compiler (pilot service :8820).
// No QCore write path exists here: the compiler only serves published revisions.

import { apiFetch } from "@/shared/api/client";

export interface MatchEvidence {
  type: "number" | "text" | "formula" | string;
  value: string;
}

export interface SearchCandidate {
  question_id: string;
  revision_id: string;
  score: number;
  score_parts: Record<string, number | null>;
  match_evidence: MatchEvidence[];
  source_document_id: string | null;
  printed_number: string | null;
  question_type: string | null;
  title: string;
  has_image: boolean;
  has_table: boolean;
  llm: { match: number; verdict: string } | null;
  needs_confirmation: boolean;
}

export type SearchDecision =
  | "high_confidence"
  | "ambiguous"
  | "low_confidence"
  | "no_match"
  | "ocr_failed";

export interface SearchResult {
  search_id: string;
  decision: SearchDecision;
  requires_confirmation: boolean;
  may_teach: boolean;
  message: string;
  decision_reason?: string;
  candidates: SearchCandidate[];
  ocr?: {
    status: string;
    engine?: string;
    pages?: number;
    duration_s?: number;
    job_id?: string;
    text?: string;
  };
  llm?: { enabled: boolean; status: string; error: string | null };
}

export interface BoardBlock {
  id: string;
  kind: string;
  ref?: string;
  text?: string;
  latex?: string;
  asset_id?: string;
  alt?: string;
  url?: string | null;
  rows?: string[][];
  tone?: string;
  label?: string;
  width?: number;
}

export interface Step {
  step_id: string;
  goal: string;
  source_refs: string[];
  board: BoardBlock[];
  speech: string;
  subtitle: string;
  duration_ms: number;
  effects: { at_ms: number; type: string; target: string; duration_ms?: number }[];
}

export interface TeachingScript {
  script_id: string;
  question_id: string;
  revision_id: string;
  revision_number: number;
  question_type: string;
  title: string;
  final_answer: { display: string; value: string; answer_type: string };
  steps: Step[];
  validation: { status: string; checks: { name: string; status: string; detail?: string }[] };
}

export interface TeachingBundle {
  question_id: string;
  revision_id: string;
  revision_number: number;
  language: string;
  init_step: string;
  question: {
    subject: string;
    source_document_id: string;
    printed_number: string | null;
    question_type: string;
    title: string;
    content_hash: string;
  };
  script: TeachingScript;
  /** Server-minted lesson URL containing the short-lived access token. */
  lesson_url?: string;
  access_token_expires_at?: number | null;
}

export const COMPILER_BASE =
  process.env.NEXT_PUBLIC_TSC_BASE ?? "http://127.0.0.1:8820";
export const LESSON_BASE =
  process.env.NEXT_PUBLIC_LESSON_BASE ?? "http://127.0.0.1:8821";

export class CompilerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CompilerError";
  }
}

async function parseError(response: Response): Promise<CompilerError> {
  let message = `compiler HTTP ${response.status}`;
  let code: string | undefined;
  try {
    const body = (await response.json()) as {
      detail?: string | { code?: string; message?: string };
    };
    if (typeof body.detail === "string") message = body.detail;
    else if (body.detail?.message) {
      message = body.detail.message;
      code = body.detail.code;
    }
  } catch {
    // keep the status message
  }
  return new CompilerError(message, response.status, code);
}

export interface SearchJob {
  job_id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  stage?: string;
  error?: string;
  result?: SearchResult;
  duration_s?: number;
}

const SEARCH_POLL_MS = 1500;
const SEARCH_TIMEOUT_MS = 300000;

/** Upload once, then poll the same-origin job proxy (no service token in browser). */
export async function searchPhoto(file: File): Promise<SearchResult> {
  const form = new FormData();
  form.append("file", file);
  const created = await apiFetch("/api/qcore-teach/search", {
    method: "POST",
    body: form,
  });
  if (!created.ok) throw await parseError(created);
  const job = (await created.json()) as SearchJob;
  if (!job.job_id) throw new CompilerError("拍照检索未返回 job id", 502);

  const startedAt = Date.now();
  let last: SearchJob = job;
  while (Date.now() - startedAt < SEARCH_TIMEOUT_MS) {
    const response = await apiFetch(
      `/api/qcore-teach/jobs/${encodeURIComponent(job.job_id)}`,
    );
    if (!response.ok) throw await parseError(response);
    last = (await response.json()) as SearchJob;
    if (last.status === "succeeded" && last.result) return last.result;
    if (last.status === "failed") {
      return {
        search_id: job.job_id,
        decision: "ocr_failed",
        requires_confirmation: true,
        may_teach: false,
        message: last.error || "OCR 服务未能返回可用文本，本轮不进入题目匹配。",
        candidates: [],
      } as SearchResult;
    }
    await new Promise((resolve) => setTimeout(resolve, SEARCH_POLL_MS));
  }
  throw new CompilerError("拍照检索超时（5 分钟），请重试", 504);
}

export async function fetchBundle(
  questionId: string,
  revisionId: string,
): Promise<TeachingBundle> {
  const params = new URLSearchParams({ question_id: questionId, revision_id: revisionId });
  const response = await apiFetch(`/api/qcore-teach/bundle?${params.toString()}`);
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as TeachingBundle;
}
