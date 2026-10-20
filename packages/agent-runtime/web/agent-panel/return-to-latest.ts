// 回到最新的 DOM 收尾：数据层恢复区间可能让横幅/消息区重渲染，滚动目标必须在 await 前锁定。

/** 只依赖滚动所需的最小结构面，避免把 happy-dom 与真实 DOM 的类型差异带进测试。 */
export interface ChatLogScroller {
  readonly isConnected: boolean;
  scrollTop: number;
  readonly scrollHeight: number;
}

/** 消息区根节点带 `role="log"`，从历史横幅就近向上找面板列。 */
export function findChatLogScroller(notice: Element | null): ChatLogScroller | null {
  const panelRoot = notice?.closest(".chat-main-column") ?? notice?.parentElement?.parentElement ?? null;
  return panelRoot?.querySelector<HTMLElement>('[role="log"]') ?? null;
}

/**
 * 先锁定滚动节点，再等待数据层恢复最新区间。
 *
 * `returnToLatest()` 可能在其 Promise 完成前清掉 `hasLater`，横幅因此卸载并让旧引用失效；
 * await 之后重新查找会把滚动落到重渲染后的新节点或直接找不到，故必须在 await 前捕获。
 */
export async function restoreLatestThenScroll(input: {
  readonly notice: Element | null;
  readonly returnToLatest: () => Promise<boolean>;
  readonly scheduleFrame?: (task: () => void) => void;
}): Promise<void> {
  const scroller = findChatLogScroller(input.notice);
  const ready = await input.returnToLatest();
  // 节点已因面板重渲染被替换时不再滚动旧节点；新节点由后续布局自行贴底。
  if (!ready || scroller === null || !scroller.isConnected) return;
  const scheduleFrame = input.scheduleFrame ?? requestAnimationFrame;
  scheduleFrame(() => {
    scroller.scrollTop = scroller.scrollHeight;
  });
}
