import { beforeEach, describe, expect, test } from "bun:test";
import { EventBus, getAllEventBuses, getEventBus, removeEventBus } from "../transport/event-bus";

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  describe("publish", () => {
    test("publishes event with seqNum starting at 1", () => {
      const event = bus.publish({
        id: "e1",
        sessionId: "s1",
        type: "user",
        payload: { content: "hello" },
        direction: "outbound",
      });
      expect(event.seqNum).toBe(1);
      expect(event.createdAt).toBeGreaterThan(0);
    });

    test("increments seqNum on each publish", () => {
      bus.publish({ id: "e1", sessionId: "s1", type: "user", payload: {}, direction: "outbound" });
      bus.publish({ id: "e2", sessionId: "s1", type: "assistant", payload: {}, direction: "inbound" });
      const event = bus.publish({ id: "e3", sessionId: "s1", type: "result", payload: {}, direction: "inbound" });
      expect(event.seqNum).toBe(3);
    });

    test("throws when publishing to a closed bus", () => {
      bus.close();
      expect(() =>
        bus.publish({ id: "e1", sessionId: "s1", type: "user", payload: {}, direction: "outbound" }),
      ).toThrow("EventBus is closed");
    });
  });

  describe("subscribe", () => {
    test("receives published events", () => {
      const received: unknown[] = [];
      bus.subscribe((event) => received.push(event));

      bus.publish({ id: "e1", sessionId: "s1", type: "user", payload: { content: "hi" }, direction: "outbound" });
      expect(received).toHaveLength(1);
      expect((received[0] as any).payload).toEqual({ content: "hi" });
    });

    test("unsubscribe stops receiving events", () => {
      const received: unknown[] = [];
      const unsub = bus.subscribe((event) => received.push(event));
      unsub();
      bus.publish({ id: "e1", sessionId: "s1", type: "user", payload: {}, direction: "outbound" });
      expect(received).toHaveLength(0);
    });

    test("multiple subscribers all receive events", () => {
      const r1: unknown[] = [];
      const r2: unknown[] = [];
      bus.subscribe((e) => r1.push(e));
      bus.subscribe((e) => r2.push(e));
      bus.publish({ id: "e1", sessionId: "s1", type: "user", payload: {}, direction: "outbound" });
      expect(r1).toHaveLength(1);
      expect(r2).toHaveLength(1);
    });

    test("subscriber error does not affect other subscribers", () => {
      const received: unknown[] = [];
      bus.subscribe(() => {
        throw new Error("boom");
      });
      bus.subscribe((e) => received.push(e));
      bus.publish({ id: "e1", sessionId: "s1", type: "user", payload: {}, direction: "outbound" });
      expect(received).toHaveLength(1);
    });

    test("subscriberCount", () => {
      expect(bus.subscriberCount()).toBe(0);
      const unsub1 = bus.subscribe(() => {});
      expect(bus.subscriberCount()).toBe(1);
      const _unsub2 = bus.subscribe(() => {});
      expect(bus.subscriberCount()).toBe(2);
      unsub1();
      expect(bus.subscriberCount()).toBe(1);
    });
  });

  describe("getEventsSince", () => {
    test("returns events after given seqNum", () => {
      bus.publish({ id: "e1", sessionId: "s1", type: "user", payload: {}, direction: "outbound" });
      bus.publish({ id: "e2", sessionId: "s1", type: "assistant", payload: {}, direction: "inbound" });
      bus.publish({ id: "e3", sessionId: "s1", type: "result", payload: {}, direction: "inbound" });

      const events = bus.getEventsSince(1);
      expect(events).toHaveLength(2);
      expect(events[0].seqNum).toBe(2);
      expect(events[1].seqNum).toBe(3);
    });

    test("returns empty for seqNum beyond last", () => {
      bus.publish({ id: "e1", sessionId: "s1", type: "user", payload: {}, direction: "outbound" });
      expect(bus.getEventsSince(1)).toHaveLength(0);
    });

    test("returns all events when seqNum is 0", () => {
      bus.publish({ id: "e1", sessionId: "s1", type: "user", payload: {}, direction: "outbound" });
      bus.publish({ id: "e2", sessionId: "s1", type: "assistant", payload: {}, direction: "inbound" });
      expect(bus.getEventsSince(0)).toHaveLength(2);
    });
  });

  describe("getLastSeqNum", () => {
    test("returns 0 for empty bus", () => {
      expect(bus.getLastSeqNum()).toBe(0);
    });

    test("returns last seqNum after publishes", () => {
      bus.publish({ id: "e1", sessionId: "s1", type: "user", payload: {}, direction: "outbound" });
      bus.publish({ id: "e2", sessionId: "s1", type: "user", payload: {}, direction: "outbound" });
      expect(bus.getLastSeqNum()).toBe(2);
    });
  });

  describe("close", () => {
    test("clears subscribers and prevents publishing", () => {
      bus.subscribe(() => {});
      bus.close();
      expect(bus.subscriberCount()).toBe(0);
      expect(() =>
        bus.publish({ id: "e1", sessionId: "s1", type: "user", payload: {}, direction: "outbound" }),
      ).toThrow();
    });
  });

  describe("event eviction", () => {
    test("evicts oldest events when exceeding MAX_EVENTS_PER_BUS", () => {
      // Publish enough events to trigger eviction (5001+ events)
      // We test the eviction behavior by checking getEventsSince consistency
      const first = bus.publish({ id: "e1", sessionId: "s1", type: "user", payload: {}, direction: "outbound" });
      expect(first.seqNum).toBe(1);

      // Publish many events to exceed the limit
      for (let i = 2; i <= 5001; i++) {
        bus.publish({ id: `e${i}`, sessionId: "s1", type: "user", payload: {}, direction: "outbound" });
      }

      // After eviction, the first event should no longer be retrievable
      const eventsSince0 = bus.getEventsSince(0);
      expect(eventsSince0.length).toBeLessThan(5001);
      // The newest events should still be accessible
      expect(eventsSince0.length).toBeGreaterThan(0);
      // seqNum should still be correct
      expect(bus.getLastSeqNum()).toBe(5001);
    });
  });

  describe("inject", () => {
    // inject 触发本地 subscriber 但不再次发布
    test("inject 触发本地 subscriber 但不再次发布", () => {
      const received: unknown[] = [];
      bus.subscribe((e) => received.push(e));
      const injectedEvent = {
        id: "remote-e1",
        sessionId: "s1",
        type: "remote",
        payload: { from: "node-2" },
        direction: "outbound" as const,
        seqNum: 42,
        createdAt: Date.now() - 1000,
      };
      bus.inject(injectedEvent);
      expect(received).toHaveLength(1);
      expect((received[0] as any).seqNum).toBe(42);
      expect((received[0] as any).id).toBe("remote-e1");
    });

    // inject 将 seqNum 同步到注入事件的值（当更大时）
    test("inject 同步 seqNum 到较大值", () => {
      // 先本地发布 seqNum = 1
      bus.publish({ id: "local", sessionId: "s1", type: "user", payload: {}, direction: "outbound" });
      expect(bus.getLastSeqNum()).toBe(1);

      // 注入一个 seqNum = 100 的远端事件
      bus.inject({
        id: "remote-big",
        sessionId: "s1",
        type: "remote",
        payload: {},
        direction: "inbound",
        seqNum: 100,
        createdAt: Date.now(),
      });
      expect(bus.getLastSeqNum()).toBe(100);
    });

    // inject 不更新 seqNum（当注入事件 seqNum 更小时）
    test("inject 较小 seqNum 时 seqNum 不变", () => {
      bus.publish({ id: "local", sessionId: "s1", type: "user", payload: {}, direction: "outbound" });
      bus.publish({ id: "local2", sessionId: "s1", type: "user", payload: {}, direction: "outbound" });
      expect(bus.getLastSeqNum()).toBe(2);

      bus.inject({
        id: "old",
        sessionId: "s1",
        type: "remote",
        payload: {},
        direction: "inbound",
        seqNum: 1,
        createdAt: Date.now(),
      });
      expect(bus.getLastSeqNum()).toBe(2);
    });

    // inject 到已关闭 bus 时被忽略
    test("inject 到已关闭 bus 被忽略", () => {
      bus.close();
      bus.inject({
        id: "e1",
        sessionId: "s1",
        type: "remote",
        payload: {},
        direction: "inbound",
        seqNum: 1,
        createdAt: Date.now(),
      });
      expect(bus.getLastSeqNum()).toBe(0);
    });

    // inject 事件在 eviction 范围内
    test("inject 触发 eviction 后新事件可见", () => {
      // 用 publish 先填满到 5000
      for (let i = 1; i <= 5000; i++) {
        bus.publish({ id: `e${i}`, sessionId: "s1", type: "user", payload: {}, direction: "outbound" });
      }
      // 再 inject 一个事件（seqNum = 5001）
      bus.inject({
        id: "injected-after-full",
        sessionId: "s1",
        type: "remote",
        payload: {},
        direction: "inbound",
        seqNum: 5001,
        createdAt: Date.now(),
      });
      // 最新注入的事件应该可见
      const recent = bus.getEventsSince(5000);
      expect(recent).toHaveLength(1);
      expect(recent[0].id).toBe("injected-after-full");
    });
  });

  describe("event eviction 边界", () => {
    // 驱逐后 seqNum 连续性保持
    test("驱逐后 getEventsSince 返回的事件 seqNum 连续", () => {
      for (let i = 1; i <= 5001; i++) {
        bus.publish({ id: `e${i}`, sessionId: "s1", type: "user", payload: {}, direction: "outbound" });
      }
      const events = bus.getEventsSince(0);
      // 驱逐后保留约 2500 条事件
      expect(events.length).toBeGreaterThan(0);
      expect(events.length).toBeLessThan(5001);
      // seqNum 应保持单调递增
      for (let i = 1; i < events.length; i++) {
        expect(events[i].seqNum).toBeGreaterThan(events[i - 1].seqNum);
      }
    });

    // 精确 5000 条时不驱逐
    test("精确 5000 条时所有事件可查询", () => {
      for (let i = 1; i <= 5000; i++) {
        bus.publish({ id: `e${i}`, sessionId: "s1", type: "user", payload: {}, direction: "outbound" });
      }
      const all = bus.getEventsSince(0);
      expect(all).toHaveLength(5000);
    });
  });
});

