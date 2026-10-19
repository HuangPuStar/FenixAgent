// packages/ui-components/web/chat/view/chat-render-window.tsx
// 大基线渲染窗口：数据层一次提交完整列表，DOM 层只挂载最近 N 条，用户可显式加载更早消息。
//
// 为什么需要：10k 条消息一次挂载在本项目 DOM 测试环境约 1.7s，单次提交不可交互。窗口化把
// 首次挂载限制在 1000 条（约 200ms），DOM 节点数有界；更早消息由用户点击加载，不自动滚动。
// 这与 hydrate 门控互补：门控保证完成前不渲染半成品，本窗口保证完成后单次提交不会卡死。

import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { Button } from "../../ui/button";

/** 首次挂载的最近消息数；与 1k 条目渲染约 200ms 的实测预算对应。 */
export const CHAT_RENDER_WINDOW_INITIAL = 1000;
/** 每次“加载更早”增加的条目数。 */
export const CHAT_RENDER_WINDOW_STEP = 1000;

export interface ChatRenderWindow<T> {
  readonly visible: readonly T[];
  readonly hiddenCount: number;
  readonly loadEarlier: () => void;
}

/**
 * 只返回最近 `limit` 条；`sessionKey` 变化时重置窗口。
 *
 * 不按“最新条数增长”自动扩大：实时消息只需保持窗口在最新端，DOM 数量恒定；
 * 用户显式加载更早消息才增加上限，避免 hydrate 后自动滚回顶部。
 */
export function useChatRenderWindow<T>(entries: readonly T[], sessionKey: string | undefined): ChatRenderWindow<T> {
  const [windowState, setWindowState] = useState({ sessionKey, limit: CHAT_RENDER_WINDOW_INITIAL });
  const previousLength = useRef(entries.length);
  // 会话切换时在渲染期同步回到初始窗口，避免先按上一个会话的放大上限渲染一帧。
  let limit = windowState.limit;
  const resetForSession = windowState.sessionKey !== sessionKey;
  // hydrate 门控在切换期间会先提交空列表；这也是 ACP session 切换的同步信号。
  const resetForTimeline = entries.length === 0 && previousLength.current > 0;
  previousLength.current = entries.length;
  if (resetForSession || resetForTimeline) {
    limit = CHAT_RENDER_WINDOW_INITIAL;
    setWindowState({ sessionKey, limit });
  }
  const visible = useMemo(() => {
    const hidden = Math.max(0, entries.length - limit);
    return hidden === 0 ? entries : entries.slice(hidden);
  }, [entries, limit]);
  const hiddenCount = Math.max(0, entries.length - visible.length);
  const loadEarlier = useCallback(() => {
    setWindowState((current) => ({ ...current, limit: current.limit + CHAT_RENDER_WINDOW_STEP }));
  }, []);
  return { visible, hiddenCount, loadEarlier };
}

export function ChatLoadEarlier({ hiddenCount, onLoadEarlier }: { hiddenCount: number; onLoadEarlier: () => void }) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const { contentRef, scrollRef, stopScroll } = useStickToBottomContext();
  const handleLoadEarlier = useCallback(() => {
    const content = contentRef.current;
    const scroll = scrollRef.current;
    // 先停止当前跟随动画；加载后把视口移到“第一条新增历史”，而不是继续钉在底部。
    stopScroll();
    onLoadEarlier();
    setTimeout(() => {
      if (!content || !scroll) return;
      const button = content.querySelector('[data-slot="chat-load-earlier"]');
      const firstNew = button ? button.nextElementSibling : content.firstElementChild;
      if (firstNew instanceof HTMLElement) scroll.scrollTop = firstNew.offsetTop;
    }, 0);
  }, [contentRef, onLoadEarlier, scrollRef, stopScroll]);
  return (
    <div className="flex justify-center py-1" data-slot="chat-load-earlier">
      <Button type="button" variant="ghost" size="sm" onClick={handleLoadEarlier}>
        {t("chat.components.chatView.loadEarlier", { count: hiddenCount })}
      </Button>
    </div>
  );
}
