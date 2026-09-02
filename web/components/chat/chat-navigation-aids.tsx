import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { NS } from "../../src/i18n";
import type { UserMessageEntry } from "../../src/lib/types";
import "./chat-navigation-aids.css";

const PROMPT_JUMP_CLASS = "chat-prompt-jump-index";
// 过多刻度会把导航误读成贯穿整屏的时间轴；保留首尾的均匀采样即可支持长会话定位。
const MAX_VISIBLE_PROMPT_JUMPS = 14;
const SYSTEM_REMINDER_PREFIX = "<system-reminder>";

function isSystemReminderPrompt(entry: UserMessageEntry): boolean {
  return entry.content.trimStart().startsWith(SYSTEM_REMINDER_PREFIX);
}

interface VisiblePromptJump {
  entry: UserMessageEntry;
  sourceIndex: number;
}

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

/** 宽屏会话提示词导航，不参与消息数据写入。 */
export function PromptJumpRail({ entries }: PromptJumpRailProps) {
  const { t } = useTranslation(NS.COMPONENTS);
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

  if (promptEntries.length === 0) return null;
  return (
    <>
      <nav ref={railRef} className={PROMPT_JUMP_CLASS} aria-label={t("promptJump.title")}>
        <ol className={`${PROMPT_JUMP_CLASS}__list`}>
          {visiblePrompts.map(({ entry, sourceIndex }) => {
            const summary = entry.content.replace(/\s+/g, " ").trim();
            const displaySummary = summary || t("promptJump.untitled");
            const isActive = entry.id === activeId;
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  className={`${PROMPT_JUMP_CLASS}__item${isActive ? " is-active" : ""}`}
                  aria-controls={`chat-entry-${entry.id}`}
                  aria-current={isActive ? "location" : undefined}
                  aria-label={`${t("promptJump.title")} ${sourceIndex + 1}/${promptEntries.length}: ${displaySummary}`}
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
                  <span className={`${PROMPT_JUMP_CLASS}__tick`} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      {preview &&
        createPortal(
          <span
            className={`${PROMPT_JUMP_CLASS}__preview`}
            style={{ left: preview.left, top: preview.top }}
            aria-hidden="true"
          >
            <small>
              {preview.sourceIndex + 1}/{promptEntries.length}
            </small>
            <span>{preview.entry.content.replace(/\s+/g, " ").trim() || t("promptJump.untitled")}</span>
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

/** 只对聊天正文内的用户选区显示“添加到对话”，popover 使用 fixed 避免被滚动层裁剪。 */
export function ChatSelectionAction({ contextScope }: { contextScope?: string }) {
  const { t } = useTranslation(NS.COMPONENTS);
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
      if (!(ancestor instanceof Element) || !ancestor.closest(".chat-conversation-content")) {
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
    <div className="chat-selection-action" style={{ left: selectionAction.left, top: selectionAction.top }}>
      <button
        type="button"
        onClick={() => {
          window.dispatchEvent(new CustomEvent("chat:quote", { detail: { text: selectionAction.text, contextScope } }));
          window.getSelection()?.removeAllRanges();
          setSelectionAction(null);
        }}
      >
        {t("messageBubble.addToConversation")}
      </button>
    </div>
  );
}
