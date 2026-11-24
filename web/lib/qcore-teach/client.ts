// Read-only client for the Teaching Script Compiler (pilot service :8820).
// No QCore write path exists here: the compiler only serves published revisions.

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

export async function searchPhoto(file: File): Promise<SearchResult> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${COMPILER_BASE}/api/search/photo`, {
    method: "POST",
    body: form,
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as SearchResult;
  if (!response.ok) {
    if (body.decision === "ocr_failed") return body;
    throw await parseError(response);
  }
  return body;
}

export async function fetchBundle(
  questionId: string,
  revisionId: string,
): Promise<TeachingBundle> {
  const url = `${COMPILER_BASE}/api/teaching-bundles/${encodeURIComponent(
    questionId,
  )}?revision_id=${encodeURIComponent(revisionId)}&language=zh-CN`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as TeachingBundle;
}

export function lessonUrl(questionId: string, revisionId: string): string {
  const params = new URLSearchParams({
    question_id: questionId,
    revision_id: revisionId,
    api: COMPILER_BASE,
  });
  return `${LESSON_BASE}/?${params.toString()}`;
}
