import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UserMessageEntry } from "../../src/lib/types";

interface PromptJumpRailProps {
  entries: UserMessageEntry[];
}

/** 宽屏会话提示词导航，不参与消息数据写入。 */
export function PromptJumpRail({ entries }: PromptJumpRailProps) {
  const { t } = useTranslation("components");
  if (entries.length < 2) return null;
  return (
    <nav className="chat-prompt-jump-rail" aria-label={t("promptJump.title")}>
      {entries.map((entry, index) => {
        const summary = entry.content.replace(/\s+/g, " ").trim();
        return (
          <button
            key={entry.id}
            type="button"
            style={{ top: `${entries.length === 1 ? 0 : (index / (entries.length - 1)) * 100}%` }}
            onClick={() =>
              document.getElementById(`chat-entry-${entry.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })
            }
          >
            <span aria-hidden="true" />
            <small>{summary || t("promptJump.untitled")}</small>
          </button>
        );
      })}
    </nav>
  );
}

interface SelectionAction {
  text: string;
  left: number;
  top: number;
}

/** 只对聊天正文内的用户选区显示“添加到对话”，popover 使用 fixed 避免被滚动层裁剪。 */
export function ChatSelectionAction({ contextScope }: { contextScope?: string }) {
  const { t } = useTranslation("components");
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
