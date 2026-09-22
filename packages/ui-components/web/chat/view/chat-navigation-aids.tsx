import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { cn } from "../../lib/cn";
import type { UserMessageEntry } from "../types";

// 过多刻度会把导航误读成贯穿整屏的时间轴；保留首尾的均匀采样即可支持长会话定位。
const MAX_VISIBLE_PROMPT_JUMPS = 14;
const SYSTEM_REMINDER_PREFIX = "<system-reminder>";

/** 判断用户条目是否为注入的 system-reminder 提示（不作为导航锚点）。 */
function isSystemReminderPrompt(entry: UserMessageEntry): boolean {
  return entry.content.trimStart().startsWith(SYSTEM_REMINDER_PREFIX);
}

interface VisiblePromptJump {
  entry: UserMessageEntry;
  sourceIndex: number;
}

/** 从全部提示词中等距采样出可见刻度，保留首尾与原始下标。 */
function samplePromptJumps(entries: readonly UserMessageEntry[]): VisiblePromptJump[] {
  if (entries.length <= MAX_VISIBLE_PROMPT_JUMPS) {
    return entries.map((entry, sourceIndex) => ({ entry, sourceIndex }));
  }

  const lastIndex = entries.length - 1;
  return Array.from({ length: MAX_VISIBLE_PROMPT_JUMPS }, (_, index) => {
    const sourceIndex = Math.round((index * lastIndex) / (MAX_VISIBLE_PROMPT_JUMPS - 1));
    return { entry: entries[sourceIndex], sourceIndex };
  });
}

interface PromptJumpRailProps {
  entries: UserMessageEntry[];
}

interface PromptPreview {
  entry: UserMessageEntry;
  sourceIndex: number;
  left: number;
  top: number;
}

/**
 * 宽屏会话提示词导航，不参与消息数据写入。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/chat-navigation-aids.tsx`。
 * 纯化改动点：`@/src/lib/types` → 包内 `../types`；命名空间常量与样式表路径收敛到包内
 * （`../../i18n/namespace`、`../css/chat-navigation-aids.css`）；键加 `chat.components.` 前缀。
 */
