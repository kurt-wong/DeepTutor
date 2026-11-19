// QCORE-DEEPTUTOR-STUDENT-INTEGRATION-01 — Read Adapter client.
// 只读消费 Question Core Student API（HTTP）。字段映射 + 结构保持，无 LLM、无 OCR、
// 无切题、无题型推断、无答案重抽、无解析重生成。旧题目摄入链不在此通路中。
import assetMapJson from "./asset-map-g4.json";
import qidMapJson from "./qid-map-g4.json";
import type {
  QCoreBlock,
  QCoreBody,
  QCoreListEntry,
  QCoreMappingReport,
  QCoreMaterial,
  QCoreOption,
  QCoreStudentQuestion,
} from "./types";

// 浏览器默认走**同源相对代理路径**（Next proxy → DT 后端 :8002 → :8811 Student API）。
// 8811 仍是唯一题目数据源；8002 仅同源代理；8812 为唯一图片服务。
// 不再依赖未声明的 NEXT_PUBLIC_QCORE_API_BASE 才能运行（干净启动可复现）；
// 该 env 仍可用于测试/独立部署覆盖。
export const QCORE_API_BASE =
  process.env.NEXT_PUBLIC_QCORE_API_BASE ?? "/api/question-notebook/practice/qcore/proxy";
export const QCORE_ASSET_BASE =
  process.env.NEXT_PUBLIC_QCORE_ASSET_BASE ?? "http://127.0.0.1:8812";

// 资产 URL 权威= C1 白名单映射（asset_id → <subject>/imgs/<file>，:8812 形态）。
// 旧 volume-map（qcore_student_integration_01，38 条旧 ID，9 个 G4 qid 命中 0）
// 不再参与路径推断。未入映射的资产一律不构造 URL（显示未解析）。
const assetMap: Record<string, { url_path: string; content_hash: string }> = (
  assetMapJson as { entries: Record<string, { url_path: string; content_hash: string }> }
).entries;

// qid → {subject, source_document_id, printed_number, revision_id, published}
// 权威= qcore_g4_final_01.qcore_question_instances（DB 生成，非旧 volume-map 猜测）。
export interface QidMapEntry {
  source_document_id: string;
  subject: string;
  printed_number: string | null;
  revision_id: string;
  published: boolean;
}
export const qidMap: Record<string, QidMapEntry> = (
  qidMapJson as { entries: Record<string, QidMapEntry> }
).entries;

/**
 * 展示层定界符收紧：`$ ... $`（定界符内缘空格）→ `$...$`。
 * 管线的 MATH_SPAN_RE 只认紧贴定界符，空格包裹的公式会被当作杂散美元符
 * 转义、内层被裸 LaTeX 半渲染（出现"$ 11 $"式美元符泄漏）。语料实测
 * （qcore_student_integration_01 全量文本块）：空格包裹的 $..$ 共约 160 处
 * 全部为数学/化学式，故一律收紧；不改任何非空白字符，`$$..$$` 不受影响。
 */
function tightenMathDelimiters(text: string): string {
  return text.replace(/\$ +([^$\n]+?) +\$/g, (_whole, body: string) =>
    body.trim() ? `$${body.trim()}$` : _whole,
  );
}

/**
 * 展示层滤分页伪影：源 PDF 分页处在文本流中是 "---" 标记行（独行块或内嵌
 * 于段落尾/头），Markdown 会渲染成 <hr>。整篇材料连续阅读无需分页线；
 * 仅剥除"整行只有横线"的行，其余内容零改动。
 */
function stripRuleLines(text: string): string {
  return text.replace(/^[ \t]*-{3,}[ \t]*$/gm, "");
}

/**
 * 展示层去重：选项文本自带 "A. " 类标签前缀时剥除（label 字段另行渲染，
 * 否则出现"A. A."式重复）。语料实测 196 个选项中 45 个带前缀、151 个不带，
 * 故仅在前缀+标点确在时剥除，零误伤。仅作用于首个文本块的行首。
 */
function stripOptionLabelPrefix(text: string, label: string): string {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`^\\s*${esc}\\s*[.、．:：)）]\\s*`), "");
}

