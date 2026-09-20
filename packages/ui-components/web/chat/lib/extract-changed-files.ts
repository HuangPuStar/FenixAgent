/**
 * 从会话渲染条目中提取被 Agent 修改过的文件列表（纯函数）。
 *
 * 来源：逐字复制 `apps/web/src/lib/extract-changed-files.ts`（该文件只依赖 tool-semantic 与类型，
 * 属纯逻辑，随 ChatInterface 一并进入包内）。
 * 纯化改动点：模块路径 `./types` 收敛为包内 `../types`；`ChangedFileType` / `ChangedFile`
 * 直接复用 `../types` 的既有定义（phase1 已从本文件复制），删除重复声明后原样 re-export，
 * 函数体与注释不变。
 */

import type { ChangedFile, ChangedFileType, ThreadEntry, ToolCallData } from "../types";
import { classifyToolSemantic } from "./tool-semantic";

export type { ChangedFile, ChangedFileType } from "../types";

/**
 * 从 chat entries 中提取被 Agent 修改过的文件列表。
 *
 * 提取优先级：
 * 1. tool_call.content[].type === "diff" 中的 path（最精准，agent 明确标记）
 * 2. 工具名 case-insensitive 包含 "edit"/"write" 或等于 "str_replace" 时，
 *    从 rawInput.file_path 或 rawInput.path 兜底提取
 * 3. bash 工具不提取（路径无法可靠解析）
 *
 * 递归处理 subEntries（子 agent 的变更也统计）。
 * 同路径以首次出现的操作类型为准，按字母序排序后返回。
 */
export function extractChangedFiles(entries: ThreadEntry[]): ChangedFile[] {
  // Map 保证路径唯一，value 为首次出现的操作类型
  const pathMap = new Map<string, ChangedFileType>();
  collectFromEntries(entries, pathMap);
  return Array.from(pathMap.entries())
    .map(([path, type]) => ({ path, type }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 从工具调用标题推断操作类型。
 * write 优先判断，避免 "write_edit_tool" 类名被误判为 edit。
 * 无法识别时返回 null（如 bash、read 等非写入工具）。
 */
function inferToolType(
  toolCall: Pick<ToolCallData, "title" | "rawInput" | "display" | "semantic">,
): ChangedFileType | null {
  const semantic =
    toolCall.semantic ??
    classifyToolSemantic({ name: toolCall.title, rawInput: toolCall.rawInput, display: toolCall.display });
  if (semantic === "write") return "write";
  if (semantic === "edit") return "edit";
  return null;
}

/** 递归遍历 entries，将变更文件路径收集到 pathMap 中 */
function collectFromEntries(entries: ThreadEntry[], pathMap: Map<string, ChangedFileType>): void {
  for (const entry of entries) {
    if (entry.type !== "tool_call") continue;
    collectFromToolCall(entry.toolCall, pathMap);
  }
}

/** 从单个工具调用中提取路径，并递归处理子 entries */
function collectFromToolCall(toolCall: ToolCallData, pathMap: Map<string, ChangedFileType>): void {
  // 优先：从 diff content 提取（最精准）
  if (toolCall.content) {
    let hasDiff = false;
    // diff 通常由 edit 类工具产生，以工具名推断，无法识别时兜底为 "edit"
    const diffType = inferToolType(toolCall) ?? "edit";
    for (const c of toolCall.content) {
      if (c.type === "diff" && c.path) {
        // 同路径以首次出现为准
        if (!pathMap.has(c.path)) pathMap.set(c.path, diffType);
        hasDiff = true;
      }
    }
    // 有 diff 数据时不再兜底，避免重复
    if (hasDiff) {
      if (toolCall.subEntries) collectFromEntries(toolCall.subEntries, pathMap);
      return;
    }
  }

  // 兜底：按工具名推断（没有 diff content 时）
  const toolType = inferToolType(toolCall);
  if (toolType && toolCall.rawInput) {
    // 尝试 file_path 字段（Edit 工具常用）
    const filePath = toolCall.rawInput.file_path;
    if (typeof filePath === "string" && filePath) {
      if (!pathMap.has(filePath)) pathMap.set(filePath, toolType);
    } else {
      // 尝试 path 字段（Write 工具常用）
      const path = toolCall.rawInput.path;
      if (typeof path === "string" && path) {
        if (!pathMap.has(path)) pathMap.set(path, toolType);
      }
    }
  }

  // 递归处理子 entries（子 agent 嵌套）
  if (toolCall.subEntries) {
    collectFromEntries(toolCall.subEntries, pathMap);
  }
}
