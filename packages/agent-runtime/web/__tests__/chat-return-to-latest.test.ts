// 回到最新的 DOM 时序回归：滚动目标必须在 await 前锁定，await 后只接受仍挂载的节点。

import { describe, expect, test } from "bun:test";
import type { ChatLogScroller } from "../agent-panel/return-to-latest";
import { restoreLatestThenScroll } from "../agent-panel/return-to-latest";

function noticeFor(resolve: () => ChatLogScroller | null): Element {
  return {
    closest: () => ({ querySelector: () => resolve() }),
    parentElement: null,
  } as unknown as Element;
}

function scrollerWith(state: { connected: boolean; scrollTop: number }): ChatLogScroller {
  return {
    get isConnected() {
      return state.connected;
    },
    get scrollTop() {
      return state.scrollTop;
    },
    set scrollTop(value: number) {
      state.scrollTop = value;
    },
    scrollHeight: 240,
  };
}

describe("回到最新的滚动时序", () => {
  // 滚动节点必须在等待数据层之前捕获，避免 await 期间横幅卸载后找不到节点。
  test("先捕获滚动节点再等待数据恢复", async () => {
    const calls: string[] = [];
    const state = { connected: true, scrollTop: 0 };
    const scroller = scrollerWith(state);
    const notice = {
      closest: () => {
        calls.push("locate");
        return { querySelector: () => scroller };
      },
      parentElement: null,
    } as unknown as Element;
    const frames: Array<() => void> = [];

    await restoreLatestThenScroll({
      notice,
      returnToLatest: async () => {
        calls.push("restore");
        return true;
      },
      scheduleFrame: (task) => frames.push(task),
    });

    expect(calls).toEqual(["locate", "restore"]);
    expect(state.scrollTop).toBe(0);
    frames[0]?.();
    expect(state.scrollTop).toBe(240);
  });

  // await 期间面板重渲染替换了消息区：旧节点已断开，不得再滚动它。
  test("等待期间节点被卸载时不滚动旧节点", async () => {
    const state = { connected: true, scrollTop: 0 };
    const scroller = scrollerWith(state);
    let frames = 0;

    await restoreLatestThenScroll({
      notice: noticeFor(() => scroller),
      returnToLatest: async () => {
        state.connected = false;
        return true;
      },
      scheduleFrame: () => {
        frames += 1;
      },
    });

    expect(frames).toBe(0);
    expect(state.scrollTop).toBe(0);
  });

  // 数据层未恢复最新区间（ready=false）时不滚动，保持当前阅读位置。
  test("数据层未就绪时不滚动", async () => {
    const state = { connected: true, scrollTop: 10 };
    let frames = 0;

    await restoreLatestThenScroll({
      notice: noticeFor(() => scrollerWith(state)),
      returnToLatest: async () => false,
      scheduleFrame: () => {
        frames += 1;
      },
    });

    expect(frames).toBe(0);
    expect(state.scrollTop).toBe(10);
  });
});
