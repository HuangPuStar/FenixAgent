// apps/web/src/__tests__/sync-hydration-tracker.test.ts
// 新协议首批基线判定：DOC_BASE 到达且对应 processed APPLY_ACK 才解除；超时兜底；重连后重新等待。

import { describe, expect, test } from "bun:test";
import { createSyncHydrationTracker } from "../../../../packages/agent-runtime/web/yjs/sync-hydration-tracker";

describe("sync hydration tracker", () => {
  // 只有 DOC_BASE 到达不够，必须等对应的 processed APPLY_ACK；最后一块 ACK 才放行。
  test("DOC_BASE 与 APPLY_ACK 全部匹配才解除", () => {
    const events: boolean[] = [];
    const tracker = createSyncHydrationTracker({ onHydratingChange: (value) => events.push(value) });
    tracker.begin(["control", "directory"]);
    expect(events).toEqual([true]);
    tracker.addPending(["content"]);
    tracker.noteBase("control", "d_control");
    tracker.noteBase("directory", "d_directory");
    tracker.noteBase("content", "d_content");
    expect(events).toEqual([true]);
    tracker.noteAck("d_control");
    tracker.noteAck("d_directory");
    expect(events).toEqual([true]);
    tracker.noteAck("d_content");
    expect(events).toEqual([true, false]);
    expect(tracker.isDone()).toBe(true);
  });

  // 拒绝会触发 RESYNC 并带来新的 deliveryId；旧 ACK 不得推进新基线。
  test("旧 delivery ACK 不影响新基线", () => {
    const events: boolean[] = [];
    const tracker = createSyncHydrationTracker({ onHydratingChange: (value) => events.push(value) });
    tracker.begin(["content"]);
    tracker.noteBase("content", "d_old");
    tracker.noteBase("content", "d_new");
    tracker.noteAck("d_old");
    expect(events).toEqual([true]);
    tracker.noteAck("d_new");
    expect(events).toEqual([true, false]);
  });

  // 某个 ACK 丢失时按超时解除，避免展示层永久停在骨架屏。
  test("超时兜底解除 hydrating", async () => {
    const events: boolean[] = [];
    const tracker = createSyncHydrationTracker({
      timeoutMs: 10,
      onHydratingChange: (value) => events.push(value),
    });
    tracker.begin(["control"]);
    tracker.noteBase("control", "d_control");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events).toEqual([true, false]);
    expect(tracker.isDone()).toBe(true);
    tracker.dispose();
  });

  // 入口 Doc 先完成时，目录晚到的首批内容块必须重新打开等待，避免首屏先空/半截再补齐。
  test("extendInitial 在首批完成后重新等待晚到内容块", () => {
    const events: boolean[] = [];
    const tracker = createSyncHydrationTracker({ onHydratingChange: (value) => events.push(value) });
    tracker.begin(["control"]);
    tracker.noteBase("control", "d_control");
    tracker.noteAck("d_control");
    expect(tracker.isDone()).toBe(true);
    tracker.extendInitial(["content"]);
    expect(events).toEqual([true, false, true]);
    tracker.noteBase("content", "d_content");
    tracker.noteAck("d_content");
    expect(events).toEqual([true, false, true, false]);
    expect(tracker.isDone()).toBe(true);
  });

  // 重连 reset 后内部 hydrating 归零，下一轮 begin 必须重新通知 true。
  test("reset 后重新 begin 再次进入 hydrating", () => {
    const events: boolean[] = [];
    const tracker = createSyncHydrationTracker({ onHydratingChange: (value) => events.push(value) });
    tracker.begin(["control"]);
    tracker.noteBase("control", "d_control");
    tracker.noteAck("d_control");
    tracker.reset();
    tracker.begin(["control"]);
    expect(events).toEqual([true, false, true]);
    tracker.dispose();
  });
});
