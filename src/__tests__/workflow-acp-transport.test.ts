/**
 * workflow-acp-transport.test.ts — AcpAgentSession.execute() 订阅泄漏修复测试
 *
 * 验证 EventBus subscribe 在所有执行路径中都能被正确清理。
 * 使用 EventBus 类直接测试订阅/取消订阅模式。
 */
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../transport/event-bus";
import { EventBus } from "../transport/event-bus";

// ---------- 辅助函数 ----------

/** 创建一个最小的 SessionEvent 对象 */
function makeEvent(overrides: Partial<SessionEvent> & { sessionId: string }): SessionEvent {
  return {
    id: overrides.id ?? "evt_1",
    sessionId: overrides.sessionId,
    type: overrides.type ?? "session_update",
    payload: overrides.payload ?? {},
    direction: overrides.direction ?? "inbound",
    seqNum: overrides.seqNum ?? 1,
    createdAt: overrides.createdAt ?? Date.now(),
  };
}

/** 模拟 AcpAgentSession.execute() 的核心订阅模式 */
async function simulateExecute(
  bus: EventBus,
  sessionId: string,
  options: {
    onSubscribe?: (bus: EventBus, sessionId: string) => void;
    shouldThrow?: boolean;
    publishEvents?: SessionEvent[];
  } = {},
): Promise<void> {
  let innerUnsub: (() => void) | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    await new Promise<void>((resolve, reject) => {
      innerUnsub = bus.subscribe((event: SessionEvent) => {
        if (event.direction !== "inbound") return;

        const payload = event.payload;
        const type =
          payload && typeof payload === "object" && "type" in payload
            ? String((payload as Record<string, unknown>).type)
            : "";

        const eventSessionId =
          payload && typeof payload === "object" && "session_id" in payload
            ? String((payload as Record<string, unknown>).session_id)
            : "";

        if (eventSessionId !== sessionId) return;

        if (type === "prompt_complete" || type === "error") {
          // 清理并完成
          if (timeoutId !== null) clearTimeout(timeoutId);
          (innerUnsub as (() => void) | null)?.();
          innerUnsub = null;
          resolve();
        }
      });

      // 模拟抛出异常（在 subscribe 之后、resolve 之前）
      if (options.shouldThrow) {
        throw new Error("模拟异常");
      }

      // 如果有事件要发布，立即发布
      if (options.publishEvents) {
        for (const evt of options.publishEvents) {
          bus.publish({
            id: evt.id,
            sessionId: evt.sessionId,
            type: evt.type,
            payload: evt.payload,
            direction: evt.direction,
          });
        }
      }

      // 设置超时（10s 足够测试用）
      timeoutId = setTimeout(() => {
        (innerUnsub as (() => void) | null)?.();
        innerUnsub = null;
        reject(new Error("超时"));
      }, 10_000);
    });
  } finally {
    // 安全网：确保任何路径都清理订阅和定时器
    if (timeoutId !== null) clearTimeout(timeoutId);
    (innerUnsub as (() => void) | null)?.();
  }
}

// ---------- 测试 ----------

describe("EventBus 订阅清理模式", () => {
  // 正常 resolve 路径应该清理订阅
  test("正常 resolve 路径清理订阅", async () => {
    const bus = new EventBus();
    const sessionId = "ses_test";
    const initialCount = bus.subscriberCount();

    const completeEvent = makeEvent({
      sessionId,
      payload: {
        type: "prompt_complete",
        session_id: sessionId,
      },
    });

    await simulateExecute(bus, sessionId, {
      publishEvents: [completeEvent],
    });

    expect(bus.subscriberCount()).toBe(initialCount);
  });

  // 异常路径（subscribe 后抛出异常）应该清理订阅
  test("subscribe 后异常路径清理订阅", async () => {
    const bus = new EventBus();
    const sessionId = "ses_test";
    const initialCount = bus.subscriberCount();

    try {
      await simulateExecute(bus, sessionId, { shouldThrow: true });
    } catch {
      // 预期会抛出异常
    }

    expect(bus.subscriberCount()).toBe(initialCount);
  });

  // error 事件路径也应该清理订阅
  test("error 事件路径清理订阅", async () => {
    const bus = new EventBus();
    const sessionId = "ses_test";
    const initialCount = bus.subscriberCount();

    const errorEvent = makeEvent({
      sessionId,
      payload: {
        type: "error",
        session_id: sessionId,
      },
    });

    await simulateExecute(bus, sessionId, {
      publishEvents: [errorEvent],
    });

    expect(bus.subscriberCount()).toBe(initialCount);
  });

  // 多次执行不应该累积订阅
  test("多次执行不累积订阅", async () => {
    const bus = new EventBus();
    const sessionId = "ses_test";
    const initialCount = bus.subscriberCount();

    for (let i = 0; i < 5; i++) {
      const completeEvent = makeEvent({
        id: `evt_${i}`,
        sessionId,
        seqNum: i + 1,
        payload: {
          type: "prompt_complete",
          session_id: sessionId,
        },
      });

      await simulateExecute(bus, sessionId, {
        publishEvents: [completeEvent],
      });
    }

    expect(bus.subscriberCount()).toBe(initialCount);
  });

  // 不同 sessionId 的事件不应触发清理（验证过滤逻辑）
  test("不同 sessionId 事件不触发 resolve", async () => {
    const bus = new EventBus();
    const targetSession = "ses_target";
    const otherSession = "ses_other";

    const initialCount = bus.subscriberCount();

    const completePromise = simulateExecute(bus, targetSession, {});

    // 发布一个给其他 session 的 prompt_complete，不应触发 resolve
    bus.publish({
      id: "evt_wrong",
      sessionId: otherSession,
      type: "session_update",
      payload: { type: "prompt_complete", session_id: otherSession },
      direction: "inbound",
    });

    // 订阅应该仍然存在（因为事件被过滤了）
    expect(bus.subscriberCount()).toBe(initialCount + 1);

    // 发布正确 session 的事件来完成
    bus.publish({
      id: "evt_right",
      sessionId: targetSession,
      type: "session_update",
      payload: { type: "prompt_complete", session_id: targetSession },
      direction: "inbound",
    });

    await completePromise;

    // 完成后订阅应被清理
    expect(bus.subscriberCount()).toBe(initialCount);
  });
});
