/**
 * 对话列表渲染。
 *
 * 移植来源：langfuse-lite `components/chat-viewer.tsx`。
 *
 * 三个设计点原样保留：
 * - 角色分化的气泡（system / user / assistant / tool …），配色语义与类型角标一致；
 * - 连续同角色消息合并成一组：一排工具结果各占一个气泡会把真正的对话淹掉；
 * - 长对话渐进披露：先渲染最近 N 条，「加载更早」按批前置插入。
 *
 * 本次适配：删掉每条消息的「原始 JSON 弹窗 + 复制到剪贴板」（参考产品特性；详情面板已用 IO 的 JSON 视图
 * 覆盖回看原文的需求，再挂一份弹窗只是重复出口），随之去掉 Dialog / clipboard 依赖；文案走 `t()`。
 */
import { cn } from "@fenix/ui-components/lib/cn";
import type { TFunction } from "i18next";
import { Bot, ChevronDown, ChevronUp, History, type LucideIcon, Settings, SquareTerminal, User } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { TRACE_NS } from "../../i18n/namespace";
import {
  type ChatMessage,
  type ContentPart,
  contentToText,
  extractParts,
  groupConsecutive,
} from "../../lib/chat-utils";
import { PartView } from "./chat-parts";

/** 初始渲染的消息条数（从对话末端取，先看到最近的往来）。 */
const INITIAL_VISIBLE = 20;
/** 每次「加载更早」追加的条数。 */
const LOAD_STEP = 50;

type RoleConfig = {
  icon: LucideIcon;
  /** 气泡与头像配色。 */
  bubble: string;
  iconWrap: string;
  /** 用户消息靠右，与助手回答区分开。 */
  alignRight?: boolean;
  /** 系统提示默认折叠：长系统提示会占满整屏。 */
  defaultCollapsed?: boolean;
  /** 工具结果用等宽字体。 */
  mono?: boolean;
};

const ROLE_CONFIG: Record<string, RoleConfig> = {
  system: {
    icon: Settings,
    bubble: "border-amber-500/25 bg-amber-500/[0.06]",
    iconWrap: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    defaultCollapsed: true,
  },
  developer: {
    icon: Settings,
    bubble: "border-amber-500/25 bg-amber-500/[0.06]",
    iconWrap: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    defaultCollapsed: true,
  },
  user: {
    icon: User,
    bubble: "border-blue-500/25 bg-blue-500/[0.07]",
    iconWrap: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    alignRight: true,
  },
  assistant: {
    icon: Bot,
    bubble: "border-violet-500/25 bg-violet-500/[0.06]",
    iconWrap: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  },
  tool: {
    icon: SquareTerminal,
    bubble: "border-emerald-500/25 bg-emerald-500/[0.06]",
    iconWrap: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    mono: true,
  },
  function: {
    icon: SquareTerminal,
    bubble: "border-emerald-500/25 bg-emerald-500/[0.06]",
    iconWrap: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    mono: true,
  },
};

const FALLBACK_ROLE: RoleConfig = {
  icon: Bot,
  bubble: "border-border-subtle bg-surface-2/60",
  iconWrap: "bg-surface-2 text-text-muted",
};

function roleConfig(role: string): RoleConfig {
  return ROLE_CONFIG[role] ?? FALLBACK_ROLE;
}

/** 角色显示名：六个已知角色走字典，未知角色原样显示协议值（吞掉它反而让人看不懂这段对话）。 */
function roleLabel(role: string, t: TFunction): string {
  switch (role) {
    case "system":
      return t("detail.roleSystem");
    case "developer":
      return t("detail.roleDeveloper");
    case "user":
      return t("detail.roleUser");
    case "assistant":
      return t("detail.roleAssistant");
    case "tool":
      return t("detail.roleTool");
    case "function":
      return t("detail.roleFunction");
    default:
      return role;
  }
}

/**
 * 消息键：协议没有消息 id（只有工具消息带 `toolCallId`）。有 id 用 id，否则回退「角色 + 全量下标」；
 * 直接写 `key={index}` 会被 lint/suspicious/noArrayIndexKey 拦下，故由本函数显式派生。
 */
function messageKey(message: ChatMessage, absoluteIndex: number): string {
  return message.toolCallId ? `tool-${message.toolCallId}` : `msg-${absoluteIndex}-${message.role}`;
}

/** 分片同样没有协议 id：类型 + 位置足以区分同一条消息内的分片。 */
function partKey(part: ContentPart, index: number): string {
  return `${part.type}-${index}`;
}

