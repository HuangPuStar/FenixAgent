/**
 * 工具行的行内详情投影。
 *
 * 只提取「结构化且可读」的内容（diff 块、输出文本、读取片段），原始 JSON 仍由参数弹窗承载：
 * 行内展开面向过程浏览，不是调试面板。拿不到可读文本时返回 `null`，调用方不渲染展开入口。
 */

import { truncate } from "../../lib/format";
import type { ToolCallContent, ToolCallData } from "../types";

/** 行内文本的最大展示长度；超出部分截断并标记，避免单条输出拖垮渲染。 */
const MAX_INLINE_TEXT = 4_000;

export interface ToolDiffFile {
  path: string;
  oldText: string | null;
  newText: string;
}

export type ToolDetail =
  | { type: "diff"; files: ToolDiffFile[] }
  | {
      type: "text";
      text: string;
      path?: string;
      lineStart?: number;
      lineEnd?: number;
      /** 文本是否被截断（模型侧已限制长度）。 */
      truncated: boolean;
    };

function isDiffContent(content: ToolCallContent): content is Extract<ToolCallContent, { type: "diff" }> {
  return content.type === "diff";
}

function textOfContent(content: ToolCallContent): string | undefined {
  if (content.type !== "content") return;
  const block = content.content;
  return "text" in block && typeof block.text === "string" && block.text.trim() !== "" ? block.text : undefined;
}

function readString(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!record) return;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
}

/**
 * 列表型输出（文件列表、匹配行、文本块数组）→ 多行文本。
 *
 * 不同引擎把这些结果放在 `content` / `files` / `matches` 等字段里，元素可能是纯字符串或
 * `{ type: "text", text }` 块；能读就展开，读不到交给参数弹窗。
 */
function readList(value: unknown): string | undefined {
  if (!Array.isArray(value)) return;
  const items = value.flatMap((item) => {
    if (typeof item === "string" && item.trim() !== "") return [item];
    if (item && typeof item === "object" && "text" in item) {
      const text = (item as { text?: unknown }).text;
      return typeof text === "string" && text.trim() !== "" ? [text] : [];
    }
    return [];
  });
  return items.length > 0 ? items.join("\n") : undefined;
}

function resolvePath(tool: ToolCallData): string | undefined {
  if (tool.display?.path) return tool.display.path;
  const path = tool.rawInput?.file_path ?? tool.rawInput?.path ?? tool.rawInput?.filePath;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}

function outputText(tool: ToolCallData): string | undefined {
  const contentText = tool.content?.map(textOfContent).find((text) => text !== undefined);
  if (contentText) return contentText;

  const output = tool.rawOutput;
  const direct = readString(output, ["output", "aggregated_output", "content", "text", "result", "message"]);
  if (direct) return direct;

  // 读取/搜索类工具的 rawOutput.content 通常是文本块数组。
  const contentList = readList(output?.content);
  if (contentList) return contentList;
  for (const key of ["files", "matches", "results", "lines"] as const) {
    const list = readList(output?.[key]);
    if (list) return list;
  }

  // 终端类工具可能把 stdout/stderr 分开返回；合并展示比只取一半更接近用户预期。
  const stdout = readString(output, ["stdout"]);
  const stderr = readString(output, ["stderr"]);
  if (stdout || stderr) return [stdout, stderr].filter(Boolean).join("\n");

  return tool.display?.text;
}

/**
 * 构建工具行的行内详情。
 *
 * diff 优先：同一调用同时带 diff 与文本时，diff 是用户最关心的变更内容。
 */
export function buildToolDetail(tool: ToolCallData): ToolDetail | null {
  const diffFiles = tool.content?.filter(isDiffContent).map((content) => ({
    path: content.path,
    oldText: content.oldText ?? null,
    newText: content.newText,
  }));
  if (diffFiles && diffFiles.length > 0) return { type: "diff", files: diffFiles };

  const text = outputText(tool);
  if (!text) return null;

  const truncated = text.length > MAX_INLINE_TEXT;
  return {
    type: "text",
    text: truncated ? truncate(text, MAX_INLINE_TEXT) : text,
    path: resolvePath(tool),
    lineStart: tool.display?.lineStart,
    lineEnd: tool.display?.lineEnd,
    truncated,
  };
}
