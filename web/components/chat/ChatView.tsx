import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ThreadEntry, ToolCallEntry } from "../../src/lib/types";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButtons,
} from "../ai-elements/conversation";
import { AgentBadge, AgentBadgeSkeleton, type AgentSkillInfo } from "./AgentBadge";
import { ChatSelectionAction, PromptJumpRail } from "./chat-navigation-aids";
import { buildChatRenderBlocks, type ChatRenderItem } from "./chat-render-layout";
import { AssistantBubble, UserBubble } from "./MessageBubble";
import { ToolCallGroup } from "./ToolCallGroup";

// =============================================================================
// 统一聊天视图 — Anthropic 编辑式排版
// 无气泡间距，用垂直 rhythm 区分消息块
// =============================================================================

interface ChatViewProps {
  entries: ThreadEntry[];
  isLoading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  agentName?: string;
  agentDescription?: string;
  agentSkills?: AgentSkillInfo[];
  sessionId?: string;
  envId?: string;
}

export const ChatView = React.memo(
  function ChatView({
    entries,
    isLoading = false,
    emptyTitle,
    emptyDescription,
    agentName,
    agentDescription,
    agentSkills,
    sessionId,
    envId,
  }: ChatViewProps) {
    const { t } = useTranslation("components");
    const finalEmptyTitle = emptyTitle ?? t("chatView.startConversation");
    const finalEmptyDescription = emptyDescription ?? t("chatView.startConversationDesc");
    // 将相邻的 ToolCallEntry 合并为一组；memo 化避免 isLoading 等无关 prop 变化时重复 O(N) 分组
    const renderBlocks = useMemo(() => buildChatRenderBlocks(entries), [entries]);
    const hasMessages = entries.length > 0;
    // 滚动按钮只关心是否存在用户消息，memo 化避免每次渲染全量扫描
    const hasUserMessages = useMemo(() => entries.some((e) => e.type === "user_message"), [entries]);
    const userEntries = useMemo(
      () =>
        entries.filter(
          (entry): entry is Extract<ThreadEntry, { type: "user_message" }> => entry.type === "user_message",
        ),
      [entries],
    );

    return (
      <Conversation className="chat-conversation flex-1">
        <PromptJumpRail entries={userEntries} />
        <ConversationContent className="chat-conversation-content">
          {!hasMessages ? (
            isLoading && !agentName ? (
              <AgentBadgeSkeleton />
            ) : agentName ? (
              <AgentBadge name={agentName} description={agentDescription} skills={agentSkills ?? []} />
            ) : (
              <ConversationEmptyState title={finalEmptyTitle} description={finalEmptyDescription} />
            )
          ) : (
            <>
              {renderBlocks.map((block, blockIndex) => {
                if (block.type === "activity_chain") {
                  return (
                    <div key={`activity-${renderItemKey(block.items[0], blockIndex)}`} className="chat-activity-chain">
                      {block.items.map((item, itemIndex) => (
                        <ChatRenderItemView
                          key={renderItemKey(item, itemIndex)}
                          item={item}
                          isLoading={isLoading && item.type === "entry" && item.entry === entries.at(-1)}
                          sessionId={sessionId}
                          envId={envId}
                        />
                      ))}
                    </div>
                  );
                }
                return (
                  <ChatRenderItemView
                    key={renderItemKey(block.item, blockIndex)}
                    item={block.item}
                    isLoading={isLoading && block.item.type === "entry" && block.item.entry === entries.at(-1)}
                    sessionId={sessionId}
                    envId={envId}
                  />
                );
              })}

              {/* 加载指示器 — loading 期间一直显示 */}
              {isLoading && <LoadingIndicator />}
            </>
          )}
          <ConversationScrollButtons hasUserMessages={hasUserMessages} />
        </ConversationContent>
        <ChatSelectionAction contextScope={sessionId} />
      </Conversation>
    );
  },
  // 比较所有 prop 引用（含 onPermissionRespond），因为调用方现在传入稳定 useCallback
  (prev, next) =>
    prev.entries === next.entries &&
    prev.isLoading === next.isLoading &&
    prev.emptyTitle === next.emptyTitle &&
    prev.emptyDescription === next.emptyDescription &&
    prev.agentName === next.agentName &&
    prev.agentDescription === next.agentDescription &&
    prev.agentSkills === next.agentSkills &&
    prev.sessionId === next.sessionId &&
    prev.envId === next.envId,
);

// =============================================================================
// 间距逻辑 — 用户消息前后间距大，工具调用紧贴
// =============================================================================

function entryClassName(item: Extract<ChatRenderItem, { type: "entry" }>): string {
  if (item.density === "activity") return "chat-entry chat-entry--activity";
  const { entry } = item;
  // 用户消息前后大留白 — Claude.ai 式宽松间距
  if (entry?.type === "user_message") {
    return "chat-entry chat-entry--user pt-10 pb-3";
  }
  // 助手消息 — 工具调用紧贴，否则多留白
  if (entry?.type === "assistant_message") {
    return "chat-entry chat-entry--assistant pt-3 pb-6";
  }
  return "chat-entry py-2";
}

function renderItemKey(item: ChatRenderItem | undefined, fallbackIndex: number): string {
  if (!item) return `item-${fallbackIndex}`;
  if (item.type === "tool_group") return item.entries[0]?.toolCall.id ?? `tool-group-${fallbackIndex}`;
  return item.entry.type === "tool_call" ? item.entry.toolCall.id : item.entry.id;
}

function ChatRenderItemView({
  item,
  isLoading,
  sessionId,
  envId,
}: {
  item: ChatRenderItem;
  isLoading: boolean;
  sessionId?: string;
  envId?: string;
}) {
  if (item.type === "tool_group") {
    return (
      <div className="chat-entry chat-entry--tool-group">
        <ToolCallGroup entries={item.entries} />
      </div>
    );
  }

  const entryId = item.entry.type === "tool_call" ? item.entry.toolCall.id : item.entry.id;
  const entryIsStreaming = isLoading && item.entry.type === "assistant_message";
  return (
    <div id={`chat-entry-${entryId}`} className={entryClassName(item)}>
      <EntryRenderer entry={item.entry} isLoading={entryIsStreaming} sessionId={sessionId} envId={envId} />
    </div>
  );
}

// =============================================================================
// 单条目渲染器
// =============================================================================

const EntryRenderer = React.memo(
  function EntryRenderer({
    entry,
    isLoading,
    sessionId,
    envId,
  }: {
    entry: ThreadEntry;
    isLoading: boolean;
    sessionId?: string;
    envId?: string;
  }) {
    switch (entry.type) {
      case "user_message":
        return <UserBubble entry={entry} />;
      case "assistant_message":
        return <AssistantBubble entry={entry} isStreaming={isLoading} sessionId={sessionId} envId={envId} />;
      case "tool_call":
        return <ToolCallGroup entries={[entry as ToolCallEntry]} />;
      default:
        return null;
    }
  },
  // 比较所有 prop 引用（含 onPermissionRespond），调用方传入稳定 useCallback
  (prev, next) =>
    prev.entry === next.entry &&
    prev.isLoading === next.isLoading &&
    prev.sessionId === next.sessionId &&
    prev.envId === next.envId,
);

// =============================================================================
// 加载指示器 — 品牌色渐变脉冲
// =============================================================================

function LoadingIndicator() {
  const { t } = useTranslation("components");
  return (
    <div className="flex items-center gap-3 pt-3">
      <div className="chat-loading-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <span className="text-xs text-text-muted loading-text-shimmer">{t("chatView.thinking")}</span>
    </div>
  );
}
