import { ArrowUpRight } from "lucide-react";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../lib/i18n";
import { buildChatRenderBlocks, type ChatRenderItem } from "../lib/chat-render-layout";
import { Conversation, ConversationContent, ConversationScrollButtons } from "../primitives/conversation";
import { AgentBadgeSkeleton, type AgentSkillInfo } from "../shell/AgentBadge";
import { SubAgentToolCallGroupContext } from "../timeline/sub-agent-tool-call-context";
import { ToolCallGroup } from "../timeline/ToolCallGroup";
import type { ThreadEntry, ToolCallEntry } from "../types";
import { ChatSelectionAction, PromptJumpRail } from "./chat-navigation-aids";
import type { CardEmitter } from "./internal/card-emitter";
import { AssistantBubble, UserBubble } from "./MessageBubble";

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
  /** 注入到每条助手消息的卡片事件通道（未注入时各消息自建实例）。 */
  cardEmitter?: CardEmitter;
  /** 点击空状态建议提示词时回调，替代源实现的 `chat:apply-suggested-prompt` window 自定义事件。 */
  onApplySuggestedPrompt?: (prompt: string) => void;
  /** 消息「引用」动作回调，替代源实现的 `chat:quote` window 自定义事件。 */
  onQuote?: (text: string, sessionId?: string) => void;
  /** 消息正文中工作区文件引用的打开回调（宿主负责预览路由）。 */
  onOpenWorkspaceFile?: (envId: string, path: string) => void;
  /** 空状态品牌图地址，默认与源实现一致：宿主 `public/brand/fenix-agent-logo-mark.png`。 */
  emptyLogoSrc?: string;
}

function renderSubAgentToolGroup(entries: ToolCallEntry[]) {
  return <ToolCallGroup entries={entries} />;
}

/**
 * 把宿主的 `onOpenWorkspaceFile(envId, path)` 绑定为工具卡片所需的 `onPreviewFile(path)`。
 *
 * 来源差异说明：源实现给 `ToolCallGroup` 透传的是 `envId`，本包 timeline 组已把该契约纯化为
 * `onPreviewFile(path)` 回调；View 层是唯一知道当前会话 envId 的地方，因此在此完成绑定。
 */
function bindPreviewFile(
  envId: string | undefined,
  onOpenWorkspaceFile?: (envId: string, path: string) => void,
): ((path: string) => void) | undefined {
  if (!envId || !onOpenWorkspaceFile) return;
  return (path) => onOpenWorkspaceFile(envId, path);
}

/**
 * 统一聊天视图（消息时间线 + 空状态 + 加载指示 + 选区动作 + 提示词导航）。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/ChatView.tsx`。
 * 纯化改动点：
 * - `@/components/ai-elements/conversation` → 包内 `../primitives/conversation`；`@/src/lib/*` → 包内相对路径。
 * - `chat:apply-suggested-prompt` / `chat:quote` window 自定义事件改为 `onApplySuggestedPrompt` /
 *   `onQuote` 回调 prop，并向下透传给消息气泡与选区动作。
 * - `AgentBadge` / `ToolCallGroup` / `SubAgentToolCallGroupContext` 为跨组依赖（shell、timeline 组），
 *   按最终路径导入；`useCardEmitter` 通道改为 `cardEmitter` 透传。
 * - i18n 命名空间收敛为包内单一命名空间并加 `chat.components.` 前缀；类名、DOM 结构与 memo
 *   比较器逻辑逐字保留（新增 props 一并纳入比较）。
 */
