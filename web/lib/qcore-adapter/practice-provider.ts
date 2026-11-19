// B-2 Spike → C1 阶段1 正式化 — QCore Practice 数据通道（Question Provider）。
// 契约（QCORE-STUDENT-PHASE-C1 §1.1）：
//   · 题目列表/详情**唯一来源**= QC Student API（经 :8002 同源代理 → :8811）；
//   · 题目身份**唯一来源**= API 响应的 question_id/revision_id；
//   · `qid-map-g4.json` 仅辅助展示索引（卷/学科/印刷号），非身份/正文事实源，
//     可由 gen_qcore_g4_maps.py 从 qcore_g4_final_01 确定性重建；
//   · `asset-map-g4.json` 同源再生（C1 白名单派生）；未入映射资产不构造 URL；
//   · 404/未发布（QcNotFoundError）与网络失败（QcUnavailableError）严格区分，
//     不得转空对象成功、不得生成占位题；
//   · 题目内容零复制（不写 notebook_entries 或任何 DT 自有题库表）。
// 复习状态：DT 后端 practice/qcore/*（键=question_id+revision_id，无题面/参考答案列）。
import { apiFetch, apiUrl } from "@/lib/api";
import { fetchQuestionDetail, qidMap, type QidMapEntry } from "./client";
import type { QCoreStudentQuestion } from "./types";
import type { QcReviewResult } from "@/lib/practice-source";

const ROOT = "/api/question-notebook/practice/qcore";

export interface QcPracticeState {
  version: number;
  review_count: number;
  is_mistake: boolean;
  due_at: number | null;
}

export interface QcPracticeQuestion {
  question: QCoreStudentQuestion;
  state: QcPracticeState;
  identity: QidMapEntry | null;
}

/** 发布集清单：来自 Student API 列表（published-only 服务端执行）。
 *  每次调用即取即用——无静态题号名单；发布集变化（新增/撤销）以 API 结果为准。 */
export async function listQcorePracticeRefs(): Promise<
  { questionId: string; revisionId: string }[]
> {
  const { fetchQuestionList } = await import("./client");
  const list = await fetchQuestionList();
  return list.map((q) => ({ questionId: q.questionId, revisionId: q.revisionId }));
}

export async function loadQcorePracticeQuestion(
  questionId: string,
  revisionId: string,
): Promise<QcPracticeQuestion> {
  const detail = await fetchQuestionDetail(questionId);
  const res = await apiFetch(
    apiUrl(`${ROOT}/state/${encodeURIComponent(questionId)}?revision_id=${encodeURIComponent(revisionId)}`),
    { cache: "no-store" },
  );
  const state = (await res.json()) as Partial<QcPracticeState>;
  return {
    question: detail.question,
    state: {
      version: state.version ?? 0,
      review_count: state.review_count ?? 0,
      is_mistake: Boolean(state.is_mistake),
      due_at: state.due_at ?? null,
    },
    identity: qidMap[questionId] ?? null,
  };
}

export async function reviewQcorePractice(
  ref: { questionId: string; revisionId: string },
  payload: {
    request_id: string;
    version: number;
    rating: QcReviewResult["rating"];
    answer: string;
  },
): Promise<QcReviewResult> {
  const res = await apiFetch(apiUrl(`${ROOT}/review`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: payload.request_id,
      question_id: ref.questionId,
      revision_id: ref.revisionId,
      version: payload.version,
      rating: payload.rating,
      answer: payload.answer,
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string };
    const err = new Error(body.detail ?? `qcore review failed: ${res.status}`) as Error & {
      status?: number;
    };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as QcReviewResult;
}