export function PromptJumpRail({ entries }: PromptJumpRailProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const railRef = useRef<HTMLElement>(null);
  const promptEntries = useMemo(() => entries.filter((entry) => !isSystemReminderPrompt(entry)), [entries]);
  const visiblePrompts = useMemo(() => samplePromptJumps(promptEntries), [promptEntries]);
  const [activeId, setActiveId] = useState(promptEntries[0]?.id ?? "");
  const [preview, setPreview] = useState<PromptPreview | null>(null);

  useEffect(() => {
    if (!visiblePrompts.some(({ entry }) => entry.id === activeId)) {
      setActiveId(visiblePrompts[0]?.entry.id ?? "");
    }
  }, [activeId, visiblePrompts]);

  useEffect(() => {
    // 跨组件契约：`chat-entry-<entryId>` 由 ChatView 的消息节点提供（见 view/ChatView.tsx），
    // 本组件只负责按 activeId 给该节点打上 `data-active-prompt`（样式由 ChatView 的
    // `data-[active-prompt]:` 工具类承担，原 `chat-entry--active-prompt` 类名已随样式迁移删除）。
    // 迁移到本包时保持该约定不变，宿主必须沿用 `chat-entry-${entryId}` 作为消息节点 id。
    const activePrompt = activeId ? document.getElementById(`chat-entry-${activeId}`) : null;
    activePrompt?.setAttribute("data-active-prompt", "");
    return () => activePrompt?.removeAttribute("data-active-prompt");
  }, [activeId]);

  useEffect(() => {
    const rail = railRef.current;
    const conversation = rail?.parentElement;
    if (!rail || !conversation || visiblePrompts.length === 0) return;

    const scrollRoot = [...conversation.children].find((element): element is HTMLElement => {
      if (!(element instanceof HTMLElement) || element === rail) return false;
      const style = window.getComputedStyle(element);
      return /(auto|scroll)/.test(`${style.overflow} ${style.overflowY}`);
    });
    if (!scrollRoot) return;

    const anchors = visiblePrompts.map(({ entry }) => ({
      id: entry.id,
      element: document.getElementById(`chat-entry-${entry.id}`),
    }));
    let animationFrameId: number | null = null;

    const updateActivePrompt = () => {
      const readingLine = scrollRoot.getBoundingClientRect().top + Math.min(120, scrollRoot.clientHeight * 0.2);
      let nextId = visiblePrompts[0].entry.id;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const anchor of anchors) {
        if (!anchor.element) continue;
        const distance = Math.abs(anchor.element.getBoundingClientRect().top - readingLine);
        if (distance < closestDistance) {
          closestDistance = distance;
          nextId = anchor.id;
        }
      }
      setActiveId(nextId);
    };

    const scheduleActivePromptUpdate = () => {
      if (animationFrameId !== null) return;
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        updateActivePrompt();
      });
    };

    scheduleActivePromptUpdate();
    scrollRoot.addEventListener("scroll", scheduleActivePromptUpdate, { passive: true });
    window.addEventListener("resize", scheduleActivePromptUpdate);
    return () => {
      if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
      scrollRoot.removeEventListener("scroll", scheduleActivePromptUpdate);
      window.removeEventListener("resize", scheduleActivePromptUpdate);
    };
  }, [visiblePrompts]);

  if (promptEntries.length <= 1) return null;
  return (
    <>
      <nav
        ref={railRef}
        // 源 `chat-navigation-aids.css` 的 `.chat-prompt-jump-index`：贴会话左缘的刻度轨（宽屏才显示）。
        className="absolute left-[max(8px,calc(50%-446px))] top-1/2 z-[8] hidden h-max max-h-[min(232px,44vh)] w-7 -translate-y-1/2 [@media(min-width:1180px)_and_(min-height:620px)]:block"
        data-slot="chat-prompt-jump-rail"
        aria-label={t("chat.components.promptJump.title")}
      >
        <ol
          className="m-0 grid list-none grid-flow-row auto-rows-[10px] content-start gap-y-1.5 py-[3px]"
          data-slot="chat-prompt-jump-list"
        >
          {visiblePrompts.map(({ entry, sourceIndex }) => {
            const summary = entry.content.replace(/\s+/g, " ").trim();
            const displaySummary = summary || t("chat.components.promptJump.untitled");
            const isActive = entry.id === activeId;
            return (
              <li key={entry.id} className="h-2.5 w-[26px]">
                <button
                  type="button"
                  // 源 `__item`：整条刻度是按钮，父选子（hover / focus-visible）由 `group` 承担。
                  className="group relative inline-flex h-2.5 w-[26px] min-w-0 min-h-0 cursor-pointer items-center self-start border-0 bg-transparent p-0 focus-visible:outline-none"
                  data-slot="chat-prompt-jump-item"
                  aria-controls={`chat-entry-${entry.id}`}
                  aria-current={isActive ? "location" : undefined}
                  aria-label={`${t("chat.components.promptJump.title")} ${sourceIndex + 1}/${promptEntries.length}: ${displaySummary}`}
                  onClick={() => {
                    document
                      .getElementById(`chat-entry-${entry.id}`)
                      ?.scrollIntoView({ behavior: "smooth", block: "center" });
                    setActiveId(entry.id);
                  }}
                  onFocus={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setPreview({ entry, sourceIndex, left: bounds.right + 1, top: bounds.top + bounds.height / 2 });
                  }}
                  onBlur={() => setPreview(null)}
                  onMouseEnter={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setPreview({ entry, sourceIndex, left: bounds.right + 1, top: bounds.top + bounds.height / 2 });
                  }}
                  onMouseLeave={() => setPreview(null)}
                >
                  {/* 源 `__tick` 与 `:hover/:focus-visible`、`.is-active` 三态：选中态与其余态**互斥**列出，
                      不依赖两条工具类的生成顺序（选中项悬停时仍是选中态的宽度/颜色，与源一致）。 */}
                  <span
                    className={cn(
                      "h-0.5 shrink-0 rounded-full [transition:width_150ms_ease,background-color_150ms_ease] [@media(prefers-reduced-motion:reduce)]:[transition:none]",
                      isActive
                        ? "w-[19px] bg-[#202936]"
                        : "w-2 max-w-[19px] bg-[#cbd1d9] group-hover:w-[13px] group-hover:bg-[#6f7886] group-focus-visible:w-[13px] group-focus-visible:bg-[#6f7886]",
                    )}
                    data-slot="chat-prompt-jump-tick"
                    aria-hidden="true"
                  />
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      {preview &&
        createPortal(
          <span
            // 源 `__preview`（含 `> small` 与 `> span` 的三行截断）。
            className="pointer-events-none fixed z-30 grid w-[226px] -translate-y-1/2 gap-1 rounded-[10px] border border-[#e0e5ec] bg-[rgb(255_255_255_/_97%)] px-[11px] py-[9px] text-left text-[#536178] shadow-[0_10px_28px_rgb(30_50_80_/_12%)] backdrop-blur-[10px] [@media(prefers-reduced-motion:reduce)]:[transition:none]"
            style={{ left: preview.left, top: preview.top }}
            data-slot="chat-prompt-jump-preview"
            aria-hidden="true"
          >
            <small className="text-[9px] leading-[1.3] text-[#9aa5b5]">
              {preview.sourceIndex + 1}/{promptEntries.length}
            </small>
            <span className="line-clamp-3 overflow-hidden text-[11px] leading-[1.5] text-[#59677c]">
              {preview.entry.content.replace(/\s+/g, " ").trim() || t("chat.components.promptJump.untitled")}
            </span>
          </span>,
          document.body,
        )}
    </>
  );
}

interface SelectionAction {
  text: string;
  left: number;
  top: number;
}

/** `ChatSelectionAction` 的 props：选区文本通过 `onQuote` 交回宿主，`contextScope` 原样透传。 */
export interface ChatSelectionActionProps {
  /** 会话上下文标识（源实现作为 CustomEvent detail.contextScope 透传）。 */
  contextScope?: string;
  /** 用户点击「添加到对话」时回调，替代源实现的 `chat:quote` window 事件。 */
  onQuote?: (text: string, contextScope?: string) => void;
}

/**
 * 只对聊天正文内的用户选区显示“添加到对话”，popover 使用 fixed 避免被滚动层裁剪。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/chat-navigation-aids.tsx`。
 * 纯化改动点：`chat:quote` window 自定义事件改为 `onQuote` 回调 prop（不再 `window.dispatchEvent`）；
 * 命名空间与键前缀收敛到包内；选区判定改为依赖消息容器的稳定锚点
 * `data-slot="chat-conversation-content"`（由 `view/ChatView.tsx` 的 `ConversationContent` 提供，
 * 原实现锚定的是 `.chat-conversation-content` 语义类名，样式迁移后类名已删除）。
 */
export function ChatSelectionAction({ contextScope, onQuote }: ChatSelectionActionProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const [selectionAction, setSelectionAction] = useState<SelectionAction | null>(null);

  useEffect(() => {
    const update = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setSelectionAction(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const ancestor =
        range.commonAncestorContainer.nodeType === Node.TEXT_NODE
          ? range.commonAncestorContainer.parentElement
          : range.commonAncestorContainer;
      if (!(ancestor instanceof Element) || !ancestor.closest('[data-slot="chat-conversation-content"]')) {
        setSelectionAction(null);
        return;
      }
      const text = selection.toString().trim();
      if (!text) return setSelectionAction(null);
      const bounds = range.getBoundingClientRect();
      setSelectionAction({
        text,
        left: Math.max(12, Math.min(window.innerWidth - 140, bounds.left + bounds.width / 2 - 60)),
        top: Math.max(12, bounds.top - 42),
      });
    };
    document.addEventListener("mouseup", update);
    document.addEventListener("keyup", update);
    return () => {
      document.removeEventListener("mouseup", update);
      document.removeEventListener("keyup", update);
    };
  }, []);

  if (!selectionAction) return null;
  return (
    <div
      className="fixed z-[100] overflow-hidden rounded-[9px] border border-[#dfe5ed] bg-white shadow-[0_9px_26px_rgb(30_50_80_/_14%)]"
      style={{ left: selectionAction.left, top: selectionAction.top }}
    >
      <button
        type="button"
        className="px-3 py-2 text-[12px] font-semibold text-[#275ebd]"
        onClick={() => {
          onQuote?.(selectionAction.text, contextScope);
          window.getSelection()?.removeAllRanges();
          setSelectionAction(null);
        }}
      >
        {t("chat.components.messageBubble.addToConversation")}
      </button>
    </div>
  );
}