export const ChatView = React.memo(
  function ChatView({
    entries,
    isLoading = false,
    emptyTitle,
    emptyDescription,
    agentName,
    sessionId,
    envId,
    cardEmitter,
    onApplySuggestedPrompt,
    onQuote,
    onOpenWorkspaceFile,
    emptyLogoSrc,
  }: ChatViewProps) {
    const { t } = useTranslation(UI_COMPONENTS_NS);
    const finalEmptyTitle = emptyTitle ?? t("chat.components.chatView.startConversation");
    const finalEmptyDescription = emptyDescription ?? t("chat.components.chatView.startConversationDesc");
    // 将相邻的 ToolCallEntry 合并为一组；memo 化避免 isLoading 等无关 prop 变化时重复 O(N) 分组
    const renderBlocks = useMemo(() => buildChatRenderBlocks(entries), [entries]);
    const hasMessages = renderBlocks.length > 0;
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
      <SubAgentToolCallGroupContext.Provider value={renderSubAgentToolGroup}>
        <Conversation className="chat-conversation flex-1">
          <PromptJumpRail entries={userEntries} />
          <ConversationContent className="chat-conversation-content">
            {!hasMessages ? (
              isLoading && !agentName ? (
                <AgentBadgeSkeleton />
              ) : (
                <ChatEmptyState
                  title={finalEmptyTitle}
                  description={finalEmptyDescription}
                  agentName={agentName}
                  logoSrc={emptyLogoSrc}
                  onApplySuggestedPrompt={onApplySuggestedPrompt}
                />
              )
            ) : (
              <>
                {renderBlocks.map((block, blockIndex) => {
                  if (block.type === "activity_chain") {
                    const previousBlock = renderBlocks[blockIndex - 1];
                    const followsAssistantMessage =
                      previousBlock?.type === "item" &&
                      previousBlock.item.type === "entry" &&
                      previousBlock.item.entry.type === "assistant_message";
                    return (
                      <div
                        key={`activity-${renderItemKey(block.items[0], blockIndex)}`}
                        className={`chat-activity-chain${followsAssistantMessage ? " chat-activity-chain--after-message" : ""}`}
                      >
                        {block.items.map((item, itemIndex) => (
                          <ChatRenderItemView
                            key={renderItemKey(item, itemIndex)}
                            item={item}
                            isLoading={isLoading && item.type === "entry" && item.entry === entries.at(-1)}
                            sessionId={sessionId}
                            envId={envId}
                            cardEmitter={cardEmitter}
                            onQuote={onQuote}
                            onOpenWorkspaceFile={onOpenWorkspaceFile}
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
                      cardEmitter={cardEmitter}
                      onQuote={onQuote}
                      onOpenWorkspaceFile={onOpenWorkspaceFile}
                    />
                  );
                })}

                {/* 加载指示器 — loading 期间一直显示 */}
                {isLoading && <LoadingIndicator />}
              </>
            )}
            <ConversationScrollButtons hasUserMessages={hasUserMessages} />
          </ConversationContent>
          <ChatSelectionAction contextScope={sessionId} onQuote={onQuote} />
        </Conversation>
      </SubAgentToolCallGroupContext.Provider>
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
    prev.envId === next.envId &&
    prev.cardEmitter === next.cardEmitter &&
    prev.onApplySuggestedPrompt === next.onApplySuggestedPrompt &&
    prev.onQuote === next.onQuote &&
    prev.onOpenWorkspaceFile === next.onOpenWorkspaceFile &&
    prev.emptyLogoSrc === next.emptyLogoSrc,
);

// =============================================================================
// 空状态 — 与 Chat 设计稿保持一致
// =============================================================================

/** 空状态默认品牌图（宿主 public 资源路径，与源实现一致）。 */
const DEFAULT_EMPTY_LOGO_SRC = `${import.meta.env.BASE_URL}brand/fenix-agent-logo-mark.png`;

/**
 * 会话空状态：品牌图 + 标题 + 说明 + 三条建议提示词。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/ChatView.tsx` 内的 `ChatEmptyState`。
 * 纯化改动点：建议提示词的 `chat:apply-suggested-prompt` window 事件改为 `onApplySuggestedPrompt`
 * 回调；品牌图地址提为 `logoSrc`（默认值与源表达式一致）；i18n 键加 `chat.components.` 前缀。
 */
function ChatEmptyState({
  title,
  description,
  agentName,
  logoSrc = DEFAULT_EMPTY_LOGO_SRC,
  onApplySuggestedPrompt,
}: {
  title: string;
  description: string;
  agentName?: string;
  logoSrc?: string;
  onApplySuggestedPrompt?: (prompt: string) => void;
}) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const suggestions = [
    t("chat.components.chatEmpty.suggestionReview"),
    t("chat.components.chatEmpty.suggestionPlan"),
    t("chat.components.chatEmpty.suggestionBuild"),
  ];

  return (
    <section className="chat-empty-state" aria-labelledby="chat-empty-title">
      <span className="chat-empty-mark" aria-hidden="true">
        <img src={logoSrc} alt="" />
      </span>
      <small>
        {agentName
          ? t("chat.components.chatEmpty.readyWithAgent", { agentName })
          : t("chat.components.chatEmpty.eyebrow")}
      </small>
      <h2 id="chat-empty-title">{title}</h2>
      <p>{description}</p>
      <div className="chat-empty-suggestions">
        {suggestions.map((suggestion) => (
          <button key={suggestion} type="button" onClick={() => onApplySuggestedPrompt?.(suggestion)}>
            <span>{suggestion}</span>
            <ArrowUpRight aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  );
}

// =============================================================================
// 间距逻辑 — 用户消息前后间距大，工具调用紧贴
// =============================================================================

/** 按渲染项密度与条目类型给出外层容器类名（源实现的间距规则逐字保留）。 */
function entryClassName(item: Extract<ChatRenderItem, { type: "entry" }>): string {
  if (item.density === "activity") return "chat-entry chat-entry--activity";
  const { entry } = item;
  // 用户消息前后大留白 — Claude.ai 式宽松间距
  if (entry?.type === "user_message") {
    return "chat-entry chat-entry--user py-3";
  }
  // 助手消息 — 工具调用紧贴，否则多留白
  if (entry?.type === "assistant_message") {
    return "chat-entry chat-entry--assistant py-3";
  }
  return "chat-entry py-2";
}

/** 生成渲染项 key：优先使用协议 id，缺失时回落到下标。 */
function renderItemKey(item: ChatRenderItem | undefined, fallbackIndex: number): string {
  if (!item) return `item-${fallbackIndex}`;
  if (item.type === "tool_group") return item.entries[0]?.toolCall.id ?? `tool-group-${fallbackIndex}`;
  return item.entry.type === "tool_call" ? item.entry.toolCall.id : item.entry.id;
}

interface ChatRenderItemViewProps {
  item: ChatRenderItem;
  isLoading: boolean;
  sessionId?: string;
  envId?: string;
  cardEmitter?: CardEmitter;
  onQuote?: (text: string, sessionId?: string) => void;
  onOpenWorkspaceFile?: (envId: string, path: string) => void;
}

/**
 * 渲染单个渲染项：工具组走 ToolCallGroup，其余走 EntryRenderer。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/ChatView.tsx`。
 * 纯化改动点：新增向下透传 `cardEmitter` / `onQuote` / `onOpenWorkspaceFile`（宿主注入点）；
 * 消息节点 id `chat-entry-${entryId}` 为跨组件契约（PromptJumpRail 依赖），保持不变。
 */
function ChatRenderItemView({
  item,
  isLoading,
  sessionId,
  envId,
  cardEmitter,
  onQuote,
  onOpenWorkspaceFile,
}: ChatRenderItemViewProps) {
  if (item.type === "tool_group") {
    return (
      <div className="chat-entry chat-entry--tool-group">
        <ToolCallGroup entries={item.entries} onPreviewFile={bindPreviewFile(envId, onOpenWorkspaceFile)} />
      </div>
    );
  }

  const entryId = item.entry.type === "tool_call" ? item.entry.toolCall.id : item.entry.id;
  const entryIsStreaming = isLoading && item.entry.type === "assistant_message";
  return (
    <div id={`chat-entry-${entryId}`} className={entryClassName(item)}>
      <EntryRenderer
        entry={item.entry}
        isLoading={entryIsStreaming}
        sessionId={sessionId}
        envId={envId}
        cardEmitter={cardEmitter}
        onQuote={onQuote}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
      />
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
    cardEmitter,
    onQuote,
    onOpenWorkspaceFile,
  }: {
    entry: ThreadEntry;
    isLoading: boolean;
    sessionId?: string;
    envId?: string;
    cardEmitter?: CardEmitter;
    onQuote?: (text: string, sessionId?: string) => void;
    onOpenWorkspaceFile?: (envId: string, path: string) => void;
  }) {
    switch (entry.type) {
      case "user_message":
        return <UserBubble entry={entry} envId={envId} onOpenWorkspaceFile={onOpenWorkspaceFile} />;
      case "assistant_message":
        return (
          <AssistantBubble
            entry={entry}
            isStreaming={isLoading}
            sessionId={sessionId}
            envId={envId}
            cardEmitter={cardEmitter}
            onQuote={onQuote}
          />
        );
      case "tool_call":
        return (
          <ToolCallGroup
            entries={[entry as ToolCallEntry]}
            onPreviewFile={bindPreviewFile(envId, onOpenWorkspaceFile)}
          />
        );
      case "plan":
        return null;
      default:
        return null;
    }
  },
  // 比较所有 prop 引用（含 onPermissionRespond），调用方传入稳定 useCallback
  (prev, next) =>
    prev.entry === next.entry &&
    prev.isLoading === next.isLoading &&
    prev.sessionId === next.sessionId &&
    prev.envId === next.envId &&
    prev.cardEmitter === next.cardEmitter &&
    prev.onQuote === next.onQuote &&
    prev.onOpenWorkspaceFile === next.onOpenWorkspaceFile,
);

// =============================================================================
// 加载指示器 — 品牌色渐变脉冲
// =============================================================================

/** 流式等待指示器：三点脉冲 + 文案 shimer。 */
function LoadingIndicator() {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  return (
    <div className="flex items-center gap-3 pt-3">
      <div className="chat-loading-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <span className="text-xs text-text-muted loading-text-shimmer">{t("chat.components.chatView.thinking")}</span>
    </div>
  );
}
