/**
 * 时间线滑动窗口的运行时：滚动触发、滚动锚定补偿、定位命令与会话换代重置。
 *
 * 只作用在渲染层——Y.Doc、投影（`ThreadEntry[]`）与写入路径一律不变，窗口外的条目照常接收
 * 流式 chunk 与广播（数据始终完整进 Y.Doc），本 hook 仅决定「渲染哪些块」（见 `./chat-window.ts`）。
 *
 * 三个容易踩空的地方，改动前先读：
 * 1. **锚点必须在提交前取、提交后补**：滚动处理里先记下参考块的 `top`，React 提交新窗口后用
 *    `useLayoutEffect` 按位移反向写回 `scrollTop`（绘制前生效，肉眼不可见）。补偿只对「窗口滑动」
 *    设置锚点，贴底跟随交给 `use-stick-to-bottom` 自己稳，两个机制不互相拉扯。
 * 2. **自己写 `scrollTop` 也会触发滚动事件**：位置与刚写入值一致时按自触发忽略，否则会自我放大。
 * 3. **贴底判定用 DOM 现测**：`use-stick-to-bottom` 的 `isAtBottom` 由 1ms 延迟的 setTimeout 更新，
 *    当帧读到的是旧值；本模块用 `scrollHeight - scrollTop - clientHeight` 现算，并与其温和版（70px
 *    贴底）取或。
 */

