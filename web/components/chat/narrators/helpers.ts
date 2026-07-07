/**
 * Narrator 共享工具函数。
 *
 * 所有函数都是纯函数，无副作用，便于单测。
 * 设计原则：宽容处理 rawInput / rawOutput 的字段变体
 * （不同 Agent 命名习惯不同），失败时返回兜底值而非抛错。
 */

/**
 * 从多种可能的路径字段中提取文件名。
 * 兼容 Read/Edit/Write 工具的不同参数命名（file_path / path / filePath）。
 */
export function extractFileName(rawInput: unknown): string {
  const r = rawInput as Record<string, unknown> | undefined;
  const path = String(r?.file_path ?? r?.path ?? r?.filePath ?? "");
  if (!path) return "文件";
  return path.split("/").pop() || path;
}

/**
 * 从 Read 工具的 rawInput 提取行号区间。
 * 兼容两种命名：offset+limit（Claude Code 风格）和 start_line+end_line。
 * 返回 "120-180" 或 ""（无行号限制时）。
 *
 * 注意：offset=0 / limit=0 被视为无效（Number(0) falsy），
 * 因为 Read 工具的行号从 1 开始，0 是无意义值。
 */
export function extractLineRange(rawInput: unknown): string {
  const r = rawInput as Record<string, unknown> | undefined;
  const offset = Number(r?.offset);
  const limit = Number(r?.limit);
  if (offset && limit) return `${offset}-${offset + limit - 1}`;
  const start = Number(r?.start_line);
  const end = Number(r?.end_line);
  if (start && end) return `${start}-${end}`;
  return "";
}

/**
 * 从 rawOutput 提取错误信息。
 *
 * ACP 协议下 rawOutput 结构有几种变体，按优先级匹配：
 * 1. isError=true + content[].text（ACP 标准）
 * 2. error 字段（string 或 { message }）
 * 3. content 数组中最后一个 text（Bash 等工具的 stderr）
 * 4. 兜底"未知错误"
 *
 * 所有分支都经过 truncate(120) 截断，避免超长错误信息破坏 UI。
 */
export function extractErrorMessage(rawOutput: unknown): string {
  if (!rawOutput) return "未知错误";
  const o = rawOutput as Record<string, unknown>;

  if (o.isError && Array.isArray(o.content)) {
    const text = (o.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text;
    if (text) return truncate(String(text), 120);
  }

  if (typeof o.error === "string") return truncate(o.error, 120);
  if (o.error && typeof o.error === "object" && "message" in (o.error as object)) {
    return truncate(String((o.error as { message: unknown }).message), 120);
  }

  if (Array.isArray(o.content)) {
    const lastText = [...(o.content as Array<{ type: string; text?: unknown }>)]
      .reverse()
      .find((c) => c.type === "text")?.text;
    if (typeof lastText === "string") return truncate(lastText, 120);
  }

  return "未知错误";
}

/**
 * 格式化耗时。前端维护 toolCallStartedAt 时间戳，complete/error 时计算差值。
 * - <1s 显示 ms
 * - <1min 显示 s（保留 1 位小数）
 * - ≥1min 显示 m+s
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

/**
 * 截断字符串，超长加省略号。
 */
export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * 从 rawInput 提取第一个字符串值。兜底 narrator 用作附加上下文。
 * 跳过空字符串（length > 0 守卫），因为空字符串不提供有效信息。
 */
export function findFirstStringValue(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== "object") return;
  for (const v of Object.values(rawInput as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0) return v;
  }
}

/**
 * 从 opencode read 工具读目录的 rawOutput 中提取条目数。
 *
 * opencode 输出格式：
 * ```
 * {
 *   output: "<path>...</path>\n<type>directory</type>\n<entries>\na\nb\n\n(2 entries)\n</entries>",
 *   metadata: { preview: "a\nb", truncated: false, loaded: [] }
 * }
 * ```
 *
 * 解析优先级（宽容兜底，任一命中即返回）：
 * 1. metadata.preview：按非空行计数（最稳定，opencode 必带）
 * 2. output 里的 `(N entries)` 文案（兜底，preview 缺失时）
 * 3. output 里 <entries>...</entries> 块的非空行计数（再兜底）
 *
 * 返回 N>0 的整数；解析失败或为 0 时返回 undefined（detail 不显示）。
 */
