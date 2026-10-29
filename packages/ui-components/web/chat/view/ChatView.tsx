import "./ChatView.css";

import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { Spinner } from "../../ui/spinner";
import { buildChatRenderBlocks } from "../lib/chat-render-layout";
import { Conversation, ConversationContent, ConversationScrollButtons } from "../primitives/conversation";
import type { AgentSkillInfo } from "../shell/AgentBadge";
import { SubAgentToolCallGroupContext } from "../timeline/sub-agent-tool-call-context";
import { ToolCallGroup } from "../timeline/ToolCallGroup";
import type { ThreadEntry, ToolCallEntry } from "../types";
import { ActivityChain } from "./ActivityChain";
import { ChatEmptyState } from "./chat-empty-state";
import { ChatSelectionAction, PromptJumpRail } from "./chat-navigation-aids";
import { ChatRenderItemView, renderItemKey } from "./chat-render-item-view";
import { ChatLoadEarlier, useChatRenderWindow } from "./chat-render-window";
import type { CardEmitter } from "./internal/card-emitter";

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
  /** 协议层仍有更早历史可加载（未订阅块或投影窗口外条目）。 */
  hasEarlierHistory?: boolean;
  /** 上层数据窗口已加载但尚未展示的条目数；用于按钮文案。 */
  earlierMessageCount?: number;
  /** 协议层更早历史加载中。 */
  historyLoading?: boolean;
  /** 显式加载协议层更早历史。 */
  onLoadEarlierHistory?: () => void;
  /** 上层已经把 entries 截成窗口；true 时本组件不再做第二层窗口，避免“揭示后又被裁掉”。 */
  preWindowed?: boolean;
}

function renderSubAgentToolGroup(entries: ToolCallEntry[]) {
  return <ToolCallGroup entries={entries} />;
}