import {
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import type { ChatRenderBlock } from "../../lib/chat-render-layout";
import {
  CHAT_BLOCK_INDEX_ATTRIBUTE,
  CHAT_WINDOW_AT_BOTTOM_PX,
  CHAT_WINDOW_REVEAL_LEAD_BLOCKS,
  type ChatWindowMode,
  type ChatWindowRange,
  findBlockIndexByEntryId,
  resolveAnchoredScrollTop,
  resolveChatWindow,
  resolveScrollIntent,
  resolveViewportFillIntent,
} from "./chat-window";

/** 命令式出口：窗口外的条目不在 DOM 里，跳转必须先把它所在的块滑进窗口。 */
export interface ChatTimelineWindowHandle {
  revealEntry: (entryId: string) => void;
}

interface ChatTimelineWindowState {
  key: string;
  mode: ChatWindowMode;
  start: number;
}

export interface ChatTimelineWindowInput {
  blocks: readonly ChatRenderBlock[];
  /** 是否有一轮进行中的响应：为真时窗口尾部锚定最新块，进行中的条目不滑出。 */
  live: boolean;
  /** 会话换代键（会话 ID + 首条目 ID）：变化即回到最新窗口。 */
  sessionKey: string;
  /** 窗口命令出口（`revealEntry`）。 */
  handleRef?: Ref<ChatTimelineWindowHandle> | undefined;
}

/** 补偿后忽略自身那次滚动事件的时长；位置对不上（用户又滚了）时立即放行。 */
const SELF_SCROLL_GUARD_MS = 150;

/**
 * 计算窗口区间并接管滚动锚定。
 *
 * 返回的 `range` 是块下标区间；调用方按它渲染 `blocks.slice(range.start, range.end)` 即可，
 * 无需感知窗口如何滑动。
 */
export function useChatTimelineWindow({
  blocks,
  live,
  sessionKey,
  handleRef,
}: ChatTimelineWindowInput): ChatWindowRange {
  const { scrollRef, contentRef } = useStickToBottomContext();
  const [state, setState] = useState<ChatTimelineWindowState>(() => ({ key: sessionKey, mode: "tail", start: 0 }));

  // 换代（换会话 / 投影整体替换）时回到最新窗口：旧 start 指向的是另一份时间线的内容。
  // 渲染期同步重置（React「props 变化时调整 state」写法），避免先提交一帧旧窗口再跳。
  if (state.key !== sessionKey) setState({ key: sessionKey, mode: "tail", start: 0 });

  const range = useMemo(
    () => resolveChatWindow(blocks, { mode: state.key === sessionKey ? state.mode : "tail", start: state.start, live }),
    [blocks, live, sessionKey, state.key, state.mode, state.start],
  );

  // 滚动处理与锚点补偿都跑在事件/布局阶段，读的是「当前」值，故一律经 ref 取，避免闭包读旧值。
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  const liveRef = useRef(live);
  liveRef.current = live;
  const sessionKeyRef = useRef(sessionKey);
  sessionKeyRef.current = sessionKey;
  const pendingAnchorRef = useRef<{ blockIndex: number; top: number } | null>(null);
  const pendingRevealRef = useRef<number | null>(null);
  const selfScrollRef = useRef<{ top: number; until: number } | null>(null);
  const frameRef = useRef(0);

  /** 按块下标取窗口里的 DOM 元素（块下标由视图写在 `data-chat-block-index` 上）。 */
  const findBlockElement = useCallback(
    (blockIndex: number): HTMLElement | null =>
      contentRef.current?.querySelector<HTMLElement>(`[${CHAT_BLOCK_INDEX_ATTRIBUTE}="${blockIndex}"]`) ?? null,
    [contentRef],
  );

  /** 滑动前记下参考块的视口位置；提交后由 `useLayoutEffect` 用它反向补偿 `scrollTop`。 */
  const captureAnchor = useCallback(
    (pivotIndex: number) => {
      const element = findBlockElement(pivotIndex);
      pendingAnchorRef.current = element ? { blockIndex: pivotIndex, top: element.getBoundingClientRect().top } : null;
    },
    [findBlockElement],
  );

  const applyWindow = useCallback((mode: ChatWindowMode, start: number) => {
    setState((previous) =>
      previous.key === sessionKeyRef.current && previous.mode === mode && previous.start === start
        ? previous
        : { key: sessionKeyRef.current, mode, start },
    );
  }, []);

  const handleScroll = useCallback(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;
    const selfScroll = selfScrollRef.current;
    if (selfScroll && performance.now() <= selfScroll.until && Math.abs(scrollElement.scrollTop - selfScroll.top) < 1) {
      return;
    }
    selfScrollRef.current = null;
    const distanceToBottom = scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight;
    const intent = resolveScrollIntent({
      blocks: blocksRef.current,
      range: rangeRef.current,
      atBottom: distanceToBottom <= CHAT_WINDOW_AT_BOTTOM_PX,
      scrollTop: scrollElement.scrollTop,
      distanceToBottom,
    });
    if (intent.type === "none") return;
    if (intent.type === "restoreTail") {
      // 回到底部：直接换回最新窗口。滚到底在两种状态下的可见内容一致（尾部与最新块同一处），
      // 上方的整段替换发生在视口之外，不会跳动。
      applyWindow("tail", 0);
      return;
    }
    captureAnchor(intent.pivotIndex);
    applyWindow("free", intent.nextStart);
  }, [applyWindow, captureAnchor, scrollRef]);

  // 滚动监听：rAF 节流，一次滚动最多一次窗口判定。
  useEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;
    const onScroll = () => {
      if (frameRef.current !== 0) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = 0;
        handleScroll();
      });
    };
    scrollElement.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrollElement.removeEventListener("scroll", onScroll);
      if (frameRef.current !== 0) cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    };
  }, [handleScroll, scrollRef]);

  useLayoutEffect(() => {
    const anchor = pendingAnchorRef.current;
    pendingAnchorRef.current = null;
    const scrollElement = scrollRef.current;
    if (!anchor || !scrollElement) return;
    const element = findBlockElement(anchor.blockIndex);
    if (!element) return;
    const top = element.getBoundingClientRect().top;
    const scrollTop = resolveAnchoredScrollTop({
      scrollTop: scrollElement.scrollTop,
      anchorTopBefore: anchor.top,
      anchorTopAfter: top,
    });
    if (scrollTop === scrollElement.scrollTop) return;
    selfScrollRef.current = { top: scrollTop, until: performance.now() + SELF_SCROLL_GUARD_MS };
    scrollElement.scrollTop = scrollTop;
  });

  useLayoutEffect(() => {
    const blockIndex = pendingRevealRef.current;
    pendingRevealRef.current = null;
    if (blockIndex === null) return;
    const element = findBlockElement(blockIndex);
    if (element && typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  });

  // 视口没被填满时不会有滚动事件（内容不可滚动），窗口也就再没有前插的机会；这里按剩余可滚动
  // 高度兜底前插。放在锚定补偿之后：补偿先落定，这里再以补偿后的真实位置作为下一次的锚点基线。
  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) return;
    const intent = resolveViewportFillIntent({
      blocks: blocksRef.current,
      range: rangeRef.current,
      scrollHeight: scrollElement.scrollHeight,
      clientHeight: scrollElement.clientHeight,
    });
    if (intent.type !== "prepend") return;
    captureAnchor(intent.pivotIndex);
    applyWindow("free", intent.nextStart);
  });

  const revealEntry = useCallback(
    (entryId: string) => {
      const targetIndex = findBlockIndexByEntryId(blocksRef.current, entryId);
      if (targetIndex < 0) return;
      const current = rangeRef.current;
      if (targetIndex >= current.start && targetIndex < current.end) {
        // 已在窗口内：元素就在 DOM 里，直接定位，不改窗口（也就不需要等一次提交）。
        const element = findBlockElement(targetIndex);
        if (element && typeof element.scrollIntoView === "function") {
          element.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        return;
      }
      // 目标在窗口外：以它为新窗口起点（前留几块上下文），提交后由布局阶段滚动过去。
      // 「前留」的上下文也可能因大块吃满预算而把目标挤出窗口，此时退化为目标块自身作起点 ——
      // 窗口第一块始终收入，这条兜底保证目标一定渲染得出来。
      const lead = Math.max(0, targetIndex - CHAT_WINDOW_REVEAL_LEAD_BLOCKS);
      const candidate = resolveChatWindow(blocksRef.current, { mode: "free", start: lead, live: liveRef.current });
      const reachable = targetIndex >= candidate.start && targetIndex < candidate.end;
      pendingRevealRef.current = targetIndex;
      applyWindow("free", reachable ? lead : targetIndex);
    },
    [applyWindow, findBlockElement],
  );

  useImperativeHandle(handleRef, () => ({ revealEntry }), [revealEntry]);

  return range;
}
