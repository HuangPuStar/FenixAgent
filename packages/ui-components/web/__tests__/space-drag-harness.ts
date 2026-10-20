// space 拖放的测试夹具：把 happy-dom 里「恒为 0 的布局」补成可判定的矩形，再用真实指针事件
// 驱动 dnd-kit 的 PointerSensor，让归属写入走完「按下 → 越过 5px 阈值 → 落到分组 → 松手」全链路。
//
// **为什么需要它**：拖拽是会话归属的唯一写入路径（行内「移动到…」菜单已于 2026-10-16 删除），
// 而 dnd-kit 的 `pointerWithin` 读 `getBoundingClientRect()`——happy-dom 恒返回全 0 矩形，
// 指针压不到任何 droppable 上（`over` 恒为 null），写入路径在测试里不可达。夹具只做两件事：
//
// 1. 在 `Element.prototype` 上按「分组在列表中的序号」铺一条 40px 高的横条（`data-space-drop-id`
//    的元素取横条，其余元素取一条固定的兜底矩形）——这是**唯一的假件**，不改产品代码的判据。
// 2. 按 dnd-kit 的状态机派发指针事件：`pointerdown` → **两次** `pointermove`（第一次越过激活阈值
//    只启动拖拽、不产生落点，第二次才更新 `translate` 与碰撞结果）→ `pointerup`。
//
// 代价与移除条件：夹具依赖 dnd-kit 的激活时序与 `pointerWithin` 读 `getBoundingClientRect` 这两条
// 实现细节，升级 @dnd-kit/core 后若用例变红，先核对该版本 `AbstractPointerSensor.handleMove` 与
// 碰撞回调的入参，再调整本文件（而不是把用例改回不可达的手工调用）。

import type { Window } from "happy-dom";

/** 每条分组横条的高度（像素），仅用于让指针坐标落在唯一一条横条上。 */
const BAND_HEIGHT = 40;
/** 横条宽度（像素）；会话行与其它元素共用它，碰撞只看分组。 */
const BAND_WIDTH = 200;
/** 松手后的收尾等待（毫秒）：覆盖 dnd-kit `detach()` 的 50ms 定时器。 */
const SETTLE_DELAY_MS = 60;

interface SpaceDropRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface SpaceDragHarness {
  /**
   * 声明当前用例的分组顺序（渲染顺序即 drop id 顺序，默认分组在最底）。横条按该顺序自上而下铺开。
   * 每个用例渲染前调用一次；顺序变了而没重新声明，落点会指向另一条横条。
   */
  setDropOrder(dropIds: readonly string[]): void;
  /** 分组横条的中心坐标（用于把指针放到某个分组上）。 */
  centerOf(dropId: string): { x: number; y: number };
  /** 列表之外（任何分组横条之下）的坐标，用于「松手在列表外 → 不改归属」。 */
  outsidePoint(): { x: number; y: number };
}

/**
 * 安装布局假件并返回拖放夹具。
 *
 * @param win 用例自建的 happy-dom Window（同一个 Window 只安装一次；重复安装会叠加包装）
 */
export function installSpaceDragHarness(win: Window): SpaceDragHarness {
  const order: string[] = [];
  const bandOf = (index: number): SpaceDropRect => ({
    top: index * BAND_HEIGHT,
    bottom: (index + 1) * BAND_HEIGHT,
    left: 0,
    right: BAND_WIDTH,
  });

  const prototype = win.Element.prototype as unknown as { getBoundingClientRect: () => Record<string, unknown> };
  prototype.getBoundingClientRect = function (this: Element) {
    const dropId = this.getAttribute?.("data-space-drop-id");
    const index = dropId ? order.indexOf(dropId) : -1;
    // 兜底矩形（会话行等）：固定放在第一条横条上，拖拽源自身的矩形不参与碰撞判定。
    const rect = index < 0 ? { top: 0, bottom: BAND_HEIGHT, left: 0, right: BAND_WIDTH } : bandOf(index);
    return {
      ...rect,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      x: rect.left,
      y: rect.top,
      toJSON: () => rect,
    };
  };

  return {
    setDropOrder(dropIds) {
      order.length = 0;
      order.push(...dropIds);
    },
    centerOf(dropId) {
      const index = order.indexOf(dropId);
      if (index < 0) throw new Error(`分组顺序里没有 ${dropId}：先调用 setDropOrder`);
      return { x: BAND_WIDTH / 2, y: index * BAND_HEIGHT + BAND_HEIGHT / 2 };
    },
    outsidePoint() {
      return { x: BAND_WIDTH / 2, y: order.length * BAND_HEIGHT + BAND_HEIGHT };
    },
  };
}

/** 指针事件：dnd-kit 的 PointerSensor 只接受 `isPrimary` + 左键。 */
function pointerEvent(win: Window, type: string, point: { x: number; y: number }): Event {
  return new win.PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: point.x,
    clientY: point.y,
    button: 0,
    isPrimary: true,
    pointerId: 1,
  }) as unknown as Event;
}

/**
 * 拖一次会话行到目标坐标：按下 → 两次移动 → 松手。
 *
 * 起点固定在横条之外的同一处（落点只由松手坐标与布局决定，起点只需与它拉开 5px 以上）。
 *
 * @param act React 的 `act`（事件会同步触发 setState，必须包在 act 里）
 * @param target 目标分组中心的坐标；传 `outsidePoint()` 即「松手在列表外」，落点为空、不改归属
 */
export async function dragSessionTo(
  win: Window,
  container: HTMLElement,
  sessionId: string,
  act: (callback: () => void) => Promise<void>,
  target: { x: number; y: number },
): Promise<void> {
  const row = container.querySelector(`[data-draggable-session="${sessionId}"]`);
  if (!row) throw new Error(`未找到可拖会话行：${sessionId}`);
  // 起点固定在「分组横条之外」的同一处：激活阈值（5px）只与位移有关，起点不影响落点。
  const start = { x: target.x, y: -BAND_HEIGHT };

  await act(() => {
    row.dispatchEvent(pointerEvent(win, "pointerdown", start));
  });
  // 两次移动：第一次越过 5px 阈值只启动拖拽（`handleMove` 直接 return），第二次才更新落点。
  for (let index = 0; index < 2; index += 1) {
    await act(() => {
      win.document.dispatchEvent(pointerEvent(win, "pointermove", target));
    });
  }
  // 松手：事件本身要在 act 内派发，写入 promise 的 `finally` 与 dnd-kit 排的定时器
  // （`AbstractPointerSensor.detach()` 的 50ms、无障碍播报）也要在**同一个** act 内结算——
  // 同步 act 会先退出，微任务随后落到 act 之外，React 就会打出「not wrapped in act」告警。
  await act(async () => {
    win.document.dispatchEvent(pointerEvent(win, "pointerup", target));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));
  });
}
