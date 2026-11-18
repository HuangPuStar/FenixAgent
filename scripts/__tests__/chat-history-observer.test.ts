import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { createPageObserver } from "../chat-history/page-observer";

// CLI 到达动画帧的相位不受控；两版须在同一帧阶段触发真实按钮，计时从点击开始。
test("上翻点击统一在下一动画帧触发，等待调度不计入交互耗时", async () => {
  const frames: Array<() => void> = [];
  let clicks = 0;
  let now = 10;
  const window = {
    addEventListener() {},
    removeEventListener() {},
    __chatHistoryBench: undefined as undefined | { earlier(): Promise<boolean>; snapshot(): { earlierStart: number } },
  };
  runInNewContext(createPageObserver([]), {
    window,
    performance: { now: () => now },
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    document: {
      querySelector: (selector: string) =>
        selector.includes("chat-load-earlier") ? { disabled: false, click: () => clicks++ } : null,
      querySelectorAll: () => [],
    },
  });
  const pending = window.__chatHistoryBench!.earlier();
  expect(clicks).toBe(0);
  now = 25;
  frames[1]!();
  expect(await pending).toBe(true);
  expect(clicks).toBe(1);
  expect(window.__chatHistoryBench!.snapshot().earlierStart).toBe(25);
});
