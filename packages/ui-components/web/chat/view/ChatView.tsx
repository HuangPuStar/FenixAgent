import "./ChatView.css";

import { ArrowUpRight } from "lucide-react";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { cn } from "../../lib/cn";
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

/** 活动链作用域内的子 Agent 工具组渲染器：与链内其它工具行一致地带上对齐补偿。 */
function renderChainToolGroup(entries: ToolCallEntry[]) {
  return <ToolCallGroup entries={entries} inActivityChain />;
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
                        // 本行工具类即源 `chat-design-messages.css` 的 `.chat-activity-chain` 声明；
                        // 链内工具行的负边距对齐改由 `inActivityChain` 透传（源为后代选择器）。
                        className={cn(
                          "relative grid gap-px mx-0 mt-0.5 mb-2 pl-8",
                          "before:absolute before:top-2.75 before:bottom-2.75 before:left-2.75 before:w-px before:bg-slate-200 before:content-['']",
                          followsAssistantMessage && "-mt-3.5",
                        )}
                        data-slot="chat-activity-chain"
                        data-after-message={followsAssistantMessage || undefined}
                      >
                        {/* 链内的子 Agent 面板若再渲染工具组，同样属于「链内」——用作用域化的渲染器覆盖
                            Context（源的后代选择器对嵌套工具组一视同仁）。 */}
                        <SubAgentToolCallGroupContext.Provider value={renderChainToolGroup}>
                          {block.items.map((item, itemIndex) => (
                            <ChatRenderItemView
                              key={renderItemKey(item, itemIndex)}
                              item={item}
                              inActivityChain
                              isLoading={isLoading && item.type === "entry" && item.entry === entries.at(-1)}
                              sessionId={sessionId}
                              envId={envId}
                              cardEmitter={cardEmitter}
                              onQuote={onQuote}
                              onOpenWorkspaceFile={onOpenWorkspaceFile}
                            />
                          ))}
                        </SubAgentToolCallGroupContext.Provider>
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

                {/* 加载指示器 — loading 期间一直显示，阶段文字由末条条目类型派生 */}
                {isLoading && <LoadingIndicator stage={deriveLoadingStage(entries)} />}
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
 * 复制自 `packages/agent-runtime/web/components/chat/ChatView.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除） 内的 `ChatEmptyState`。
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
    <section
      className="flex min-h-0 flex-1 flex-col items-center justify-center p-10 text-center max-sm:px-2 max-sm:py-7"
      data-slot="chat-empty-state"
      aria-labelledby="chat-empty-title"
    >
      <span
        className="grid h-11.5 w-11.5 rotate-[-5deg] place-items-center rounded-2xl border border-violet-200 bg-white text-blue-600"
        aria-hidden="true"
      >
        <img className="h-6.75 w-6.75 rotate-[5deg] object-contain" src={logoSrc} alt="" />
      </span>
      <small className="mt-4.5 text-blue-600 tracking-widest uppercase [font:700_11px_ui-monospace,monospace]">
        {agentName
          ? t("chat.components.chatEmpty.readyWithAgent", { agentName })
          : t("chat.components.chatEmpty.eyebrow")}
      </small>
      <h2
        id="chat-empty-title"
        className="chat-empty-heading my-1.75 text-3xl font-medium tracking-tight text-slate-800 max-sm:text-2xl"
      >
        {title}
      </h2>
      <p className="m-0 max-w-115 text-sm leading-relaxed text-slate-500">{description}</p>
      <div className="chat-empty-prompt-list mt-6 grid gap-2" data-slot="chat-empty-suggestions">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            className="chat-empty-prompt-button flex min-w-0 cursor-pointer items-center justify-between gap-4 rounded-lg border border-zinc-200 bg-white px-3.5 py-2.75 text-left text-xs text-gray-600 [transition:border-color_150ms_ease,box-shadow_150ms_ease,transform_150ms_ease] hover:-translate-y-px hover:border-indigo-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
            onClick={() => onApplySuggestedPrompt?.(suggestion)}
          >
            <span>{suggestion}</span>
            <ArrowUpRight className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  );
}

// =============================================================================
// 间距逻辑 — 用户消息前后间距大，工具调用紧贴
// =============================================================================

/**
 * 消息条目的外层容器类名（源 `chat-design-messages.css` 的 `.chat-entry*` 间距 + 提示词导航高亮）。
 *
 * `.chat-active-prompt-entry` 承接源 `.chat-entry--active-prompt`：该状态由 `PromptJumpRail` 在运行时
 * 用 `setAttribute("data-active-prompt", "")` 打在本节点上（跨组件契约，用 data 属性替代类名），
 * 对应的闪动关键帧与「减弱动效」覆盖都在同目录 `./ChatView.css`（未分层，压过工具类）。
 * 留在 className 的只有标准变体：选中态的圆角、减弱动效下的静态底色。
 */
const ENTRY_ACTIVE_PROMPT_CLASS =
  "chat-active-prompt-entry data-[active-prompt]:rounded-xl motion-reduce:data-[active-prompt]:bg-slate-500/10";

/** 按渲染项密度与条目类型给出外层容器类名（源实现的间距规则逐字保留）。 */
function entryClassName(item: Extract<ChatRenderItem, { type: "entry" }>): string {
  const base = ENTRY_ACTIVE_PROMPT_CLASS;
  if (item.density === "activity") return `py-0.5 ${base}`;
  const { entry } = item;
  // 用户消息前后大留白 — Claude.ai 式宽松间距
  if (entry?.type === "user_message") {
    return `py-3 ${base}`;
  }
  // 助手消息 — 工具调用紧贴，否则多留白
  if (entry?.type === "assistant_message") {
    return `py-3 ${base}`;
  }
  return `py-2 ${base}`;
}

/** 生成渲染项 key：优先使用协议 id，缺失时回落到下标。 */
function renderItemKey(item: ChatRenderItem | undefined, fallbackIndex: number): string {
  if (!item) return `item-${fallbackIndex}`;
  if (item.type === "tool_group") return item.entries[0]?.toolCall.id ?? `tool-group-${fallbackIndex}`;
  return item.entry.type === "tool_call" ? item.entry.toolCall.id : item.entry.id;
}

interface ChatRenderItemViewProps {
  item: ChatRenderItem;
  /** 是否位于活动链内：透传给本项渲染出的工具组（工具行据此做对齐补偿）。 */
  inActivityChain?: boolean;
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
 * 复制自 `packages/agent-runtime/web/components/chat/ChatView.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
 * 纯化改动点：新增向下透传 `cardEmitter` / `onQuote` / `onOpenWorkspaceFile`（宿主注入点）；
 * 消息节点 id `chat-entry-${entryId}` 为跨组件契约（PromptJumpRail 依赖），保持不变。
 */
function ChatRenderItemView({
  item,
  inActivityChain,
  isLoading,
  sessionId,
  envId,
  cardEmitter,
  onQuote,
  onOpenWorkspaceFile,
}: ChatRenderItemViewProps) {
  if (item.type === "tool_group") {
    return (
      <div>
        <ToolCallGroup
          entries={item.entries}
          onPreviewFile={bindPreviewFile(envId, onOpenWorkspaceFile)}
          inActivityChain={inActivityChain}
        />
      </div>
    );
  }

  const entryId = item.entry.type === "tool_call" ? item.entry.toolCall.id : item.entry.id;
  const entryIsStreaming = isLoading && item.entry.type === "assistant_message";
  return (
    <div id={`chat-entry-${entryId}`} className={entryClassName(item)}>
      <EntryRenderer
        entry={item.entry}
        density={item.density}
        inActivityChain={inActivityChain}
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
    density,
    inActivityChain,
    isLoading,
    sessionId,
    envId,
    cardEmitter,
    onQuote,
    onOpenWorkspaceFile,
  }: {
    entry: ThreadEntry;
    /** 渲染密度（来自 `ChatRenderItem`）：`activity` 表示条目并入活动链，助手消息正文块间距收紧 */
    density: "normal" | "activity";
    /** 是否位于活动链内（透传给工具组，见 `ToolCallGroup` 的 `inActivityChain`）。 */
    inActivityChain?: boolean;
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
            compact={density === "activity"}
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
            inActivityChain={inActivityChain}
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
    prev.density === next.density &&
    prev.inActivityChain === next.inActivityChain &&
    prev.isLoading === next.isLoading &&
    prev.sessionId === next.sessionId &&
    prev.envId === next.envId &&
    prev.cardEmitter === next.cardEmitter &&
    prev.onQuote === next.onQuote &&
    prev.onOpenWorkspaceFile === next.onOpenWorkspaceFile,
);

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
function deriveLoadingStage(entries: ThreadEntry[]): LoadingStage {
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
