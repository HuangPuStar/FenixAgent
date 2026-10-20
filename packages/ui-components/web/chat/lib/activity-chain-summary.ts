/**
 * 活动链折叠的纯数据投影。
 *
 * 活动链由「仅有思考的助手消息 + 相邻工具调用」组成；这里只负责把条目压成
 * 可展示的类别计数与运行态，不持有 React 状态，便于单测和后续调整分组策略。
 */

import type { ThreadEntry, ToolCallData, ToolCardKind } from "../types";
import type { ChatRenderItem } from "./chat-render-layout";

/** 活动链摘要中的工具类别；同类工具合并计数，避免长会话标题被单个工具名淹没。 */
export type ActivityCategory =
  | "read"
  | "search"
  | "edit"
  | "command"
  | "web"
  | "subagent"
  | "todo"
  | "skill"
  | "question"
  | "tool";

const KIND_TO_CATEGORY: Record<ToolCardKind, ActivityCategory> = {
  "read-file": "read",
  "read-directory": "read",
  grep: "search",
  glob: "search",
  write: "edit",
  edit: "edit",
  bash: "command",
  "web-fetch": "web",
  "web-search": "web",
  task: "subagent",
  todo: "todo",
  skill: "skill",
  question: "question",
  unknown: "tool",
};

export interface ActivityCategoryCount {
  category: ActivityCategory;
  count: number;
}

export interface ActivityChainSummary {
  /** 工具调用总数。 */
  toolCount: number;
  /** 失败工具数；用于标题的失败提示。 */
  errorCount: number;
  /** 是否包含思考过程（无可见正文的助手消息）。 */
  hasThought: boolean;
  /** 按首次出现顺序排列的类别计数。 */
  categories: ActivityCategoryCount[];
  /** 是否有工具仍在执行或等待确认。 */
  running: boolean;
}

function toolCallsOf(item: ChatRenderItem): ToolCallData[] {
  if (item.type === "tool_group") return item.entries.map((entry) => entry.toolCall);
  return item.entry.type === "tool_call" ? [item.entry.toolCall] : [];
}

/**
 * 判断活动链是否仍在运行：工具未终态，或加载中且末项是当前会话正在产出的助手消息。
 *
 * `lastEntry` 参与比较的原因：加载新回复时旧活动链的末项仍是历史助手消息，
 * 只凭 `isLoading` 会把已结束的旧链重新展开，故只有会话末条条目才算流式内容。
 */
export function isActivityChainActive(
  items: readonly ChatRenderItem[],
  isLoading: boolean,
  lastEntry?: ThreadEntry,
): boolean {
  if (items.some((item) => toolCallsOf(item).some((tool) => isToolActive(tool.status)))) return true;
  if (!isLoading) return false;
  const last = items.at(-1);
  return last?.type === "entry" && last.entry.type === "assistant_message" && last.entry === lastEntry;
}

function isToolActive(status: ToolCallData["status"]): boolean {
  return status === "running" || status === "waiting_for_confirmation";
}

/**
 * 汇总活动链中的工具类别与异常。
 *
 * 类别顺序沿用首次出现顺序：同一轮里「先读后改」比按数量排序更贴近实际过程，
 * 也避免流式追加工具时标题顺序跳动。
 */
export function summarizeActivityChain(items: readonly ChatRenderItem[]): ActivityChainSummary {
  const counts = new Map<ActivityCategory, number>();
  let toolCount = 0;
  let errorCount = 0;
  let hasThought = false;
  let running = false;

  for (const item of items) {
    if (item.type === "entry" && item.entry.type === "assistant_message") {
      hasThought ||= item.entry.chunks.some((chunk) => chunk.type === "thought" && chunk.text.trim() !== "");
    }
    for (const tool of toolCallsOf(item)) {
      toolCount += 1;
      if (tool.status === "error") errorCount += 1;
      running ||= isToolActive(tool.status);
      const category = KIND_TO_CATEGORY[tool.kind ?? "unknown"];
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }

  return {
    toolCount,
    errorCount,
    hasThought,
    categories: [...counts].map(([category, count]) => ({ category, count })),
    running,
  };
}
