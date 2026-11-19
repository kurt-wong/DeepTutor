// QCORE-DEEPTUTOR-STUDENT-INTEGRATION-01 — Read Adapter types.
// 规则：Student API 返回什么结构，就按 contract 映射什么结构。
// 不压平 composite、不合并 body、不解释 answer_value 内部语义、不生成事实。

export type QCoreBlock =
  | { kind: "text"; text: string; lineStart?: number | null; lineEnd?: number | null }
  | {
      kind: "image";
      assetId: string;
      altText: string | null;
      url: string | null;
      lineStart?: number | null;
      lineEnd?: number | null;
    }
  | {
      kind: "table";
      nRows: number;
      nCols: number;
      cells: { row: number; col: number; content: string }[];
      lineStart?: number | null;
      lineEnd?: number | null;
    }
  // 其余块（math/chemical/material_ref 等）：API 当前只回 kind（内容被 _block_public 剥除），
  // 原样保留 raw，不推断、不补全、不改写。已登记缺口，见 00/交付报告。
  | { kind: "other"; apiKind: string; raw: Record<string, unknown> };

export interface QCoreOption {
  label: string;
  blocks: QCoreBlock[];
}

export interface QCoreBody {
  localId: string;
  questionType: string;
  printedNumber: string | null;
  stemBlocks: QCoreBlock[];
  options: QCoreOption[];
  parentQuestionRef: string | null;
  subQuestionIds: string[];
  /** AF2-C 顺序元数据（验收通道带；正式通道无 → 渲染层回退 materials-first）。 */
  materialIds?: string[];
  lineStart?: number | null;
}

export interface QCoreMaterial {
  materialId: string;
  blocks: QCoreBlock[];
  lineStart?: number | null;
  lineEnd?: number | null;
}

export interface QCoreAsset {
  assetId: string;
  storagePath: string;
  mimeType: string;
  url: string | null;
}

export interface QCoreStudentQuestion {
  questionId: string;
  revisionId: string;
  revisionNumber: number;
  questionType: string;
  content: {
    bodies: QCoreBody[];
    materials: QCoreMaterial[];
    assets: QCoreAsset[];
  };
  answerVisible: boolean;
  explanationVisible: boolean;
  answers: unknown[];
  answersNote: string | null;
  explanationBlocks: QCoreBlock[];
  explanationNote: string | null;
}

export interface QCoreListEntry {
  questionId: string;
  revisionId: string;
  printedNumber: string | null;
  section: string | null;
  questionType: string;
  /** PBA-R1：验收候选元数据（正式 Student API 列表不带，候选通道带）。 */
  admissionReview?: string | null;
  admissionCompleteness?: string | null;
  publicationState?: string | null;
  sourceDocumentId?: string | null;
}

export interface QCoreMappingReport {
  questionId: string;
  notes: string[];
}
