/**
 * 工具 diff 的轻量行级投影。
 *
 * ACP 的 diff 内容块给的是修改前/后全文，直接并排展示在长文件上会淹没真正变化。
 * 这里用 LCS 生成带少量上下文的最小 diff；超出计算阈值时退化为「删除段 + 新增段」，
 * 并截断展示行数，保证 UI 不会被超大文件拖垮。
 */

export type DiffLineType = "context" | "add" | "remove" | "ellipsis";

export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** 省略行折叠掉的原始行数；仅 `type === "ellipsis"` 时有值，供 UI 生成本地化文案。 */
  hiddenCount?: number;
}

export interface LineDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** 展示内容是否经过截断（存在省略行或退化展示）。 */
  truncated: boolean;
}

const MAX_LCS_CELLS = 200_000;
const MAX_FALLBACK_LINES = 120;
const DEFAULT_CONTEXT_LINES = 2;

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.split("\n");
}

/** 统一换行，避免同一份文件的 CRLF/LF 差异被逐行判定为变化。 */
function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function sameLines(left: readonly string[], leftStart: number, right: readonly string[], rightStart: number): boolean {
  return left[leftStart] === right[rightStart];
}

interface DiffOp {
  type: Exclude<DiffLineType, "ellipsis">;
  text: string;
}

function lcsOps(oldLines: readonly string[], newLines: readonly string[]): DiffOp[] {
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const table = new Uint32Array(rows * cols);
  const at = (row: number, col: number): number => row * cols + col;

  for (let row = 1; row < rows; row += 1) {
    for (let col = 1; col < cols; col += 1) {
      table[at(row, col)] =
        oldLines[row - 1] === newLines[col - 1]
          ? table[at(row - 1, col - 1)] + 1
          : Math.max(table[at(row - 1, col)], table[at(row, col - 1)]);
    }
  }

  const ops: DiffOp[] = [];
  let row = rows - 1;
  let col = cols - 1;
  while (row > 0 || col > 0) {
    if (row > 0 && col > 0 && oldLines[row - 1] === newLines[col - 1]) {
      ops.push({ type: "context", text: oldLines[row - 1] });
      row -= 1;
      col -= 1;
    } else if (col > 0 && (row === 0 || table[at(row, col - 1)] >= table[at(row - 1, col)])) {
      ops.push({ type: "add", text: newLines[col - 1] });
      col -= 1;
    } else {
      ops.push({ type: "remove", text: oldLines[row - 1] });
      row -= 1;
    }
  }
  return ops.reverse();
}

function fallbackOps(oldLines: readonly string[], newLines: readonly string[]): { ops: DiffOp[]; truncated: boolean } {
  const removed = oldLines.slice(0, MAX_FALLBACK_LINES).map((text): DiffOp => ({ type: "remove", text }));
  const added = newLines.slice(0, MAX_FALLBACK_LINES).map((text): DiffOp => ({ type: "add", text }));
  return {
    ops: [...removed, ...added],
    truncated: oldLines.length > MAX_FALLBACK_LINES || newLines.length > MAX_FALLBACK_LINES,
  };
}

/** 压缩过长的连续上下文，只在变化附近保留 `contextLines` 行。 */
function compactContext(ops: readonly DiffOp[], contextLines: number): { lines: DiffLine[]; truncated: boolean } {
  const lines: DiffLine[] = [];
  let truncated = false;
  let index = 0;

  while (index < ops.length) {
    if (ops[index].type !== "context") {
      lines.push(ops[index]);
      index += 1;
      continue;
    }
    let end = index;
    while (end < ops.length && ops[end].type === "context") end += 1;
    const run = ops.slice(index, end);
    if (run.length > contextLines * 2 + 1) {
      lines.push(...run.slice(0, contextLines));
      lines.push({ type: "ellipsis", text: "", hiddenCount: run.length - contextLines * 2 });
      lines.push(...run.slice(-contextLines));
      truncated = true;
    } else {
      lines.push(...run);
    }
    index = end;
  }

  return { lines, truncated };
}

/**
 * 计算修改前/后文本的行级 diff。
 *
 * @param oldText - 修改前全文；`null` 或空串表示新增文件。
 * @param newText - 修改后全文。
 * @param contextLines - 每处变化保留的上下文行数。
 */
export function computeLineDiff(
  oldText: string | null | undefined,
  newText: string,
  contextLines = DEFAULT_CONTEXT_LINES,
): LineDiff {
  const before = normalizeText(oldText ?? "");
  const after = normalizeText(newText);
  if (before === after) return { lines: [], added: 0, removed: 0, truncated: false };

  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && sameLines(oldLines, prefix, newLines, prefix)) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    sameLines(oldLines, oldLines.length - 1 - suffix, newLines, newLines.length - 1 - suffix)
  ) {
    suffix += 1;
  }

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const fallback = oldMiddle.length * newMiddle.length > MAX_LCS_CELLS ? fallbackOps(oldMiddle, newMiddle) : undefined;
  const middleOps = fallback ? fallback.ops : lcsOps(oldMiddle, newMiddle);
  const middleTruncated = fallback?.truncated ?? false;

  const leading: DiffOp[] = oldLines
    .slice(Math.max(0, prefix - contextLines), prefix)
    .map((text) => ({ type: "context", text }));
  const trailing: DiffOp[] = oldLines
    .slice(oldLines.length - suffix, oldLines.length - suffix + contextLines)
    .map((text) => ({ type: "context", text }));

  let added = 0;
  let removed = 0;
  for (const op of middleOps) {
    if (op.type === "add") added += 1;
    else if (op.type === "remove") removed += 1;
  }

  const compacted = compactContext([...leading, ...middleOps, ...trailing], contextLines);
  const lines: DiffLine[] = [];
  const prefixTruncated = prefix > leading.length;
  if (prefixTruncated) {
    lines.push({ type: "ellipsis", text: "", hiddenCount: prefix - leading.length });
  }
  lines.push(...compacted.lines);
  if (suffix > trailing.length) {
    lines.push({ type: "ellipsis", text: "", hiddenCount: suffix - trailing.length });
  }

  return {
    lines,
    added,
    removed,
    truncated: prefixTruncated || suffix > trailing.length || compacted.truncated || middleTruncated,
  };
}