function assetUrlFor(assetId: string): { url: string | null; note: string | null } {
  // C1 白名单映射精确命中才构造 URL（:8812/<subject>/imgs/<file>）。
  // 未入映射=未授权/未核验资产：不猜路径（旧 volume-map 与卷名拼接均禁止）。
  const entry = assetMap[assetId];
  if (!entry) return { url: null, note: `asset not in C1 whitelist map: ${assetId}` };
  return {
    url: `${QCORE_ASSET_BASE}/${entry.url_path.split("/").map(encodeURIComponent).join("/")}`,
    note: null,
  };
}

/**
 * 展示层实体解码（AF2 C-AF2-3）：OCR 表格/文本携带 &gt;/&lt;/&amp; 等 HTML 实体，
 * Markdown/KaTeX 按字面渲染成「&gt;」残余。仅解码这三个基本实体（&amp; 最后解，
 * 防二次解码）；数据层与内容审计口径不动（源文本保留实体，_traceable 两侧对称）。
 */
function decodeBasicEntities(text: string): string {
  return text.replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
}

/**
 * AF3/Q16 化学式分流（展示层，源文本不动）：
 * - `\ce{…\chemfig{…}…}`（嵌套结构式）→ 整体受控回退：整段以纯文本保留原文
 *   （不交给 KaTeX/mhchem 拆解，避免半渲染）；
 * - `\ce{含 _ 下标的配方}`（如 Cu_x L_y(SiF_6)_z）→ 去 \ce 外壳按纯数学渲染
 *   （KaTeX 原生下标，mhchem 的 phantom-X 构造在该形态下显示压平）；
 * - 其余 `\ce{…}`（CO2/N2 等简单式与反应）→ 保留给 mhchem。
 */
