/**
 * 单个渲染项视图（普通消息条目 / 工具组）。
 *
 * 从 `ChatView.tsx` 拆出：活动链折叠组件需要在同一模块内复用逐项渲染，而 `ChatView` 也要保留
 * 非活动项的渲染路径。拆分只移动代码，DOM 层级、类名、`chat-entry-${id}` 契约与 memo 比较器不变。
 */

import React from "react";
import type { ChatRenderItem } from "../lib/chat-render-layout";
import { ToolCallGroup } from "../timeline/ToolCallGroup";
import type { ThreadEntry, ToolCallEntry } from "../types";
import type { CardEmitter } from "./internal/card-emitter";
import { AssistantBubble, UserBubble } from "./MessageBubble";

/**
 * 把宿主的 `onOpenWorkspaceFile(envId, path)` 绑定为工具卡片所需的 `onPreviewFile(path)`。
 *
 * 来源差异说明：源实现给 `ToolCallGroup` 透传的是 `envId`，本包 timeline 组已把该契约纯化为
 * `onPreviewFile(path)` 回调；View 层是唯一知道当前会话 envId 的地方，因此在此完成绑定。
 */
export function bindPreviewFile(
  envId: string | undefined,
  onOpenWorkspaceFile?: (envId: string, path: string) => void,
): ((path: string) => void) | undefined {
  if (!envId || !onOpenWorkspaceFile) return;
  return (path) => onOpenWorkspaceFile(envId, path);
}

/** 生成渲染项 key：优先使用协议 id，缺失时回落到下标。 */
export function renderItemKey(item: ChatRenderItem | undefined, fallbackIndex: number): string {
  if (!item) return `item-${fallbackIndex}`;
  if (item.type === "tool_group") return item.entries[0]?.toolCall.id ?? `tool-group-${fallbackIndex}`;
  return item.entry.type === "tool_call" ? item.entry.toolCall.id : item.entry.id;
}

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
export function entryClassName(item: Extract<ChatRenderItem, { type: "entry" }>): string {
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

export interface ChatRenderItemViewProps {
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
export function ChatRenderItemView({
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
