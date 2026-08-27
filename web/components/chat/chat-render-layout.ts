import type { AssistantMessageEntry, ThreadEntry, ToolCallEntry } from "../../src/lib/types";

export type ChatRenderItem =
  | { type: "entry"; entry: ThreadEntry; density: "normal" | "activity" }
  | { type: "tool_group"; entries: ToolCallEntry[]; density: "activity" };

export type ChatRenderBlock =
  | { type: "item"; item: ChatRenderItem }
  | { type: "activity_chain"; items: ChatRenderItem[] };

type UngradedChatRenderItem = { type: "entry"; entry: ThreadEntry } | { type: "tool_group"; entries: ToolCallEntry[] };

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
 */
export function buildChatRenderItems(entries: readonly ThreadEntry[]): ChatRenderItem[] {
  const grouped: UngradedChatRenderItem[] = [];
  let currentToolGroup: ToolCallEntry[] = [];

  const flushToolGroup = () => {
    if (currentToolGroup.length > 0) grouped.push({ type: "tool_group", entries: currentToolGroup });
    currentToolGroup = [];
  };

  for (const entry of entries) {
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

/** Groups adjacent activity items so the view can render one continuous tool rail. */
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
