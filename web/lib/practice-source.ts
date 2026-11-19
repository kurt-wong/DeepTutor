/**
 * B-2 Spike — Practice 题源接口（Question Provider 缝）。
 *
 * 原生 Practice 生命周期（队列→作答→自检→评分复习）对题源保持无知；
 * notebook 旧题库与 QCore Student API 各自实现同一组操作。QCore 题目内容
 * 只经内存流转，绝不写入 notebook_entries 或任何 DT 自有题库。
 */
import type { PracticeRating } from "@/lib/practice-api";

export type PracticeSourceRef =
  | { kind: "notebook"; entryId: number; workspaceId?: string }
  | { kind: "qcore"; questionId: string; revisionId: string };

export interface QcReviewResult {
  due_at: number;
  version: number;
  rating: PracticeRating;
  is_mistake: boolean;
  /** 恒为 null：review_only 下显式「已作答/未判分」，绝不伪造对错。 */
  correct: null;
  graded: false;
}

export function refKey(ref: PracticeSourceRef): string {
  return ref.kind === "notebook"
    ? `nb:${ref.workspaceId ?? ""}:${ref.entryId}`
    : `qc:${ref.questionId}:${ref.revisionId}`;
}
