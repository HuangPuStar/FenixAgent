import type { ThreadEntry, ToolCallEntry, PlanDisplayEntry } from "../../src/lib/types";
import { cn } from "../../src/lib/utils";
import { UserBubble, AssistantBubble } from "./MessageBubble";
import { ToolCallGroup } from "./ToolCallGroup";
import { PlanDisplay } from "./PlanView";
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButtons } from "../ai-elements/conversation";

// =============================================================================
// 统一聊天视图 — Anthropic 编辑式排版
// 无气泡间距，用垂直 rhythm 区分消息块
// =============================================================================

interface ChatViewProps {
  entries: ThreadEntry[];
  isLoading?: boolean;
  onPermissionRespond?: (requestId: string, optionId: string | null, optionKind: string | null) => void;
  emptyTitle?: string;
  emptyDescription?: string;
}

export function ChatView({
  entries,
  isLoading = false,
  onPermissionRespond,
  emptyTitle = "开始对话",
  emptyDescription = "输入消息开始聊天",
}: ChatViewProps) {
  // 将相邻的 ToolCallEntry 合并为一组
  const grouped = groupToolCalls(entries);
  const hasMessages = entries.length > 0;

  // 检查是否正在加载（最后一个条目是用户消息）
  const showThinking = isLoading && entries.length > 0 && entries[entries.length - 1]?.type === "user_message";

  return (
    <Conversation className="flex-1">
      <ConversationContent>
        {!hasMessages ? (
          <ConversationEmptyState
            title={emptyTitle}
            description={emptyDescription}
          />
        ) : (
          <>
            {grouped.map((item, i) => {
              if (item.type === "single") {
                return (
                  <div key={`entry-${i}`} className={cn(entrySpacing(entries, i))}>
                    <EntryRenderer entry={item.entry} isLoading={isLoading} onPermissionRespond={onPermissionRespond} />
                  </div>
                );
              }
              // 工具调用组 — 紧贴在助手消息下方
              return (
                <div key={`group-${i}`} className="-mt-2">
                  <ToolCallGroup entries={item.entries} onPermissionRespond={onPermissionRespond} />
                </div>
              );
            })}

            {/* 思考指示器 — Anthropic 打字动画 */}
            {showThinking && (
              <div className="flex gap-4 items-start">
                <div className="w-8 h-8 rounded-lg bg-brand/8 flex items-center justify-center flex-shrink-0">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle cx="12" cy="6" r="2.5" fill="var(--color-brand)" />
                    <circle cx="6" cy="16" r="2.5" fill="var(--color-brand)" opacity=".85" />
                    <circle cx="18" cy="16" r="2.5" fill="var(--color-brand)" opacity=".85" />
                    <circle cx="12" cy="12" r="1.5" fill="var(--color-brand)" opacity=".6" />
                    <line x1="12" y1="8.5" x2="12" y2="10.5" stroke="var(--color-brand)" strokeWidth="1.2" opacity=".5" />
                    <line x1="12" y1="13.5" x2="7.2" y2="15.2" stroke="var(--color-brand)" strokeWidth="1.2" opacity=".5" />
                    <line x1="12" y1="13.5" x2="16.8" y2="15.2" stroke="var(--color-brand)" strokeWidth="1.2" opacity=".5" />
                    <line x1="8.2" y1="16" x2="15.8" y2="16" stroke="var(--color-brand)" strokeWidth="1" opacity=".3" />
                  </svg>
                </div>
                <div className="flex items-center gap-1 pt-2">
                  <span className="chat-typing-indicator" aria-hidden="true">
                    <span></span><span></span><span></span>
                  </span>
                </div>
              </div>
            )}
          </>
        )}
        <ConversationScrollButtons hasUserMessages={entries.some((e) => e.type === "user_message")} />
      </ConversationContent>
    </Conversation>
  );
}

// =============================================================================
// 间距逻辑 — 用户消息前后间距大，工具调用紧贴
// =============================================================================

function entrySpacing(entries: ThreadEntry[], index: number): string {
  const entry = entries[index];
  // 用户消息前后大留白 — Claude.ai 式宽松间距
  if (entry?.type === "user_message") {
    return "pt-10 pb-3";
  }
  // 助手消息 — 工具调用紧贴，否则多留白
  if (entry?.type === "assistant_message") {
    const next = entries[index + 1];
    if (next?.type === "tool_call") {
      return "pt-3 pb-1";
    }
    return "pt-3 pb-8";
  }
  // Plan 条目
  if (entry?.type === "plan") {
    return "pt-3 pb-3";
  }
  return "py-2";
}

// =============================================================================
// 单条目渲染器
// =============================================================================

function EntryRenderer({
  entry,
  isLoading,
  onPermissionRespond,
}: {
  entry: ThreadEntry;
  isLoading: boolean;
  onPermissionRespond?: (requestId: string, optionId: string | null, optionKind: string | null) => void;
}) {
  switch (entry.type) {
    case "user_message":
      return <UserBubble entry={entry} />;
    case "assistant_message":
      return <AssistantBubble entry={entry} isStreaming={isLoading} />;
    case "tool_call":
      return (
        <ToolCallGroup
          entries={[entry as ToolCallEntry]}
          onPermissionRespond={onPermissionRespond}
        />
      );
    case "plan":
      return <PlanDisplay entry={entry as PlanDisplayEntry} />;
    default:
      return null;
  }
}

// =============================================================================
// 工具调用分组逻辑
// =============================================================================

type GroupedItem =
  | { type: "single"; entry: ThreadEntry }
  | { type: "tool_group"; entries: ToolCallEntry[] };

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