/**
 * 统一聊天视图（消息时间线 + 空状态 + 加载指示 + 选区动作 + 提示词导航）。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/ChatView.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
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
    hasEarlierHistory = false,
    earlierMessageCount = 0,
    historyLoading = false,
    onLoadEarlierHistory,
    preWindowed = false,
  }: ChatViewProps) {
    const { t } = useTranslation(UI_COMPONENTS_NS);
    const finalEmptyTitle = emptyTitle ?? t("chat.components.chatView.startConversation");
    const finalEmptyDescription = emptyDescription ?? t("chat.components.chatView.startConversationDesc");
    // 大基线只挂载最近 100 条，避免单次提交 >500ms；更早消息由用户显式加载。
    const { visible: visibleEntries, hiddenCount, loadEarlier } = useChatRenderWindow(entries, sessionId, !preWindowed);
    // 数据层已经截到 100 条时，ChatView 自身 hiddenCount 为 0；协议层还剩更早历史时仍要保留入口。
    const earlierCount = Math.max(hiddenCount, earlierMessageCount);
    const showEarlier = earlierCount > 0 || hasEarlierHistory;
    const handleLoadEarlier = useCallback(() => {
      if (hiddenCount > 0) {
        loadEarlier();
        return;
      }
      onLoadEarlierHistory?.();
    }, [hiddenCount, loadEarlier, onLoadEarlierHistory]);
    // 将相邻的 ToolCallEntry 合并为一组；memo 化避免 isLoading 等无关 prop 变化时重复 O(N) 分组
    const renderBlocks = useMemo(() => buildChatRenderBlocks(visibleEntries), [visibleEntries]);
    // plan 由 ChatStatusPanel 展示、不进时间线；它落在末尾时不能算作活动链的末条条目，否则链会误折叠。
    const lastRenderableEntry = useMemo(() => {
      for (let index = visibleEntries.length - 1; index >= 0; index -= 1) {
        const entry = visibleEntries[index];
        if (entry.type !== "plan") return entry;
      }
      return;
    }, [visibleEntries]);
    const hasMessages = renderBlocks.length > 0;
    // 滚动按钮只关心是否存在用户消息，memo 化避免每次渲染全量扫描
    const hasUserMessages = useMemo(() => visibleEntries.some((e) => e.type === "user_message"), [visibleEntries]);
    const userEntries = useMemo(
      () =>
        visibleEntries.filter(
          (entry): entry is Extract<ThreadEntry, { type: "user_message" }> => entry.type === "user_message",
        ),
      [visibleEntries],
    );

    return (
      <SubAgentToolCallGroupContext.Provider value={renderSubAgentToolGroup}>
        <Conversation className="min-h-0 flex-1">
          <PromptJumpRail entries={userEntries} />
          <ConversationContent
            // 源 `.chat-conversation-content` 的声明；`sm:` 级重复是为了压过 `ConversationContent`
            // 自带的 `sm:py-12`（变体工具类在样式表里晚于基础工具类，仅写基础 `pt/pb` 会被它顶掉）。
            className="min-h-full max-w-200 gap-0 pt-7.5 pb-2 sm:pt-7.5 sm:pb-2"
            data-slot="chat-conversation-content"
          >
            {!hasMessages ? (
              isLoading && !agentName ? (
                // 会话加载中：用标准转圈加载态，不再渲染工牌卡骨架（卡片会被误读为会话内容）。
                <Spinner variant="panel" className="min-h-40" label={t("chat.components.chatView.loadingSession")} />
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
                {showEarlier && (
                  <ChatLoadEarlier
                    hiddenCount={earlierCount}
                    onLoadEarlier={handleLoadEarlier}
                    loading={historyLoading}
                    scrollToFirstNew={hiddenCount > 0}
                  />
                )}
                {renderBlocks.map((block, blockIndex) => {
                  if (block.type === "activity_chain") {
                    const previousBlock = renderBlocks[blockIndex - 1];
                    const followsAssistantMessage =
                      previousBlock?.type === "item" &&
                      previousBlock.item.type === "entry" &&
                      previousBlock.item.entry.type === "assistant_message";
                    return (
                      <ActivityChain
                        key={`activity-${renderItemKey(block.items[0], blockIndex)}`}
                        items={block.items}
                        isLoading={isLoading}
                        lastEntry={lastRenderableEntry}
                        afterMessage={followsAssistantMessage}
                        sessionId={sessionId}
                        envId={envId}
                        cardEmitter={cardEmitter}
                        onQuote={onQuote}
                        onOpenWorkspaceFile={onOpenWorkspaceFile}
                      />
                    );
                  }
                  return (
                    <ChatRenderItemView
                      key={renderItemKey(block.item, blockIndex)}
                      item={block.item}
                      isLoading={isLoading && block.item.type === "entry" && block.item.entry === visibleEntries.at(-1)}
                      sessionId={sessionId}
                      envId={envId}
                      cardEmitter={cardEmitter}
                      onQuote={onQuote}
                      onOpenWorkspaceFile={onOpenWorkspaceFile}
                    />
                  );
                })}

                {/* 加载指示器 — loading 期间一直显示，阶段文字由末条条目类型派生 */}
                {isLoading && <LoadingIndicator stage={deriveLoadingStage(visibleEntries)} />}
              </>
            )}
            <ConversationScrollButtons hasUserMessages={hasUserMessages} />
          </ConversationContent>
          <ChatSelectionAction contextScope={sessionId} onQuote={onQuote} />
        </Conversation>
      </SubAgentToolCallGroupContext.Provider>
    );
  },
  // 比较所有 prop 引用（含历史加载回调），因为调用方现在传入稳定 useCallback
  areChatViewPropsEqual,
);

/**
 * ChatView 的 memo 比较器：必须覆盖全部会影响渲染的 props。
 *
 * 调用方传入稳定回调；漏比历史加载相关 props 会让按钮在 `historyLoading` / 数量变化时
 * 停留在旧状态，因此这几项与渲染窗口开关一并纳入。
 */
