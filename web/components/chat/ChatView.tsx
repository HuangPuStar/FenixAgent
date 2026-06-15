import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { PlanDisplayEntry, ThreadEntry, ToolCallEntry } from "../../src/lib/types";
import { cn } from "../../src/lib/utils";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButtons,
} from "../ai-elements/conversation";
import { AgentBadge, AgentBadgeSkeleton, type AgentSkillInfo } from "./AgentBadge";
import { AssistantBubble, UserBubble } from "./MessageBubble";
import { PlanDisplay } from "./PlanView";
import { ToolCallGroup } from "./ToolCallGroup";

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
  agentName?: string;
  agentDescription?: string;
  agentSkills?: AgentSkillInfo[];
  sessionId?: string;
  envId?: string;
}

export function ChatView({
  entries,
  isLoading = false,
  onPermissionRespond,
  emptyTitle = "开始对话",
  emptyDescription = "输入消息开始聊天",
  agentName,
  agentDescription,
  agentSkills,
  sessionId,
  envId,
}: ChatViewProps) {
  // 将相邻的 ToolCallEntry 合并为一组
  const grouped = groupToolCalls(entries);
  const hasMessages = entries.length > 0;

  // debug：Ctrl+P 打印 entries 到控制台
  const handleDebugEntries = useCallback(() => {
    console.log("[ChatView] entries:", JSON.parse(JSON.stringify(entries)));
  }, [entries]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "p") {
        e.preventDefault();
        handleDebugEntries();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [handleDebugEntries]);

  return (
    <Conversation className="flex-1">
      <ConversationContent>
        {!hasMessages ? (
          isLoading && !agentName ? (
            <AgentBadgeSkeleton />
          ) : agentName ? (
            <AgentBadge name={agentName} description={agentDescription} skills={agentSkills ?? []} />
          ) : (
            <ConversationEmptyState title={emptyTitle} description={emptyDescription} />
          )
        ) : (
          <>
            {grouped.map((item, i) => {
              const isLastEntry = i === grouped.length - 1;
              if (item.type === "single") {
                const entryId = item.entry.type === "tool_call" ? item.entry.toolCall.id : item.entry.id;
                // 只有最后一条 assistant 消息且全局 loading 时才标记 streaming
                const entryIsStreaming = isLoading && isLastEntry && item.entry.type === "assistant_message";
                return (
                  <div key={entryId} className={cn(entrySpacing(entries, i))}>
                    <EntryRenderer
                      entry={item.entry}
                      isLoading={entryIsStreaming}
                      onPermissionRespond={onPermissionRespond}
                      sessionId={sessionId}
                      envId={envId}
                    />
                  </div>
                );
              }
              // 工具调用组 — 紧贴在助手消息下方
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: tool group entries lack a unique identifier
                <div key={`group-${i}`} className="-mt-2">
                  <ToolCallGroup entries={item.entries} onPermissionRespond={onPermissionRespond} />
                </div>
              );
            })}

            {/* 加载指示器 — loading 期间一直显示 */}
            {isLoading && <LoadingIndicator />}
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
  sessionId,
  envId,
}: {
  entry: ThreadEntry;
  isLoading: boolean;
  onPermissionRespond?: (requestId: string, optionId: string | null, optionKind: string | null) => void;
  sessionId?: string;
  envId?: string;
}) {
  switch (entry.type) {
    case "user_message":
      return <UserBubble entry={entry} />;
    case "assistant_message":
      return <AssistantBubble entry={entry} isStreaming={isLoading} sessionId={sessionId} envId={envId} />;
    case "tool_call":
      return <ToolCallGroup entries={[entry as ToolCallEntry]} onPermissionRespond={onPermissionRespond} />;
    case "plan":
      return <PlanDisplay entry={entry as PlanDisplayEntry} />;
    default:
      return null;
  }
}

// =============================================================================
// 工具调用分组逻辑
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
