import { describe, expect, test } from "bun:test";
import { ConnectionRegistry } from "../transport/relay/yjs-frontend/connection-registry";
import type { ClientConnection, SharedRelay } from "../transport/relay/yjs-frontend/types";

function createClient(overrides: Partial<ClientConnection> = {}): ClientConnection {
  return {
    ws: { readyState: 1, send() {}, close() {} },
    userId: "user-1",
    agentId: "agent-1",
    relayHandle: { state: "open", send() {}, close() {} },
    relayUnsub: null,
    keepalive: 0 as unknown as ReturnType<typeof setInterval>,
    instanceId: "instance-1",
    rcsSessionId: "rcs-1",
    acpSessionId: null,
    workspacePath: "/workspace",
    openTime: 0,
    pendingMessages: [],
    relayReady: true,
    agentStatusReceived: false,
    sessionLoaded: false,
    ...overrides,
  };
}

function createSharedRelay(overrides: Partial<SharedRelay> = {}): SharedRelay {
  return {
    handle: { state: "open", send() {}, close() {} },
    unsubscribe: null,
    refCount: 1,
    userId: "user-1",
    agentId: "agent-1",
    instanceId: "instance-1",
    rcsSessionId: "rcs-1",
    workspacePath: "/workspace",
    ...overrides,
  };
}

describe("ConnectionRegistry", () => {
  // setup 阶段的 pending 消息必须按 wsId 隔离，并在消费后清空。
  test("isolates pending buffers and clears them after consume", () => {
    const registry = new ConnectionRegistry();
    registry.createPending("ws-1");
    registry.createPending("ws-2");
    registry.bufferPending("ws-1", "first");
    registry.bufferPending("ws-2", "second");

    expect(registry.consumePending("ws-1")).toEqual(["first"]);
    expect(registry.consumePending("ws-1")).toBeUndefined();
    expect(registry.consumePending("ws-2")).toEqual(["second"]);
  });

  // 通过 RCS session 定向遍历时不得包含其他 session 的连接。
  test("iterates only clients in the requested RCS session", () => {
    const registry = new ConnectionRegistry();
    registry.addClient("ws-1", createClient({ rcsSessionId: "rcs-target" }));
    registry.addClient("ws-2", createClient({ rcsSessionId: "rcs-other" }));
    registry.addClient("ws-3", createClient({ rcsSessionId: "rcs-target" }));
    const visited: string[] = [];

    registry.forEachByRcsSession("rcs-target", (client) => visited.push(client.rcsSessionId));

    expect(visited).toEqual(["rcs-target", "rcs-target"]);
  });

  // 同一实例的 shared relay 获取必须复用原对象并递增引用计数。
  test("acquires an existing shared relay by reference", () => {
    const registry = new ConnectionRegistry();
    const shared = createSharedRelay();
    registry.addShared(shared);

    expect(registry.acquireExisting("instance-1", "user-1")).toBe(shared);
    expect(shared.refCount).toBe(2);
  });

  // 仅最后一个引用释放时返回 shared relay 并从注册表中删除。
  test("releases a shared relay only after its final reference", () => {
    const registry = new ConnectionRegistry();
    const shared = createSharedRelay({ refCount: 2 });
    registry.addShared(shared);

    expect(registry.release("instance-1", "user-1")).toBeUndefined();
    expect(shared.refCount).toBe(1);
    expect(registry.getShared("instance-1", "user-1")).toBe(shared);
    expect(registry.release("instance-1", "user-1")).toBe(shared);
    expect(registry.getShared("instance-1", "user-1")).toBeUndefined();
  });
});