function normalizeChemistryDelimiters(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    // 定位 "$…\ce{…}…$"（允许 $ 前后空格）
    const m = /^\$\s*\\ce\s*\{/.exec(text.slice(i));
    if (!m) {
      out += text[i];
      i += 1;
      continue;
    }
    // 平衡括号扫描 \ce{...}
    let j = i + m[0].length;
    let depth = 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth += 1;
      else if (text[j] === "}") depth -= 1;
      j += 1;
    }
    const body = text.slice(i + m[0].length, j - 1);
    // 闭合 "$"
    let k = j;
    while (k < text.length && /\s/.test(text[k])) k += 1;
    if (text[k] === "$") {
      k += 1;
      if (body.includes("\\chemfig")) out += body.trim();
      else if (/_\s*[{A-Za-z0-9]/.test(body)) out += `$${body}$`;
      else out += text.slice(i, k);
      i = k;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

function mapBlock(questionId: string, raw: Record<string, unknown>, notes: string[]): QCoreBlock {
  const kind = String(raw.kind ?? "");
  // AF2-C 顺序元数据（验收通道带；正式通道无此字段 → undefined，行为不变）。
  const lineMeta = {
    lineStart: (raw.line_start as number | null | undefined) ?? null,
    lineEnd: (raw.line_end as number | null | undefined) ?? null,
  };
  if (kind === "text")
    return {
      kind: "text",
      text: decodeBasicEntities(
        tightenMathDelimiters(normalizeChemistryDelimiters(stripRuleLines(String(raw.text ?? "")))),
      ),
      ...lineMeta,
    };
  if (kind === "image") {
    const assetId = String(raw.asset_id ?? "");
    // R1：API 响应携带 url（候选验收通道）时优先；否则白名单映射。
    const provided = (raw.url as string | null | undefined) || null;
    const { url, note } = provided ? { url: provided, note: null } : assetUrlFor(assetId);
    if (note) notes.push(note);
    return {
      kind: "image",
      assetId,
      altText: (raw.alt_text as string | null | undefined) ?? null,
      url,
      ...lineMeta,
    };
  }
  if (kind === "table") {
    return {
      kind: "table",
      nRows: Number(raw.n_rows ?? 0),
      nCols: Number(raw.n_cols ?? 0),
      cells: ((raw.cells as Record<string, unknown>[]) ?? []).map((c) => ({
        row: Number(c.row_index ?? 0),
        col: Number(c.col_index ?? 0),
        content: decodeBasicEntities(String(c.content ?? "")),
      })),
      ...lineMeta,
    };
  }
  // 其他 kind（math/chemical/material_ref）：API 只回 kind 时 raw 仅 {kind}，原样保留。
  notes.push(`block kind "${kind}" passed through verbatim (Student API content-stripped)`);
  return { kind: "other", apiKind: kind, raw };
}

function mapBlocks(questionId: string, raws: Record<string, unknown>[], notes: string[]): QCoreBlock[] {
  return raws
    .filter((r) => {
      // 展示层滤版式伪影：源 PDF 分页线在文本流中是独行 "---" 块（Markdown
      // 会渲染成 <hr>）。分页对完整材料无意义，不展示；数据层不动。
      if (String(r.kind ?? "") === "text" && /^\s*-{3,}\s*$/.test(String(r.text ?? ""))) {
        return false;
      }
      return true;
    })
    .map((r) => mapBlock(questionId, r, notes));
}

function mapBody(questionId: string, raw: Record<string, unknown>, notes: string[]): QCoreBody {
  return {
    localId: String(raw.local_id ?? ""),
    questionType: String(raw.question_type ?? ""),
    printedNumber: (raw.printed_number as string | null | undefined) ?? null,
    stemBlocks: mapBlocks(questionId, (raw.stem_blocks as Record<string, unknown>[]) ?? [], notes),
    options: ((raw.options as Record<string, unknown>[]) ?? []).map((o): QCoreOption => {
      const label = String(o.label ?? "");
      const blocks = mapBlocks(questionId, (o.blocks as Record<string, unknown>[]) ?? [], notes);
      const idx = blocks.findIndex((b) => b.kind === "text");
      if (idx >= 0) {
        const b = blocks[idx];
        if (b.kind === "text") {
          blocks[idx] = { ...b, text: stripOptionLabelPrefix(b.text, label) };
        }
      }
      return { label, blocks };
    }),
    parentQuestionRef: (raw.parent_question_ref as string | null | undefined) ?? null,
    subQuestionIds: (raw.sub_question_ids as string[] | undefined) ?? [],
    // AF2-C 顺序元数据（验收通道带）。
    materialIds: (raw.material_ids as string[] | undefined) ?? undefined,
    lineStart: (raw.line_start as number | null | undefined) ?? null,
  };
}

function mapMaterial(questionId: string, raw: Record<string, unknown>, notes: string[]): QCoreMaterial {
  return {
    materialId: String(raw.material_id ?? ""),
    blocks: mapBlocks(questionId, (raw.blocks as Record<string, unknown>[]) ?? [], notes),
    lineStart: (raw.line_start as number | null | undefined) ?? null,
    lineEnd: (raw.line_end as number | null | undefined) ?? null,
  };
}

// ---- QCore Student API 错误语义（正式 Provider 契约） -----------------------
// 404/未发布、接口错误、网络失败必须是**明确不同的结果**，不得统一转为空对象，
// 不得把未发布题转换为占位题。
export class QcApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "QcApiError";
  }
}
/** 404 = 未发布 / 不存在：合法的「不可读取」结果，不是系统故障。 */
export class QcNotFoundError extends QcApiError {
  constructor(readonly questionId: string) {
    super(`qcore question not readable (unpublished or missing): ${questionId}`, 404);
    this.name = "QcNotFoundError";
  }
}
/** 网络/代理不可达：与「未发布」严格区分。 */
export class QcUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`qcore student api unreachable: ${String(cause)}`);
    this.name = "QcUnavailableError";
  }
}

async function qcFetch(url: string): Promise<Response> {
  let res: Response;
  try {
    // AF1：验收/正式读取一律禁 HTTP 缓存（DSH 建议）——详情陈旧缓存会渲染
    // 旧 revision 内容，验收比对必须以当前 revision 为准。
    res = await fetch(url, { cache: "no-store" });
  } catch (err) {
    throw new QcUnavailableError(err);
  }
  return res;
}

export async function fetchQuestionList(apiBase?: string): Promise<QCoreListEntry[]> {
  const res = await qcFetch(`${apiBase || QCORE_API_BASE}/student/questions`);
  if (res.status === 404) throw new QcNotFoundError("(list)");
  if (!res.ok) throw new QcApiError(`qcore student api list failed: ${res.status}`, res.status);
  const data = (await res.json()) as { questions: Record<string, unknown>[] };
  return (data.questions ?? []).map((q) => ({
    questionId: String(q.question_id ?? ""),
    revisionId: String(q.revision_id ?? ""),
    printedNumber: (q.printed_number as string | null | undefined) ?? null,
    section: (q.section as string | null | undefined) ?? null,
    questionType: String(q.question_type ?? ""),
    admissionReview: (q.admission_review as string | null | undefined) ?? null,
    admissionCompleteness: (q.admission_completeness as string | null | undefined) ?? null,
    publicationState: (q.publication_state as string | null | undefined) ?? null,
    sourceDocumentId: (q.source_document_id as string | null | undefined) ?? null,
  }));
}

