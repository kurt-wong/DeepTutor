"use client";

// B-2 Spike — 结构保真渲染块（自 QCoreStudentPage 抽出共享）。
// 职责：QC content 的 text/image/table 块与 body（含小问缩进/选项）原样呈现。
// 不压平、不改写、不推断；图片 URL 由 adapter 的 C1 白名单映射决定，未解析即提示。
import MarkdownRenderer from "@/components/common/MarkdownRenderer";
import type { QCoreBlock, QCoreBody, QCoreMaterial } from "@/lib/qcore-adapter/types";

export function BlockView({ block }: { block: QCoreBlock }) {
  if (block.kind === "text") {
    // 展示层格式化：Markdown + KaTeX 渲染（$..$ 内联公式），内容不做任何改写。
    // 图片/代码/HTML 通道关闭——图片由 ImageBlock 原样渲染，避免相对路径乱图。
    return (
      <MarkdownRenderer
        content={block.text}
        enableMath
        enableImages={false}
        enableCode={false}
        enableMermaid={false}
        allowHtml={false}
        className="text-sm leading-6"
      />
    );
  }
  if (block.kind === "image") {
    return block.url ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={block.url} alt={block.altText ?? block.assetId} className="max-w-full border rounded" />
    ) : (
      <div className="text-xs text-amber-700 border border-amber-300 rounded px-2 py-1">
        图片资源未解析：{block.assetId}
      </div>
    );
  }
  if (block.kind === "table") {
    const grid: string[][] = Array.from({ length: block.nRows }, () =>
      Array.from({ length: block.nCols }, () => ""),
    );
    for (const c of block.cells) if (grid[c.row]) grid[c.row][c.col] = c.content;
    return (
      <table className="border-collapse text-sm my-2">
        <tbody>
          {grid.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci} className="border px-2 py-1 align-top">
                  {/* AF3/Q11·Q6：表格单元格与正文同权渲染——$..$ 公式、
                      ![](图) 标记（图片单元格保留）均走 Markdown/KaTeX；
                      实体解码已在 adapter 层完成。 */}
                  <MarkdownRenderer
                    content={cell}
                    enableMath
                    enableImages
                    enableCode={false}
                    enableMermaid={false}
                    allowHtml={false}
                    className="text-sm leading-6"
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <details className="text-xs my-1">
      <summary className="cursor-pointer text-gray-600">块类型 {block.apiKind}（API 内容已剥除，原样保留）</summary>
      <pre className="bg-gray-50 p-2 overflow-auto">{JSON.stringify(block.raw, null, 1)}</pre>
    </details>
  );
}

/* AF6 · 行内图文混排（展示层 P1，Owner 2026-11-19 裁决“必须实施后再判”）。
 * 只合并两种在 64 候选全量实测中各唯一命中的模式，其余块序一律原样堆叠：
 *  R1 同行夹心：text.line_start 非空且与后继 text 相同、中夹 image → 合并为单段行内图文
 *     （Q18 (5)：源行 358「合成 [目标图]。利用……」）；
 *  R2 起始图：首块 image（无行号）+ 次块 text → 图嵌入文本起点
 *     （Q16 (2)：PDF 同行「(2) [配体图] 为平面分子……」；源 MD 剥除图记号处留有双空隙，
 *      按首个「右括号+双空隙」定位，无空隙则图置于文本前）。
 * 失败安全：图 url 未解析、或文本自带 ![…](…) 标记 → 不合并，退回原堆叠。
 * 仅渲染期组合：不改 QC 数据、不改块结构、不改行号、不改写文本内容。 */
type InlineView =
  | { type: "block"; key: number; block: QCoreBlock }
  | { type: "text"; key: number; text: string };

function buildInlineViews(blocks: QCoreBlock[]): InlineView[] {
  const out: InlineView[] = [];
  const safeText = (b: QCoreBlock): string | null =>
    b.kind === "text" && !b.text.includes("![") ? b.text : null;
  const mdImg = (b: Extract<QCoreBlock, { kind: "image" }>) =>
    `![${b.altText ?? b.assetId}](${b.url})`;
  let i = 0;
  while (i < blocks.length) {
    const cur = blocks[i];
    const mid = blocks[i + 1];
    const next = blocks[i + 2];
    // R3 图回声 token（AF7/A1，Owner 2026-11-19 裁定“展示层止血”）：
    // text 内含 N/N 阵列回声 math 段（OCR 对行内六元环图的文字转写）且后邻该图
    // → 图原位替换 token、图块不再独立渲染；PDF 无此文，token 不显示。
    // 爆炸面实测：64 候选仅 Q16 M01 命中、正式库 0 命中；无 token/无相邻图即原样（fail-safe）。
    // 登记：这是展示层止血，OCR 版面顺序/图内文字转写根因仍在提取层（非 OCR 已修）。
    const curText = cur.kind === "text" ? cur.text : null;
    const echo =
      curText !== null && safeText(cur) !== null
        ? curText.match(/\$[^$]*\\text\{N\}[^$]*\\text\{N\}[^$]*\$/)
        : null;
    if (curText !== null && echo && mid?.kind === "image" && mid.url) {
      out.push({ type: "text", key: i, text: curText.replace(echo[0], mdImg(mid)) });
      i += 2;
      continue;
    }
    // R1 同行夹心（line_start 相等才代表 PDF 同一行；不同行=段间独立图，保持堆叠）
    if (
      cur.kind === "text" &&
      mid?.kind === "image" &&
      next?.kind === "text" &&
      mid.url &&
      typeof cur.lineStart === "number" &&
      cur.lineStart === next.lineStart
    ) {
      const t1 = safeText(cur);
      const t2 = safeText(next);
      if (t1 !== null && t2 !== null) {
        out.push({ type: "text", key: i, text: `${t1}${mdImg(mid)}${t2}` });
        i += 3;
        continue;
      }
    }
    // R2 起始图
    const second = blocks[i + 1];
    if (i === 0 && cur.kind === "image" && cur.url && second?.kind === "text") {
      const t = safeText(second);
      // 必须命中「右括号+双空隙」才合并——该空隙是源 MD 剥除行内图记号的留痕；
      // 无留痕（如正式库的图+「图1」题注、图+「---」分页行）一律保持原堆叠，防止误行内化。
      const m = t !== null ? t.match(/^([\s\S]*?[)）])(\s{2,})([\s\S]+)$/) : null;
      if (t !== null && m) {
        out.push({ type: "text", key: i, text: `${m[1]}${mdImg(cur)}${m[3]}` });
        i += 2;
        continue;
      }
    }
    out.push({ type: "block", key: i, block: cur });
    i += 1;
  }
  return out;
}