describe("EventBus registry", () => {
  beforeEach(() => {
    // Clean up global registry
    for (const [key] of getAllEventBuses()) {
      removeEventBus(key);
    }
  });

  describe("getEventBus", () => {
    test("creates new bus for unknown session", () => {
      const bus = getEventBus("s1");
      expect(bus).toBeInstanceOf(EventBus);
      expect(getAllEventBuses().has("s1")).toBe(true);
    });

    test("returns same bus for same session", () => {
      const bus1 = getEventBus("s1");
      const bus2 = getEventBus("s1");
      expect(bus1).toBe(bus2);
    });
  });

  describe("removeEventBus", () => {
    test("removes and closes bus", () => {
      const bus = getEventBus("s2");
      removeEventBus("s2");
      expect(getAllEventBuses().has("s2")).toBe(false);
      expect(() =>
        bus.publish({ id: "e1", sessionId: "s2", type: "user", payload: {}, direction: "outbound" }),
      ).toThrow();
    });

    test("no-op for non-existent bus", () => {
      expect(() => removeEventBus("nonexistent")).not.toThrow();
    });
  });

  describe("getAllEventBuses", () => {
    test("returns all registered buses", () => {
      getEventBus("a");
      getEventBus("b");
      expect(getAllEventBuses().size).toBeGreaterThanOrEqual(2);
    });
  });
});
