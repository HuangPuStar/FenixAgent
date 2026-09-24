import "./chat-navigation-aids.css";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PreviewRail, type PreviewRailItem } from "../../components/preview-rail";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import type { UserMessageEntry } from "../types";

// 过多刻度会把导航误读成贯穿整屏的时间轴；保留首尾的均匀采样即可支持长会话定位。
const MAX_VISIBLE_PROMPT_JUMPS = 14;
const SYSTEM_REMINDER_PREFIX = "<system-reminder>";
/**
 * 预览卡正文的截断上限。
 *
 * beui 的 `DefaultPreview` 对 `description` 不做 `line-clamp`，几千字的提示词会撑出一张巨卡；
 * 截断是「造 items 数据」的责任，不往组件本体（`components/preview-rail.tsx`）加 `line-clamp`。
 */
const PREVIEW_DESCRIPTION_MAX_LENGTH = 160;

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

/** 把提示词正文压成单行摘要，并按预览卡上限截断（超长时补省略号）。 */
function summarizePrompt(content: string, untitled: string): string {
  const summary = content.replace(/\s+/g, " ").trim() || untitled;
  // 按码位而非 UTF-16 下标截断：中文与 emoji 混排时不会切出半个代理对。
  const characters = [...summary];
  return characters.length > PREVIEW_DESCRIPTION_MAX_LENGTH
    ? `${characters.slice(0, PREVIEW_DESCRIPTION_MAX_LENGTH).join("")}…`
    : summary;
}

interface PromptJumpRailProps {
  entries: UserMessageEntry[];
}

/**
 * 会话提示词导航轨，不参与消息数据写入。
 *
 * 刻度轨本体是 beui 的 `PreviewRail`（`components/preview-rail.tsx`，改了「静止态统一为短横线」与「每格 20px」两处）：
 * `w-12` 轨道、`h-0.5 w-12` 刻度、指向刻度时展开的金字塔缩放与浮出的预览卡都由它提供；
 * 本处传 `highlightActive`，静止时只有当前阅读位置那根刻度颜色更深（长度与其余刻度一致）。
 * 本组件只做「造 items + 接回会话」：过滤 system-reminder、等距采样上限、滚动跟随（scroll-spy）、
 * 点击定位、`data-active-prompt` 跨组件契约，以及用自己的外层元素承载浮层定位
 * （beui 的根是「轨道 + 内容」并排的容器，这里是浮在会话之上的轨道，故不把 ConversationContent 塞成它的 children）。
 */
export function PromptJumpRail({ entries }: PromptJumpRailProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const anchorRef = useRef<HTMLDivElement>(null);
  const promptEntries = useMemo(() => entries.filter((entry) => !isSystemReminderPrompt(entry)), [entries]);
  const visiblePrompts = useMemo(() => samplePromptJumps(promptEntries), [promptEntries]);
  const [activeId, setActiveId] = useState(promptEntries[0]?.id ?? "");
  const railLabel = t("chat.components.promptJump.title");
  const untitledPrompt = t("chat.components.promptJump.untitled");
  const items = useMemo<PreviewRailItem[]>(
    () =>
      visiblePrompts.map(({ entry, sourceIndex }) => {
        // 正文摘要不做 line-clamp 兜底，超长时在数据侧截断；无障碍名沿用替换前的完整摘要。
        const summary = entry.content.replace(/\s+/g, " ").trim();
        const displaySummary = summary || untitledPrompt;
        return {
          id: entry.id,
          label: `#${sourceIndex + 1}`,
          description: summarizePrompt(entry.content, untitledPrompt),
          ariaLabel: `${railLabel} ${sourceIndex + 1}/${promptEntries.length}: ${displaySummary}`,
        };
      }),
    [promptEntries.length, railLabel, untitledPrompt, visiblePrompts],
  );

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
    const anchor = anchorRef.current;
    const conversation = anchor?.parentElement;
    if (!anchor || !conversation || visiblePrompts.length === 0) return;

    const scrollRoot = [...conversation.children].find((element): element is HTMLElement => {
      if (!(element instanceof HTMLElement) || element === anchor) return false;
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
    // 浮层锚点：轨道贴会话列左缘的留白（`left` 见 `./chat-navigation-aids.css`）。
    // beui 的根是「轨道 + 内容」并排的容器，这里只需要轨道浮在会话之上，故由本元素承载定位；
    // `right-4` 给根一个确定宽度 —— 预览卡容器是根的 `absolute right-4 left-16`，
    // 宽度塌成轨道宽（48px）会让左 64px 的预览卡变成零宽。
    //
    // `pointer-events-none` 是**必要**的（2026-09-23 修）：本元素同时设了 CSS `left` 与 `right-4`，
    // 绝对定位下宽度被拉满成一条横向宽带（1440×900 实测 1064×260px、垂直居中、`z-[8]`），而它是消息
    // 滚动层的**兄弟**而非后代（`Conversation` 的两个子元素依次是它和滚动层）——落在这条带里的滚轮
    // 命中它之后，浏览器沿其祖先上溯找不到任何可滚动容器（`overflow-y-hidden` / `overflow: hidden`），
    // 于是整条带变成滚轮死区：实测消息区 scrollTop 420，带内 5 个落点 × 上下两向全部零位移，而带外
    // 左侧 40px 处（命中消息正文）立刻 ±400；把本元素临时设为 `pointer-events: none` 后同一批落点
    // 全部恢复 ±400。真正可交互的只有刻度轨（39px 宽），故由 `railClassName` 把它单独放行；
    // beui 的预览卡容器自带 `pointer-events-none` + `aria-hidden`，本就不可交互，无需处理。
    <div
      ref={anchorRef}
      className="chat-prompt-rail-anchor pointer-events-none absolute top-1/2 right-4 z-[8] -translate-y-1/2"
    >
      <PreviewRail
        items={items}
        label={railLabel}
        activeId={activeId}
        onActiveChange={setActiveId}
        // 点击刻度沿用浏览器平滑定位，不修改会话消息或 Conversation 的滚动实现。
        onItemSelect={(item) => {
          document.getElementById(`chat-entry-${item.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        }}
        highlightActive
        // `pointer-events-auto` 只放行刻度轨本体；`self-center` 让它按刻度栈自身高度收口
        // （否则它会沿根节点的 `min-h-80` 被纵向拉满，多出约 200px 高的空白命中区）。
        railClassName="pointer-events-auto self-center"
      />
    </div>
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
 * 复制自 `packages/agent-runtime/web/components/chat/chat-navigation-aids.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
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
      className="chat-selection-quote-popover fixed z-[100] overflow-hidden rounded-md border border-slate-200 bg-white"
      style={{ left: selectionAction.left, top: selectionAction.top }}
    >
      <button
        type="button"
        className="px-3 py-2 text-xs font-semibold text-sky-700"
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
