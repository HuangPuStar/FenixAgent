// packages/ui-components/web/chat/view/chat-render-window.tsx
// 大基线渲染窗口：数据层只提交窗口内条目，DOM 层再有界挂载；用户可显式加载更早消息。
//
// 为什么首屏是 100 而不是 1000：1000 条 DOM 在真实浏览器实测首次挂载约 564ms（3000 条历史），
// 仍会造成可感知卡顿；100 条把首屏挂载压到约几十毫秒。更早消息只由用户点击加载，不自动扩大。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { Button } from "../../ui/button";

/** 首次挂载的最近消息数。 */
export const CHAT_RENDER_WINDOW_INITIAL = 100;
/** 每次“加载更早”增加的条目数。 */
export const CHAT_RENDER_WINDOW_STEP = 300;

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
export function useChatRenderWindow<T>(
  entries: readonly T[],
  sessionKey: string | undefined,
  enabled = true,
): ChatRenderWindow<T> {
  const [windowState, setWindowState] = useState({ sessionKey, limit: CHAT_RENDER_WINDOW_INITIAL });
  const previousLength = useRef(entries.length);
  // 会话切换时在渲染期同步回到初始窗口，避免先按上一个会话的放大上限渲染一帧。
  let limit = windowState.limit;
  const resetForSession = windowState.sessionKey !== sessionKey;
  // hydrate 门控在切换期间会先提交空列表；这也是 ACP session 切换的同步信号。
  const resetForTimeline = entries.length === 0 && previousLength.current > 0;
  previousLength.current = entries.length;
  if (enabled && (resetForSession || resetForTimeline)) {
    limit = CHAT_RENDER_WINDOW_INITIAL;
    setWindowState({ sessionKey, limit });
  }
  const visible = useMemo(() => {
    if (!enabled) return entries;
    const hidden = Math.max(0, entries.length - limit);
    return hidden === 0 ? entries : entries.slice(hidden);
  }, [entries, enabled, limit]);
  const hiddenCount = enabled ? Math.max(0, entries.length - visible.length) : 0;
  const loadEarlier = useCallback(() => {
    if (!enabled) return;
    setWindowState((current) => ({ ...current, limit: current.limit + CHAT_RENDER_WINDOW_STEP }));
  }, [enabled]);
  return { visible, hiddenCount, loadEarlier };
}

export interface ChatMessageWindowOptions {
  /** 协议层仍可加载更早历史（未订阅块或投影窗口外条目）。 */
  readonly hasEarlierHistory?: boolean;
  /** 协议层历史块基线在途。 */
  readonly historyLoading?: boolean;
  /** 显式加载协议层更早历史；返回 false 表示没有产生新工作。 */
  readonly onLoadEarlierHistory?: () => boolean | undefined | Promise<boolean | undefined>;
}

export interface ChatMessageWindow<T> {
  readonly visible: readonly T[];
  readonly hiddenCount: number;
  readonly hasEarlier: boolean;
  readonly loading: boolean;
  readonly loadEarlier: () => void;
}

/**
 * 数据层窗口：只把最近 N 条交给投影函数与 ChatView，避免 3000 条消息每次渲染都参与
 * `structuredToThreadEntries`；`hiddenCount` 是已加载但尚未展示的条目数。
 *
 * 外部历史加载完成后按新增条目数扩大窗口（最多一档 100 条），既揭示刚加载的批次，也不把
 * 一次块加载的全部条目一次性挂到 DOM。
 */