/** 块序列渲染入口：命中 AF6/AF7 行内模式的走合并段，其余与 BlockView 逐块渲染完全一致。 */
export function InlineBlocks({ blocks }: { blocks: QCoreBlock[] }) {
  return (
    <>
      {buildInlineViews(blocks).map((v) =>
        v.type === "text" ? (
          <MarkdownRenderer
            key={v.key}
            content={v.text}
            enableMath
            enableImages
            enableCode={false}
            enableMermaid={false}
            allowHtml={false}
            className="text-sm leading-6"
          />
        ) : (
          <BlockView key={v.key} block={v.block} />
        ),
      )}
    </>
  );
}

export function BodyView({
  body,
  showPrintedNumber = false,
}: {
  body: QCoreBody;
  showPrintedNumber?: boolean;
}) {
  const isSub = Boolean(body.parentQuestionRef);
  // 展示层最小修复：选项首块若为与 label 同名的纯标签文本（"A"），跳过之，
  // 避免 "A. A" 重复（不改 QC 内容，仅渲染过滤；结构与内容语义零变更）。
  const optionViews = body.options.map((o) => {
    const blocks = [...o.blocks];
    const first = blocks[0];
    if (
      first &&
      first.kind === "text" &&
      first.text.trim() === o.label.trim()
    ) {
      blocks.shift();
    }
    return { label: o.label, blocks: blocks.length ? blocks : o.blocks };
  });
  // AF3/Q11·Q6 表/选项二选一：题面表格已是选项主体（含 A-D 行/标签行）时，
  // 选项行不重复渲染（DSH「表格作为选项主体时只输出表格一次，不要两者都渲染」）。
  // 判定：每个选项的文本块都被表格单元格文本覆盖，且选项图的 URL/assetId
  // 出现在单元格 ![](…) 标记中。
  const tableText = body.stemBlocks
    .filter((b) => b.kind === "table")
    .map((b) => (b.kind === "table" ? b.cells.map((c) => c.content).join("\n") : ""))
    .join("\n");
  // 比较归一化空白（选项文本过 tighten 管线、表格 cell 未过——字节空白不一致）
  const norm = (s: string) => s.replace(/\s+/g, "");
  const tableNorm = norm(tableText);
  const optionsCoveredByTable =
    tableText.trim() !== "" &&
    optionViews.length > 0 &&
    optionViews.every((o) =>
      o.blocks.every((b) => {
        if (b.kind === "text")
          return b.text.trim() === "" || tableNorm.includes(norm(b.text));
        if (b.kind === "image")
          return tableText.includes(b.assetId) || (b.url != null && tableText.includes(b.url));
        return true;
      }),
    );
  return (
    <div className={`border rounded p-3 my-2 ${isSub ? "ml-6 bg-slate-50" : "bg-white"}`}>
      {showPrintedNumber && (
        <div className="mb-1 flex items-baseline gap-2 text-xs text-muted-foreground">
          {body.printedNumber != null && (
            <span className="font-medium text-foreground">第 {body.printedNumber} 题</span>
          )}
          <span>{body.questionType}</span>
          {isSub && <span>子问 · {body.localId}</span>}
          {body.subQuestionIds.length > 0 && (
            <span>含子问 {body.subQuestionIds.length}</span>
          )}
        </div>
      )}
      <div className="space-y-1">
        <InlineBlocks blocks={body.stemBlocks} />
      </div>
      {optionViews.length > 0 && !optionsCoveredByTable && (() => {
        // PDF 原卷式紧凑选项行：所有选项均为单文本块时一行排开；
        // 含多块/图片等复杂选项时退回逐项堆叠，保证结构不丢。
        const inline = optionViews.every((o) => o.blocks.length === 1 && o.blocks[0].kind === "text");
        if (inline) {
          return (
            <div className="mt-2 flex flex-wrap gap-x-8 gap-y-1">
              {optionViews.map((o) => (
                <div key={o.label} className="flex items-baseline gap-1 text-sm">
                  <span className="font-medium">{o.label}.</span>
                  <BlockView block={o.blocks[0]} />
                </div>
              ))}
            </div>
          );
        }
        return (
          <div className="mt-2 space-y-1">
            {optionViews.map((o) => (
              <div key={o.label} className="flex gap-2 items-start">
                <span className="font-medium text-sm">{o.label}.</span>
                <div className="flex-1 space-y-1">
                  <InlineBlocks blocks={o.blocks} />
                </div>
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}

export function MaterialView({ material }: { material: QCoreMaterial }) {
  return (
    <div className="rounded border border-amber-200 bg-amber-50 p-3 my-2">
      <div className="text-xs text-amber-800 mb-1">材料 {material.materialId}</div>
      <div className="space-y-1">
        <InlineBlocks blocks={material.blocks} />
      </div>
    </div>
  );
}
