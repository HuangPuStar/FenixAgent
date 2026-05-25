import { beforeEach, describe, expect, test } from "bun:test";
import { RelayConnectionManager } from "../transport/relay/connection-manager";

describe("RelayConnectionManager", () => {
  let manager: RelayConnectionManager;

  beforeEach(() => {
    manager = new RelayConnectionManager();
  });

  // add 和 find 连接
  test("add and find a connection", () => {
    const wsId = "relay-1";
    const entry = {
      agentId: "agent-1",
      userId: "user-1",
      unsub: null,
      keepalive: null,
      ws: { readyState: 1 } as any,
      openTime: Date.now(),
      instanceId: null,
      relayHandle: null,
      relayUnsub: null,
      outboundBuffer: [],
    };
    manager.add(wsId, entry);
    expect(manager.get(wsId)).toEqual(entry);
  });

  // remove 连接并清理定时器
  test("remove a connection and clean up", () => {
    const wsId = "relay-2";
    let unsubCalled = false;
    const entry = {
      agentId: "agent-1",
      userId: "user-1",
      unsub: () => {
        unsubCalled = true;
      },
      keepalive: null,
      ws: { readyState: 1 } as any,
      openTime: Date.now(),
      instanceId: null,
      relayHandle: null,
      relayUnsub: null,
      outboundBuffer: [],
    };
    manager.add(wsId, entry);
    manager.remove(wsId);
    expect(manager.get(wsId)).toBeUndefined();
    expect(unsubCalled).toBe(true);
  });

  // get 对不存在的 wsId 返回 undefined
  test("get returns undefined for unknown wsId", () => {
    expect(manager.get("nonexistent")).toBeUndefined();
  });

  // clearAll 移除所有连接
  test("clearAll removes all connections", () => {
    manager.add("a", {
      agentId: "a",
      userId: "u",
      unsub: null,
      keepalive: null,
      ws: {} as any,
      openTime: 0,
      instanceId: null,
      relayHandle: null,
      relayUnsub: null,
      outboundBuffer: [],
    });
    manager.add("b", {
      agentId: "b",
      userId: "u",
      unsub: null,
      keepalive: null,
      ws: {} as any,
      openTime: 0,
      instanceId: null,
      relayHandle: null,
      relayUnsub: null,
      outboundBuffer: [],
    });
    manager.clear();
    expect(manager.get("a")).toBeUndefined();
    expect(manager.get("b")).toBeUndefined();
  });

  // findByInstance 返回匹配 instanceId 的连接
  test("findByInstance returns connection matching instanceId", () => {
    manager.add("r1", {
      agentId: "a",
      userId: "u",
      unsub: null,
      keepalive: null,
      ws: {} as any,
      openTime: 0,
      instanceId: "inst-1",
      relayHandle: null,
      relayUnsub: null,
      outboundBuffer: [],
    });
    manager.add("r2", {
      agentId: "a",
      userId: "u",
      unsub: null,
      keepalive: null,
      ws: {} as any,
      openTime: 0,
      instanceId: "inst-2",
      relayHandle: null,
      relayUnsub: null,
      outboundBuffer: [],
    });
    const found = manager.findByInstance("inst-1");
    expect(found?.wsId).toBe("r1");
  });

  // findByAgentId 返回所有匹配的连接
  test("findByAgentId returns all matching connections", () => {
    manager.add("r1", {
      agentId: "a",
      userId: "u",
      unsub: null,
      keepalive: null,
      ws: {} as any,
      openTime: 0,
      instanceId: null,
      relayHandle: null,
      relayUnsub: null,
      outboundBuffer: [],
    });
    manager.add("r2", {
      agentId: "a",
      userId: "u",
      unsub: null,
      keepalive: null,
      ws: {} as any,
      openTime: 0,
      instanceId: null,
      relayHandle: null,
      relayUnsub: null,
      outboundBuffer: [],
    });
    manager.add("r3", {
      agentId: "b",
      userId: "u",
      unsub: null,
      keepalive: null,
      ws: {} as any,
      openTime: 0,
      instanceId: null,
      relayHandle: null,
      relayUnsub: null,
      outboundBuffer: [],
    });
    const found = manager.findByAgentId("a");
    expect(found).toHaveLength(2);
  });

  // hasOtherRelayForInstance 排除指定 wsId
  test("hasOtherRelayForInstance excludes given wsId", () => {
    manager.add("r1", {
      agentId: "a",
      userId: "u",
      unsub: null,
      keepalive: null,
      ws: {} as any,
      openTime: 0,
      instanceId: "inst-1",
      relayHandle: null,
      relayUnsub: null,
      outboundBuffer: [],
    });
    manager.add("r2", {
      agentId: "a",
      userId: "u",
      unsub: null,
      keepalive: null,
      ws: {} as any,
      openTime: 0,
      instanceId: "inst-1",
      relayHandle: null,
      relayUnsub: null,
      outboundBuffer: [],
    });
    expect(manager.hasOtherRelayForInstance("inst-1", "r1")).toBe(true);
    expect(manager.hasOtherRelayForInstance("inst-1", "r1")).toBe(true);
    manager.remove("r2");
    expect(manager.hasOtherRelayForInstance("inst-1", "r1")).toBe(false);
  });

  // size 返回连接数
  test("size returns connection count", () => {
    expect(manager.size).toBe(0);
    manager.add("a", {
      agentId: "a",
      userId: "u",
      unsub: null,
      keepalive: null,
      ws: {} as any,
      openTime: 0,
      instanceId: null,
      relayHandle: null,
      relayUnsub: null,
      outboundBuffer: [],
    });
    expect(manager.size).toBe(1);
  });
});
