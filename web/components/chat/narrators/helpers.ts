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
  if (!path) return "<未知文件>";
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