export function extractDirectoryEntryCount(rawOutput: unknown): number | undefined {
  if (!rawOutput || typeof rawOutput !== "object") return;
  const o = rawOutput as Record<string, unknown>;

  // 1. metadata.preview：按非空行计数
  const meta = o.metadata as Record<string, unknown> | undefined;
  if (typeof meta?.preview === "string") {
    const count = countNonEmptyLines(meta.preview);
    if (count > 0) return count;
  }

  const output = typeof o.output === "string" ? o.output : "";
  if (!output) return;

  // 2. (N entries) 文案
  const entriesMatch = output.match(/\((\d+)\s+entries?\)/i);
  if (entriesMatch) {
    const n = Number(entriesMatch[1]);
    if (n > 0) return n;
  }

  // 3. <entries>...</entries> 块的非空行
  const blockMatch = output.match(/<entries>([\s\S]*?)<\/entries>/i);
  if (blockMatch?.[1]) {
    const count = countNonEmptyLines(blockMatch[1]);
    if (count > 0) return count;
  }

  return;
}

/**
 * 计算字符串中的非空行数（trim 后为空的不计）。
 * 内部辅助，仅 extractDirectoryEntryCount 使用。
 */
function countNonEmptyLines(s: string): number {
  return s
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .reduce((acc) => acc + 1, 0);
}

/**
 * 判断 rawOutput 是否为 opencode read 工具读目录的输出。
 * 通过 `<type>directory</type>` 标签精确识别，避免误伤其他工具。
 */
export function isOpencodeDirectoryOutput(rawOutput: unknown): boolean {
  if (!rawOutput || typeof rawOutput !== "object") return false;
  const o = rawOutput as Record<string, unknown>;
  if (typeof o.output !== "string") return false;
  return o.output.includes("<type>directory</type>");
}

/**
 * 判断 rawOutput 是否为 opencode read 工具读文件的输出。
 * 同时要求 `<path>` 和 `<type>file</type>` 标签，提高识别精度。
 */
export function isOpencodeFileOutput(rawOutput: unknown): boolean {
  if (!rawOutput || typeof rawOutput !== "object") return false;
  const o = rawOutput as Record<string, unknown>;
  if (typeof o.output !== "string") return false;
  return o.output.includes("<path>") && o.output.includes("<type>file</type>");
}

// =============================================================================
// Display 元数据提取 — 从 rawOutput.metadata.display 读取引擎的类型标记
// =============================================================================

/**
 * opencode 等引擎在 rawOutput.metadata.display 中提供展示类型元数据。
 * 此类型定义 display 的结构。
 */
export interface ToolCallDisplayMeta {
  type: string; // "file" | "directory" | "diff" 等
  path?: string;
  lineStart?: number;
  lineEnd?: number;
  totalLines?: number;
  text?: string;
  truncated?: boolean;
}

/**
 * 从 rawOutput 中提取 opencode 引擎的 display 元数据。
 * 位置：rawOutput.metadata.display
 * 返回 undefined 表示无 display 元数据（非 opencode 工具或未提供）。
 *
 * 同时支持从 _meta.display 提取（部分 relay 场景下 display 在 _meta 中）。
 */
export function extractDisplayMeta(
  rawOutput: unknown,
  meta?: Record<string, unknown> | null,
): ToolCallDisplayMeta | undefined {
  // 优先从 rawOutput.metadata.display 提取
  if (rawOutput && typeof rawOutput === "object") {
    const o = rawOutput as Record<string, unknown>;
    const metadata = o.metadata as Record<string, unknown> | undefined;
    if (metadata && typeof metadata.display === "object" && metadata.display !== null) {
      const d = metadata.display as Record<string, unknown>;
      if (typeof d.type === "string") {
        return {
          type: d.type,
          path: typeof d.path === "string" ? d.path : undefined,
          lineStart: typeof d.lineStart === "number" ? d.lineStart : undefined,
          lineEnd: typeof d.lineEnd === "number" ? d.lineEnd : undefined,
          totalLines: typeof d.totalLines === "number" ? d.totalLines : undefined,
          text: typeof d.text === "string" ? d.text : undefined,
          truncated: typeof d.truncated === "boolean" ? d.truncated : undefined,
        };
      }
    }
  }

  // 兜底：从 _meta.display 提取
  if (meta && typeof meta.display === "object" && meta.display !== null) {
    const d = meta.display as Record<string, unknown>;
    if (typeof d.type === "string") {
      return {
        type: d.type,
        path: typeof d.path === "string" ? d.path : undefined,
        lineStart: typeof d.lineStart === "number" ? d.lineStart : undefined,
        lineEnd: typeof d.lineEnd === "number" ? d.lineEnd : undefined,
        totalLines: typeof d.totalLines === "number" ? d.totalLines : undefined,
        text: typeof d.text === "string" ? d.text : undefined,
        truncated: typeof d.truncated === "boolean" ? d.truncated : undefined,
      };
    }
  }

  return;
}
