import { afterEach, describe, expect, test } from "bun:test";
import {
  destroyEnvironmentQueue,
  type FileEventFrame,
  type FileEventInput,
  publishFileEvent,
  publishInvalidateAll,
  registerEnvironmentQueue,
  subscribe,
} from "../services/file-event-queue";

/** 构造一条 write 变更输入帧 */
const changed = (path: string): FileEventInput => ({ type: "file_changed", path, kind: "write", source: "user" });

/** 等待队列微任务 flush 完成 */
async function flushQueue() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("file event queue", () => {
  const envA = "queue-test-env-a";
  const envB = "queue-test-env-b";

  afterEach(() => {
    destroyEnvironmentQueue(envA);
    destroyEnvironmentQueue(envB);
  });

  // 事件应按 environmentId 隔离路由，A 环境的发布只送达 A 环境订阅者。
  test("routes events to subscribers of the same environment only", async () => {
    const gotA: FileEventFrame[] = [];
    const gotB: FileEventFrame[] = [];
    const unsubA = subscribe(envA, (frame) => gotA.push(frame));
    const unsubB = subscribe(envB, (frame) => gotB.push(frame));

    publishFileEvent(envA, changed("a.txt"));
    await flushQueue();

    expect(gotA).toHaveLength(1);
    expect(gotA[0]).toMatchObject({ type: "file_changed", environment_id: envA, path: "a.txt" });
    expect(gotB).toHaveLength(0);

    unsubA();
    unsubB();
  });

  // 每环境队列有界 200 条；第 201 条发布时触发 invalidate_all 替代，事件被丢弃而不是静默丢失。
  test("converges to invalidate_all when the bounded queue overflows", async () => {
    const frames: FileEventFrame[] = [];
    const unsub = subscribe(envA, (frame) => frames.push(frame));

    for (let i = 0; i < 200; i++) {
      publishFileEvent(envA, changed(`f-${i}.txt`));
    }
    publishFileEvent(envA, changed("overflow.txt"));
    await flushQueue();

    expect(frames.filter((frame) => frame.type === "file_changed")).toHaveLength(200);
    const invalidate = frames.filter((frame) => frame.type === "invalidate_all");
    expect(invalidate).toEqual([{ type: "invalidate_all", environment_id: envA }]);
    expect(
      frames.some((frame) => frame.type === "file_changed" && "path" in frame && frame.path === "overflow.txt"),
    ).toBe(false);

    unsub();
  });

  // 溢出收敛在 flush 后复位，后续事件恢复正常下发，避免永久失效风暴。
  test("recovers after overflow so later events flow normally", async () => {
    const frames: FileEventFrame[] = [];
    const unsub = subscribe(envA, (frame) => frames.push(frame));

    for (let i = 0; i < 200; i++) {
      publishFileEvent(envA, changed(`f-${i}.txt`));
    }
    publishFileEvent(envA, changed("overflow.txt"));
    await flushQueue();
    publishFileEvent(envA, changed("after.txt"));
    await flushQueue();

    expect(frames.some((frame) => frame.type === "file_changed" && "path" in frame && frame.path === "after.txt")).toBe(
      true,
    );

    unsub();
  });

  // publish 是 fire-and-forget：同步返回，订阅者回调在异步 flush 中执行，不阻塞发布方。
  test("publish returns synchronously without invoking subscribers", async () => {
    let calls = 0;
    const unsub = subscribe(envA, () => calls++);

    publishFileEvent(envA, changed("sync.txt"));
    expect(calls).toBe(0);

    await flushQueue();
    expect(calls).toBe(1);

    unsub();
  });

  // 单个订阅者抛错被 try/catch 隔离，不影响同环境其他订阅者收到事件。
  test("isolates a throwing subscriber from the others", async () => {
    const frames: FileEventFrame[] = [];
    subscribe(envA, () => {
      throw new Error("boom");
    });
    const unsub = subscribe(envA, (frame) => frames.push(frame));

    publishFileEvent(envA, changed("isolated.txt"));
    await flushQueue();

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ path: "isolated.txt" });

    unsub();
  });

  // 取消最后一个订阅且无机器声明时队列应被销毁，后续发布不再送达已取消的订阅者。
  test("destroys the environment queue when the last subscriber unsubscribes", async () => {
    const frames: FileEventFrame[] = [];
    const unsub = subscribe(envA, (frame) => frames.push(frame));

    publishFileEvent(envA, changed("before.txt"));
    await flushQueue();
    unsub();

    publishFileEvent(envA, changed("after.txt"));
    await flushQueue();

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ path: "before.txt" });
  });

  // 机器声明（registerEnvironmentQueue）后无订阅者也不销毁；显式 destroyEnvironmentQueue 才强制销毁。
  test("keeps the queue alive while declared and destroys it explicitly", async () => {
    registerEnvironmentQueue(envA);
    const frames: FileEventFrame[] = [];
    const unsub = subscribe(envA, (frame) => frames.push(frame));

    publishFileEvent(envA, changed("before-destroy.txt"));
    await flushQueue();
    unsub();
    destroyEnvironmentQueue(envA);

    publishFileEvent(envA, changed("after-destroy.txt"));
    await flushQueue();

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ path: "before-destroy.txt" });
  });

  // publishInvalidateAll 发布带 environment_id 的失效帧，订阅者收到 invalidate_all。
  test("publishInvalidateAll delivers an invalidate_all frame", async () => {
    const frames: FileEventFrame[] = [];
    const unsub = subscribe(envA, (frame) => frames.push(frame));

    publishInvalidateAll(envA);
    await flushQueue();

    expect(frames).toEqual([{ type: "invalidate_all", environment_id: envA }]);

    unsub();
  });

  // 批量帧注入 environment_id；degraded 为机器级帧，按环境路由但帧本身不含 environment_id。
  test("injects environment_id for batch frames and passes degraded frames through", async () => {
    const frames: FileEventFrame[] = [];
    const unsub = subscribe(envA, (frame) => frames.push(frame));

    publishFileEvent(envA, {
      type: "file_changed_batch",
      changes: [{ path: "a.txt", kind: "delete", source: "agent" }],
    });
    publishFileEvent(envA, { type: "degraded", machine_id: "m1", capability: "file", status: "down" });
    await flushQueue();

    expect(frames).toEqual([
      {
        type: "file_changed_batch",
        environment_id: envA,
        changes: [{ path: "a.txt", kind: "delete", source: "agent" }],
      },
      { type: "degraded", machine_id: "m1", capability: "file", status: "down" },
    ]);

    unsub();
  });
});