function areChatViewPropsEqual(prev: Readonly<ChatViewProps>, next: Readonly<ChatViewProps>): boolean {
  return (
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
    prev.emptyLogoSrc === next.emptyLogoSrc &&
    prev.hasEarlierHistory === next.hasEarlierHistory &&
    prev.earlierMessageCount === next.earlierMessageCount &&
    prev.historyLoading === next.historyLoading &&
    prev.onLoadEarlierHistory === next.onLoadEarlierHistory &&
    prev.preWindowed === next.preWindowed
  );
}

// =============================================================================
// 空状态 — 与 Chat 设计稿保持一致
// =============================================================================

// =============================================================================
// 加载指示器 — 阶段文字 + 流光条
// =============================================================================

/**
 * 加载阶段。只有这三步 + 兜底：能区分的阶段必须各有真实信号（见 `deriveLoadingStage`），
 * 拿不到信号的阶段不单独显示，一律并入 `working` 的通用文案。
 */
type LoadingStage = "thinking" | "generating" | "callingTool" | "working";

/**
 * 从条目派生加载阶段。信号只有两处，都是真实状态：
 * - `isLoading`：宿主 `ChatInterface` 由 `sessionState.loading != null`（Y.Doc 投影）算出。
 *   更细的 `loading.kind`（`session/bootstrap`／`session/respond`／`tool/executing`／
 *   `permission/pending`）与 `loading.label` 都停在宿主侧，没有透传进本组件，因此用不到；
 * - `entries` 末条条目的类型，即当前投影出来的最后一步。
 *
 * 据此能可靠区分三步：末条 `tool_call` → 工具刚发起或仍在跑；末条 `assistant_message` →
 * 助手正在产出（判据与 `ChatRenderItemView` 的 `isStreaming` 同源：末条 + loading）；
 * 末条 `user_message` → 本轮尚无任何产出。末条是 `plan` 或空列表时拿不到可靠信号，退回 `working`。
 */
function deriveLoadingStage(entries: readonly ThreadEntry[]): LoadingStage {
  const last = entries.at(-1);
  if (last?.type === "tool_call") return "callingTool";
  if (last?.type === "assistant_message") return "generating";
  if (last?.type === "user_message") return "thinking";
  return "working";
}

/**
 * 流式等待指示器：当前阶段文字 + 一条扫光的细条。
 *
 * 阶段切换才改文案，不随流式 token 变化——每秒多次的 state 更新在这里没有立足点，扫光也是纯 CSS 动画
 * （`./ChatView.css` 的 `.chat-loading-beam`），不进 React 渲染循环。
 */
function LoadingIndicator({ stage }: { stage: LoadingStage }) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  let label: string;
  switch (stage) {
    case "callingTool":
      label = t("chat.components.chatView.stage.callingTool");
      break;
    case "generating":
      label = t("chat.components.chatView.stage.generating");
      break;
    case "thinking":
      label = t("chat.components.chatView.stage.thinking");
      break;
    default:
      label = t("chat.components.chatView.stage.working");
  }

  return (
    /* `role="status"` + `aria-live="polite"`：与输入岛的上传／粘贴进行中提示同一口径，让读屏播报
       阶段变化；文案只在阶段切换时变，不会对每条流式 token 反复播报。 */
    <div className="pt-3" role="status" aria-live="polite">
      {/* 宽度由文案撑开（`w-fit` 收窄后，轨道的 `w-full` 即等于文字宽度），轨道高度 2px。颜色全部走 token：
          轨道 `surface-3`（中性灰）、光带 `brand-light`；裁切（`overflow-hidden`）让光带只在轨道内可见。 */}
      <div className="w-fit">
        <span className="text-xs text-text-muted">{label}</span>
        <div aria-hidden="true" className="mt-1.5 h-0.5 w-full overflow-hidden rounded-full bg-surface-3">
          <div className="chat-loading-beam h-full w-1/3 rounded-full bg-gradient-to-r from-transparent via-brand-light to-transparent" />
        </div>
      </div>
    </div>
  );
}