/** 单条消息气泡：头像 + 角色行 + 分片列表；折叠态只留一行摘要。 */
function MessageBubble({ message, index }: { message: ChatMessage; index: number }) {
  const { t } = useTranslation(TRACE_NS);
  const config = roleConfig(message.role);
  const Icon = config.icon;
  const parts = useMemo(() => extractParts(message.content, message.toolCalls), [message]);
  const summary = contentToText(message.content);
  const toolCount = parts.filter((part) => part.type === "tool_use").length;
  const [collapsed, setCollapsed] = useState(config.defaultCollapsed ?? false);

  const label = roleLabel(message.role, t);
  const nameSuffix = message.name ? ` · ${message.name}` : "";
  const toolSuffix = message.toolCallId ? ` · ${message.toolCallId.slice(0, 12)}…` : "";

  return (
    <div className={cn("group flex gap-2.5", config.alignRight && "flex-row-reverse")}>
      <div className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md", config.iconWrap)}>
        <Icon className="h-3.5 w-3.5" />
      </div>

      <div className={cn("min-w-0 max-w-[85%] flex-1", config.alignRight && "flex flex-col items-end")}>
        <div
          className={cn(
            "mb-0.5 flex items-center gap-1.5 text-11 text-text-muted",
            config.alignRight && "flex-row-reverse",
          )}
        >
          <span className="font-semibold uppercase tracking-wide">{label}</span>
          {(message.name || message.toolCallId) && (
            <span className="truncate font-mono text-3xs opacity-70">
              {nameSuffix}
              {toolSuffix}
            </span>
          )}
          <span className="font-mono text-3xs opacity-50">#{index}</span>
          {config.defaultCollapsed && (
            <button
              type="button"
              onClick={() => setCollapsed((value) => !value)}
              className="rounded px-1 opacity-0 transition-opacity hover:bg-surface-hover group-hover:opacity-100"
            >
              {collapsed ? t("detail.expand") : t("detail.collapse")}
            </button>
          )}
        </div>

        {!collapsed ? (
          <div className={cn("rounded-lg border px-3 py-2", config.bubble)}>
            {parts.length > 0 ? (
              <div className="space-y-1.5">
                {parts.map((part, partIndex) => (
                  <PartView key={partKey(part, partIndex)} part={part} mono={config.mono} />
                ))}
              </div>
            ) : (
              <span className="text-xs text-text-muted italic">{t("detail.empty")}</span>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className={cn(
              "w-full cursor-pointer rounded-lg border border-dashed px-3 py-1.5 text-left text-11 text-text-muted transition-colors hover:border-solid hover:text-text-primary",
              config.bubble,
            )}
          >
            {summary ? `${summary.slice(0, 80)}${summary.length > 80 ? "…" : ""}` : t("detail.empty")}
            {toolCount > 0 && (
              <span className="ms-2 font-medium">{t("detail.toolCallCount", { count: toolCount })}</span>
            )}
            <span className="ms-2 font-medium">{t("detail.clickToExpand")}</span>
          </button>
        )}
      </div>
    </div>
  );
}

/** 连续同角色消息组：默认折成一枚计数按钮，展开后逐条渲染。 */
function MessageGroup({ messages, startIndex }: { messages: ChatMessage[]; startIndex: number }) {
  const { t } = useTranslation(TRACE_NS);
  const config = roleConfig(messages[0].role);
  const [expanded, setExpanded] = useState(false);
  const label = roleLabel(messages[0].role, t);

  if (messages.length === 1) {
    return <MessageBubble message={messages[0]} index={startIndex + 1} />;
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="flex w-full items-center gap-2 rounded-md border border-dashed border-border-subtle px-3 py-1.5 text-11 text-text-muted transition-colors hover:border-solid hover:bg-surface-2/60 hover:text-text-primary"
      >
        <span className={cn("flex h-4 w-4 items-center justify-center rounded", config.iconWrap)}>
          <config.icon className="h-2.5 w-2.5" />
        </span>
        <span className="font-medium">{t("detail.consecutiveMessages", { count: messages.length, role: label })}</span>
        <ChevronDown className="h-3 w-3" />
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-dashed border-border-subtle/60 p-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-3xs font-semibold uppercase tracking-wide text-text-muted">
          {t("detail.groupCount", { count: messages.length, role: label })}
        </span>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="flex items-center gap-0.5 text-3xs text-text-muted hover:text-text-primary"
        >
          {t("detail.collapse")} <ChevronUp className="h-3 w-3" />
        </button>
      </div>
      {messages.map((message, messageIndex) => (
        <MessageBubble
          key={messageKey(message, startIndex + messageIndex)}
          message={message}
          index={startIndex + messageIndex + 1}
        />
      ))}
    </div>
  );
}

/** 对话列表：默认只渲染末尾若干条，其余按批加载。 */
export function ChatViewer({ messages }: { messages: ChatMessage[] }) {
  const { t } = useTranslation(TRACE_NS);
  const [visibleCount, setVisibleCount] = useState(() => Math.min(INITIAL_VISIBLE, messages.length));

  const visible = useMemo(() => messages.slice(messages.length - visibleCount), [messages, visibleCount]);
  const groups = useMemo(() => groupConsecutive(visible), [visible]);

  /** 每组的起始下标要按**全量**列表算，气泡上的序号才是稳定的绝对序号。 */
  const blocks = useMemo(() => {
    const startIndices: number[] = [];
    let cursor = messages.length - visibleCount;
    for (const group of groups) {
      startIndices.push(cursor);
      cursor += group.length;
    }
    return groups.map((group, groupIndex) => ({
      key: `block-${startIndices[groupIndex]}`,
      group,
      startIndex: startIndices[groupIndex],
    }));
  }, [groups, messages.length, visibleCount]);

  const hiddenCount = messages.length - visibleCount;

  const loadEarlier = useCallback(() => {
    setVisibleCount((current) => Math.min(current + LOAD_STEP, messages.length));
  }, [messages.length]);

  return (
    <div className="rounded-md border border-border-subtle bg-surface-2/40">
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <span className="text-11 font-medium text-text-muted">
          {t("detail.messageCount", { count: messages.length })}
        </span>
        {hiddenCount > 0 && (
          <span className="text-3xs text-text-muted/70">{t("detail.showingLatest", { count: visibleCount })}</span>
        )}
      </div>

      <div className="space-y-3 p-3">
        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={loadEarlier}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border-subtle py-2 text-xs font-medium text-text-muted transition-colors hover:border-solid hover:bg-surface-2/70 hover:text-text-primary"
          >
            <History className="h-3.5 w-3.5" />
            {t("detail.loadEarlier", { count: Math.min(LOAD_STEP, hiddenCount) })}
            <span className="text-3xs opacity-60">{t("detail.hiddenCount", { count: hiddenCount })}</span>
          </button>
        )}

        {blocks.map((block) => (
          <MessageGroup key={block.key} messages={block.group} startIndex={block.startIndex} />
        ))}
      </div>
    </div>
  );
}
