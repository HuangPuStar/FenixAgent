import { type RefObject, useEffect, useState } from "react";

export interface PromptJumpItem {
  id: string;
  label: string;
  meta: string;
  summary: string;
}

/** Floating prompt index that follows the active user turn inside a long chat timeline. */
export function PromptJumpRail({
  items,
  timelineRef,
}: {
  items: readonly PromptJumpItem[];
  timelineRef: RefObject<HTMLDivElement | null>;
}) {
  const [activeId, setActiveId] = useState(items[0]?.id ?? "");

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline || items.length === 0) return;

    const updateActivePrompt = () => {
      const timelineTop = timeline.getBoundingClientRect().top;
      let nextId = items[0].id;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const item of items) {
        const anchor = timeline.querySelector<HTMLElement>(`[data-prompt-anchor="${item.id}"]`);
        if (!anchor) continue;
        const distance = Math.abs(anchor.getBoundingClientRect().top - timelineTop - 100);
        if (distance < closestDistance) {
          closestDistance = distance;
          nextId = item.id;
        }
      }
      setActiveId(nextId);
    };

    updateActivePrompt();
    timeline.addEventListener("scroll", updateActivePrompt, { passive: true });
    return () => timeline.removeEventListener("scroll", updateActivePrompt);
  }, [items, timelineRef]);

  if (items.length < 2) return null;

  const jumpToPrompt = (id: string) => {
    const timeline = timelineRef.current;
    const anchor = timeline?.querySelector<HTMLElement>(`[data-prompt-anchor="${id}"]`);
    if (!timeline || !anchor) return;
    const nextTop = timeline.scrollTop + anchor.getBoundingClientRect().top - timeline.getBoundingClientRect().top - 18;
    timeline.scrollTo({ top: nextTop, behavior: "smooth" });
    setActiveId(id);
  };

  return (
    <nav className="chat-demo__prompt-jumps" aria-label="用户输入快捷跳转">
      {items.map((item) => {
        const isActive = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            className={isActive ? "is-active" : undefined}
            aria-current={isActive ? "location" : undefined}
            aria-label={`跳转到：${item.label}`}
            onClick={() => jumpToPrompt(item.id)}
          >
            <span className="chat-demo__prompt-jump-tick" aria-hidden="true" />
            <span className="chat-demo__prompt-jump-preview">
              <strong>{item.label}</strong>
              <small>{item.meta}</small>
              <span>{item.summary}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
