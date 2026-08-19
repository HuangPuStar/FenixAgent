import { memo } from "react";
import type { AssistantMessageEntry, ThreadEntry, ToolCallEntry } from "../../src/lib/types";
import { ToolCallGroup } from "./ToolCallGroup";

// =============================================================================
// 子 Agent 嵌套面板 — 在父级 Task/Agent 工具调用展开时显示子 agent 的消息流
// =============================================================================

interface SubAgentPanelProps {
  entries: ThreadEntry[];
}

/** 子 agent 内部消息渲染 — 复用 ToolCallGroup 但不嵌套 AssistantBubble 的 avatar/间距 */
function SubGroupedView({ entries }: { entries: ThreadEntry[] }) {
  const grouped = groupToolCalls(entries);

  return (
    <>
      {grouped.map((item, i) => {
        if (item.type === "single") {
          const entry = item.entry;
          if (entry.type === "assistant_message") {
            // 子 agent 消息：紧凑样式，不显示头像
            return (
              <div key={entry.id || `sub-msg-${i}`} className="py-1">
                <SubAssistantText chunks={entry.chunks} />
              </div>
            );
          }
          if (entry.type === "user_message") {
            return null; // 子 agent 面板不显示用户消息
          }
          return null;
        }
        // 工具调用组 — 复用 ToolCallGroup
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: tool group entries lack unique key
          <div key={`sub-group-${i}`} className="-mt-1">
            <ToolCallGroup entries={item.entries} />
          </div>
        );
      })}
    </>
  );
}

/** 子 agent 文本输出 — 紧凑版 Markdown 渲染 */
function SubAssistantText({ chunks }: { chunks: AssistantMessageEntry["chunks"] }) {
  return (
    <div className="text-xs text-text-secondary whitespace-pre-wrap font-display leading-relaxed break-words">
      {chunks.map((chunk, i) => {
        if (chunk.type === "message") {
          // biome-ignore lint/suspicious/noArrayIndexKey: chunks are append-only, index is stable
          return <span key={`chunk-${i}`}>{chunk.text}</span>;
        }
        // thought 类型在子 agent 面板中不显示
        return null;
      })}
    </div>
  );
}

// =============================================================================
// 主组件
// =============================================================================

export const SubAgentPanel = memo(function SubAgentPanel({ entries }: SubAgentPanelProps) {
  if (!entries || entries.length === 0) return null;

  return (
    <div className="ml-1 border-l-2 border-brand/20 pl-3 py-1">
      <SubGroupedView entries={entries} />
    </div>
  );
});

// =============================================================================
// 工具调用分组逻辑（与 ChatView 相同）
// =============================================================================

type GroupedItem = { type: "single"; entry: ThreadEntry } | { type: "tool_group"; entries: ToolCallEntry[] };

function groupToolCalls(entries: ThreadEntry[]): GroupedItem[] {
  const result: GroupedItem[] = [];
  let currentToolGroup: ToolCallEntry[] = [];

  const flushToolGroup = () => {
    if (currentToolGroup.length > 0) {
      result.push({ type: "tool_group", entries: currentToolGroup });
    }
    currentToolGroup = [];
  };

  for (const entry of entries) {
    if (entry.type === "tool_call") {
      currentToolGroup.push(entry);
    } else {
      flushToolGroup();
      result.push({ type: "single", entry });
    }
  }
  flushToolGroup();

  return result;
}