export async function fetchQuestionDetail(
  questionId: string,
  opts: { submitted?: boolean; apiBase?: string } = {},
): Promise<{ question: QCoreStudentQuestion; report: QCoreMappingReport }> {
  const submitted = opts.submitted ? "true" : "false";
  const res = await qcFetch(
    `${opts.apiBase || QCORE_API_BASE}/student/questions/${encodeURIComponent(questionId)}?submitted=${submitted}`,
  );
  if (res.status === 404) throw new QcNotFoundError(questionId);
  if (!res.ok) throw new QcApiError(`qcore student api detail failed: ${res.status}`, res.status);
  const raw = (await res.json()) as Record<string, unknown>;
  const notes: string[] = [];
  const content = (raw.content ?? {}) as Record<string, unknown>;
  const assets = ((content.assets as Record<string, unknown>[]) ?? []).map((a) => {
    const storagePath = String(a.storage_path ?? "");
    const provided = (a.url as string | null | undefined) || null;
    const { url, note } = provided ? { url: provided, note: null } : assetUrlFor(String(a.asset_id ?? ""));
    if (note) notes.push(note);
    return {
      assetId: String(a.asset_id ?? ""),
      storagePath,
      mimeType: String(a.mime_type ?? ""),
      url,
    };
  });
  const storageByAsset = new Map(assets.map((a) => [a.assetId, a.storagePath]));
  const urlByAsset = new Map(assets.map((a) => [a.assetId, a.url]));
  /** AF3/Q6：表格图片单元格的 ![](asset_id) 标记 → 可渲染 URL。 */
  const resolveCellMarkers = (blocks: QCoreBlock[]): QCoreBlock[] =>
    blocks.map((b) => {
      if (b.kind !== "table") return b;
      return {
        ...b,
        cells: b.cells.map((c) => ({
          ...c,
          content: c.content.replace(
            /!\[\]\((img_in_[\w_]+)\)/g,
            (_m, id: string) => {
              const u = urlByAsset.get(id);
              return u ? `![](${u})` : `（图片资源未解析：${id}）`;
            },
          ),
        })),
      };
    });
  const decorate = (bs: Record<string, unknown>[]) =>
    bs.map((b) =>
      b.kind === "image" ? { ...b, __storage_path: storageByAsset.get(String(b.asset_id ?? "")) } : b,
    );
  const bodies = ((content.bodies as Record<string, unknown>[]) ?? []).map((b) => {
    const stem = decorate((b.stem_blocks as Record<string, unknown>[]) ?? []);
    const opts2 = ((b.options as Record<string, unknown>[]) ?? []).map((o) => ({
      ...o,
      blocks: decorate((o.blocks as Record<string, unknown>[]) ?? []),
    }));
    const mapped = mapBody(questionId, { ...b, stem_blocks: stem, options: opts2 }, notes);
    return {
      ...mapped,
      stemBlocks: resolveCellMarkers(mapped.stemBlocks),
      options: mapped.options.map((o) => ({ ...o, blocks: resolveCellMarkers(o.blocks) })),
    };
  });
  const materials = ((content.materials as Record<string, unknown>[]) ?? []).map((m) => {
    const mapped = mapMaterial(questionId, { ...m, blocks: decorate((m.blocks as Record<string, unknown>[]) ?? []) }, notes);
    return { ...mapped, blocks: resolveCellMarkers(mapped.blocks) };
  });

  return {
    question: {
      questionId: String(raw.question_id ?? ""),
      revisionId: String(raw.revision_id ?? ""),
      revisionNumber: Number(raw.revision_number ?? 0),
      questionType: String(raw.question_type ?? ""),
      content: { bodies, materials, assets },
      answerVisible: Boolean(raw.answer_visible),
      explanationVisible: Boolean(raw.explanation_visible),
      answers: (raw.answers as unknown[]) ?? [],
      answersNote: (raw.answers_note as string | null | undefined) ?? null,
      explanationBlocks: mapBlocks(questionId, (raw.explanation_blocks as Record<string, unknown>[]) ?? [], notes),
      explanationNote: (raw.explanation_note as string | null | undefined) ?? null,
    },
    report: { questionId, notes },
  };
}
