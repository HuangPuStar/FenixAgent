/**
 * 会话消息 → 渲染项的纯函数投影（含思考块合并与活动链分组）。
 *
 * 来源：逐字复制 `packages/agent-runtime/web/components/chat/chat-render-layout.ts`。
 * 纯化改动点：唯一改动是把 `@/src/lib/types` 收敛为包内 `../types`；逻辑、注释与判定顺序不变。
 */

import type { AssistantMessageEntry, ThreadEntry, ToolCallEntry } from "../types";

/** 单个渲染项：普通消息条目，或一组相邻的工具调用。 */
export type ChatRenderItem =
  | { type: "entry"; entry: ThreadEntry; density: "normal" | "activity" }
  | { type: "tool_group"; entries: ToolCallEntry[]; density: "activity" };

/** 渲染块：独立项，或一串连续的活动项（供视图渲染为连续工具轨）。 */
export type ChatRenderBlock =
  | { type: "item"; item: ChatRenderItem }
  | { type: "activity_chain"; items: ChatRenderItem[] };

type UngradedChatRenderItem = { type: "entry"; entry: ThreadEntry } | { type: "tool_group"; entries: ToolCallEntry[] };

/** 判断条目是否为「仅有思考块」的助手消息（无可见正文），用于决定是否并入活动链。 */
function isThoughtOnlyEntry(entry: ThreadEntry): entry is AssistantMessageEntry {
  return (
    entry.type === "assistant_message" &&
    entry.chunks.length > 0 &&
    entry.chunks.every((chunk) => chunk.type === "thought")
  );
}

/**
 * Projects protocol entries into render items without merging their message data.
 * Thought-only entries adjacent to tools form one compact activity chain, while
 * assistant entries containing visible text keep the regular reading rhythm.
 *
 * 复制自 `packages/agent-runtime/web/components/chat/chat-render-layout.ts`；纯化改动点：无（仅模块路径调整）。
 */
export function buildChatRenderItems(entries: readonly ThreadEntry[]): ChatRenderItem[] {
  const grouped: UngradedChatRenderItem[] = [];
  let currentToolGroup: ToolCallEntry[] = [];

  const flushToolGroup = () => {
    if (currentToolGroup.length > 0) grouped.push({ type: "tool_group", entries: currentToolGroup });
    currentToolGroup = [];
  };

  for (const entry of entries) {
    // 标准 ACP plan 由输入区上方的 ChatStatusPanel 独立展示，不进入消息时间线。
    if (entry.type === "plan") continue;
    if (entry.type === "tool_call") {
      currentToolGroup.push(entry);
      continue;
    }
    flushToolGroup();
    grouped.push({ type: "entry", entry });
  }
  flushToolGroup();

  return grouped.map((item, index): ChatRenderItem => {
    if (item.type === "tool_group") return { ...item, density: "activity" };

    const hasAdjacentTool = grouped[index - 1]?.type === "tool_group" || grouped[index + 1]?.type === "tool_group";
    return {
      ...item,
      density: isThoughtOnlyEntry(item.entry) && hasAdjacentTool ? "activity" : "normal",
    };
  });
}

/**
 * Groups adjacent activity items so the view can render one continuous tool rail.
 *
 * 复制自 `packages/agent-runtime/web/components/chat/chat-render-layout.ts`；纯化改动点：无（仅模块路径调整）。
 */
export function buildChatRenderBlocks(entries: readonly ThreadEntry[]): ChatRenderBlock[] {
  const blocks: ChatRenderBlock[] = [];
  let activityItems: ChatRenderItem[] = [];

  const flushActivityChain = () => {
    if (activityItems.length > 0) blocks.push({ type: "activity_chain", items: activityItems });
    activityItems = [];
  };

  for (const item of buildChatRenderItems(entries)) {
    if (item.density === "activity") {
      activityItems.push(item);
      continue;
    }
    flushActivityChain();
    blocks.push({ type: "item", item });
  }
  flushActivityChain();

  return blocks;
}
