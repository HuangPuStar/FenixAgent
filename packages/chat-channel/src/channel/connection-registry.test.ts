// packages/chat-channel/src/channel/connection-registry.test.ts
// 连接注册表测试（C6 迁移自 src/__tests__/yjs-frontend-connection-registry.test.ts，语义原样保留）：
// pending 缓冲隔离、按 rcsSessionId 定向遍历、机器清理只关 socket、
// 共享 relay 引用计数（多标签页共享、最后引用释放）。

import { describe, expect, test } from "bun:test";
import { ConnectionRegistry } from "./connection-registry";
import { createClient, createSharedRelay } from "./connection-test-helpers";

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

  // machine 清理必须通知浏览器重连；共享 relay 的引用释放仍由 WS close 生命周期统一处理。
  test("closes matching client sockets without releasing relays directly", () => {
    const registry = new ConnectionRegistry();
    let closeCalls = 0;
    let relayCloseCalls = 0;
    const client = createClient({
      ws: {
        readyState: 1,
        send() {},
        close() {
          closeCalls++;
        },
      },
      relayHandle: {
        state: "open",
        send() {},
        close() {
          relayCloseCalls++;
        },
      },
    });
    registry.addClient("ws-1", client);

    registry.closeClientsByInstance("instance-1", 4500, "machine unavailable");

    expect(closeCalls).toBe(1);
    expect(relayCloseCalls).toBe(0);
    expect(registry.getClient("ws-1")).toBe(client);
  });

  // 同一实例的 shared relay 获取必须复用原对象并递增引用计数。
  test("acquires an existing shared relay by reference", () => {
    const registry = new ConnectionRegistry();
    const shared = createSharedRelay();
    registry.addShared(shared);

    expect(registry.acquireExisting("instance-1", "user-1", "rcs-1")).toBe(shared);
    expect(shared.refCount).toBe(2);
  });

  // 仅最后一个引用释放时返回 shared relay 并从注册表中删除。
  test("releases a shared relay only after its final reference", () => {
    const registry = new ConnectionRegistry();
    const shared = createSharedRelay({ refCount: 2 });
    registry.addShared(shared);

    expect(registry.release("instance-1", "user-1", "rcs-1")).toBeUndefined();
    expect(shared.refCount).toBe(1);
    expect(registry.getShared("instance-1", "user-1", "rcs-1")).toBe(shared);
    expect(registry.release("instance-1", "user-1", "rcs-1")).toBe(shared);
    expect(registry.getShared("instance-1", "user-1", "rcs-1")).toBeUndefined();
  });
});