export function useChatMessageWindow<T>(
  messages: readonly T[],
  scopeKey: string | null | undefined,
  options: ChatMessageWindowOptions = {},
): ChatMessageWindow<T> {
  const normalizedScope = scopeKey ?? "";
  const [windowState, setWindowState] = useState({ scope: normalizedScope, limit: CHAT_RENDER_WINDOW_INITIAL });
  const [pendingExternal, setPendingExternal] = useState(false);
  const previousLength = useRef(messages.length);
  const { hasEarlierHistory = false, historyLoading = false, onLoadEarlierHistory } = options;
  const limit = windowState.scope === normalizedScope ? windowState.limit : CHAT_RENDER_WINDOW_INITIAL;

  // 会话/投影换代时同步回到首屏窗口；不依赖 entries 先变空，避免同实例切换会话沿用旧上限。
  useEffect(() => {
    if (windowState.scope === normalizedScope) return;
    setWindowState({ scope: normalizedScope, limit: CHAT_RENDER_WINDOW_INITIAL });
    setPendingExternal(false);
    previousLength.current = messages.length;
  }, [normalizedScope, windowState.scope, messages.length]);

  // 外部批次到达后只揭示一档；剩余条目继续由“显示更早”分批揭示。
  useEffect(() => {
    const delta = messages.length - previousLength.current;
    previousLength.current = messages.length;
    if (!pendingExternal) return;
    if (delta > 0) {
      setWindowState((current) => ({
        scope: normalizedScope,
        limit:
          (current.scope === normalizedScope ? current.limit : CHAT_RENDER_WINDOW_INITIAL) +
          Math.min(delta, CHAT_RENDER_WINDOW_STEP),
      }));
      setPendingExternal(false);
      return;
    }
    if (!historyLoading && !hasEarlierHistory) setPendingExternal(false);
  }, [messages.length, pendingExternal, historyLoading, hasEarlierHistory, normalizedScope]);

  // 历史加载失败/超时不能让入口永久禁用；协议层按钮仍可重试。
  useEffect(() => {
    if (!pendingExternal) return;
    const handle = setTimeout(() => setPendingExternal(false), 5_000);
    return () => clearTimeout(handle);
  }, [pendingExternal]);

  const visible = useMemo(
    () => (limit >= messages.length ? messages : messages.slice(Math.max(0, messages.length - limit))),
    [messages, limit],
  );
  const hiddenCount = Math.max(0, messages.length - visible.length);
  const hasEarlier = hiddenCount > 0 || hasEarlierHistory;
  const loadEarlier = useCallback(() => {
    if (hiddenCount > 0) {
      setWindowState((current) => ({
        scope: normalizedScope,
        limit:
          (current.scope === normalizedScope ? current.limit : CHAT_RENDER_WINDOW_INITIAL) + CHAT_RENDER_WINDOW_STEP,
      }));
      return;
    }
    if (!hasEarlierHistory || historyLoading || pendingExternal) return;
    setPendingExternal(true);
    const result = onLoadEarlierHistory?.();
    if (result === false) setPendingExternal(false);
  }, [hiddenCount, hasEarlierHistory, historyLoading, pendingExternal, normalizedScope, onLoadEarlierHistory]);

  return { visible, hiddenCount, hasEarlier, loading: historyLoading || pendingExternal, loadEarlier };
}

export function ChatLoadEarlier({
  hiddenCount,
  onLoadEarlier,
  loading = false,
  scrollToFirstNew = hiddenCount > 0,
}: {
  hiddenCount: number;
  onLoadEarlier: () => void;
  loading?: boolean;
  /** 仅组件内部窗口揭示时把视口移到第一条新增历史；协议层异步批次由浏览器锚定。 */
  scrollToFirstNew?: boolean;
}) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const { contentRef, scrollRef, stopScroll } = useStickToBottomContext();
  const handleLoadEarlier = useCallback(() => {
    const content = contentRef.current;
    const scroll = scrollRef.current;
    // 先停止当前跟随动画；加载后把视口移到“第一条新增历史”，而不是继续钉在底部。
    stopScroll();
    onLoadEarlier();
    // 协议层批次是异步到达的，由数据层窗口揭示；这里不改视口，避免在旧内容上跳位。
    if (!scrollToFirstNew) return;
    setTimeout(() => {
      if (!content || !scroll) return;
      const button = content.querySelector('[data-slot="chat-load-earlier"]');
      const firstNew = button ? button.nextElementSibling : content.firstElementChild;
      if (firstNew instanceof HTMLElement) scroll.scrollTop = firstNew.offsetTop;
    }, 0);
  }, [contentRef, onLoadEarlier, scrollRef, scrollToFirstNew, stopScroll]);
  return (
    <div className="flex justify-center py-1" data-slot="chat-load-earlier">
      <Button type="button" variant="ghost" size="sm" onClick={handleLoadEarlier} disabled={loading}>
        {hiddenCount > 0
          ? t("chat.components.chatView.loadEarlier", { count: hiddenCount })
          : t("chat.components.chatView.loadEarlierUnknown")}
      </Button>
    </div>
  );
}
