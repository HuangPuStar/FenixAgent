import { describe, expect, test } from "bun:test";
import { ConnectionRegistry } from "../channel/connection-registry";
import { createClient, createSharedRelay, createWs } from "../channel/connection-test-helpers";

describe("ConnectionRegistry round15", () => {
  // 新建 pending 连接应占用一个独立的消息缓冲区。
  test("创建 pending 连接时初始化空缓冲区", () => {
    const registry = new ConnectionRegistry();

    registry.createPending("ws-1");

    expect(registry.consumePending("ws-1")).toEqual([]);
  });

  // 活跃与挂起连接总数达到配额后，新的 pending 连接必须被拒绝。
  test("连接配额已满时拒绝 pending 连接", () => {
    const registry = new ConnectionRegistry();
    registry.createPending("ws-1");

    expect(registry.tryCreatePending("ws-2", 1)).toBe(false);
    expect(registry.consumePending("ws-2")).toBeUndefined();
  });

  // 未达配额时，tryCreatePending 应登记连接并返回成功。
  test("配额未满时登记 pending 连接", () => {
    const registry = new ConnectionRegistry();

    expect(registry.tryCreatePending("ws-1", 1)).toBe(true);
    expect(registry.consumePending("ws-1")).toEqual([]);
  });

  // 只有真实存在的 pending 连接且活跃数未满时才允许提升。
  test("pending 提升资格同时校验连接存在与活跃配额", () => {
    const registry = new ConnectionRegistry();
    registry.createPending("pending");
    registry.addClient("active", createClient());

    expect(registry.canPromotePending("missing", 2)).toBe(false);
    expect(registry.canPromotePending("pending", 1)).toBe(false);
    expect(registry.canPromotePending("pending", 2)).toBe(true);
  });

  // pending 阶段收到的消息必须按写入顺序完整消费。
  test("消费 pending 消息时保留写入顺序", () => {
    const registry = new ConnectionRegistry();
    registry.createPending("ws-1");
    registry.bufferPending("ws-1", "first");
    registry.bufferPending("ws-1", "second");

    expect(registry.consumePending("ws-1")).toEqual(["first", "second"]);
    expect(registry.consumePending("ws-1")).toBeUndefined();
  });

  // 丢弃 pending 连接后，缓冲内容不得在后续读取中泄漏。
  test("丢弃 pending 连接时清理其缓冲消息", () => {
    const registry = new ConnectionRegistry();
    registry.createPending("ws-1");
    registry.bufferPending("ws-1", "secret-message");

    registry.discardPending("ws-1");

    expect(registry.consumePending("ws-1")).toBeUndefined();
  });

  // 未就绪的活跃连接应继续缓冲消息，避免 relay 未就绪时丢帧。
  test("relay 未就绪的活跃连接缓冲消息", () => {
    const registry = new ConnectionRegistry();
    const client = createClient({ relayReady: false });
    registry.addClient("ws-1", client);

    registry.bufferPending("ws-1", "queued");

    expect(registry.consumePending("ws-1")).toEqual(["queued"]);
  });

  // relay 就绪的活跃连接不应被错误写入 pending 缓冲区。
  test("relay 就绪的活跃连接不再缓冲消息", () => {
    const registry = new ConnectionRegistry();
    registry.addClient("ws-1", createClient({ relayReady: true }));

    registry.bufferPending("ws-1", "ignored");

    expect(registry.consumePending("ws-1")).toBeUndefined();
  });

  // 提升为活跃连接时必须转移此前 pending 阶段的所有消息。
  test("添加活跃连接时转移 pending 消息", () => {
    const registry = new ConnectionRegistry();
    registry.createPending("ws-1");
    registry.bufferPending("ws-1", "before-open");
    const client = createClient();

    registry.addClient("ws-1", client);

    expect(client.pendingMessages).toEqual(["before-open"]);
    expect(registry.clientCount).toBe(1);
  });

  // 移除客户端后应返回原连接并从注册表清除。
  test("移除客户端时返回连接并减少计数", () => {
    const registry = new ConnectionRegistry();
    const client = createClient();
    registry.addClient("ws-1", client);

    expect(registry.removeClient("ws-1")).toBe(client);
    expect(registry.clientCount).toBe(0);
    expect(registry.getClient("ws-1")).toBeUndefined();
  });

  // 全量遍历应覆盖每个客户端且携带其稳定 wsId。
  test("遍历客户端条目时提供 wsId 与客户端", () => {
    const registry = new ConnectionRegistry();
    registry.addClient("ws-a", createClient({ userId: "user-a" }));
    registry.addClient("ws-b", createClient({ userId: "user-b" }));
    const entries: string[] = [];

    registry.forEachClientEntry((wsId, client) => entries.push(`${wsId}:${client.userId}`));

    expect(entries).toEqual(["ws-a:user-a", "ws-b:user-b"]);
  });

  // 按实例遍历必须排除同 agent 的其他实例。
  test("按实例遍历隔离不同实例", () => {
    const registry = new ConnectionRegistry();
    registry.addClient("one", createClient({ agentId: "agent", instanceId: "instance-a" }));
    registry.addClient("two", createClient({ agentId: "agent", instanceId: "instance-b" }));
    const users: string[] = [];

    registry.forEachByInstance("agent", "instance-a", (client) => users.push(client.userId));

    expect(users).toEqual(["user-1"]);
  });

  // 同一实例下按用户遍历必须避免跨用户广播。
  test("按实例与用户遍历隔离不同用户", () => {
    const registry = new ConnectionRegistry();
    registry.addClient("one", createClient({ userId: "user-a" }));
    registry.addClient("two", createClient({ userId: "user-b" }));
    const sessions: string[] = [];

    registry.forEachByInstanceUser("agent-1", "instance-1", "user-a", (client) => sessions.push(client.rcsSessionId));

    expect(sessions).toEqual(["rcs-1"]);
  });

  // RCS session 定向遍历必须避免向其他会话泄漏事件。
  test("按 RCS 会话遍历隔离不同会话", () => {
    const registry = new ConnectionRegistry();
    registry.addClient("one", createClient({ rcsSessionId: "rcs-a" }));
    registry.addClient("two", createClient({ rcsSessionId: "rcs-b" }));
    const users: string[] = [];

    registry.forEachByRcsSession("rcs-b", (client) => users.push(client.userId));

    expect(users).toEqual(["user-1"]);
  });

  // 会话查询应将 null ACP session 规范化为 undefined。
  test("查询活跃会话时忽略空 ACP session", () => {
    const registry = new ConnectionRegistry();
    registry.addClient("one", createClient({ acpSessionId: null }));

    expect(registry.findActiveSessionIdByRcsSession("rcs-1")).toBeUndefined();
    expect(registry.findActiveSessionId("agent-1", "instance-1")).toBeUndefined();
  });

  // 用户维度会话查询必须只返回该用户自己的 ACP session。
  test("按用户查询活跃会话保持用户隔离", () => {
    const registry = new ConnectionRegistry();
    registry.addClient("one", createClient({ userId: "user-a", acpSessionId: "ses-a" }));
    registry.addClient("two", createClient({ userId: "user-b", acpSessionId: "ses-b" }));

    expect(registry.findActiveSessionIdByUser("agent-1", "instance-1", "user-b")).toBe("ses-b");
    expect(registry.hasActiveSessionId("agent-1", "instance-1", "ses-b")).toBe(true);
  });

  // status 收到状态应同时支持 RCS、实例和用户三种隔离查询。
  test("status 查询按 RCS 实例和用户正确隔离", () => {
    const registry = new ConnectionRegistry();
    registry.addClient("one", createClient({ userId: "user-a", rcsSessionId: "rcs-a", agentStatusReceived: true }));
    registry.addClient("two", createClient({ userId: "user-b", rcsSessionId: "rcs-b" }));

    expect(registry.hasStatusReceivedByRcsSession("rcs-a")).toBe(true);
    expect(registry.hasStatusReceived("agent-1", "instance-1")).toBe(true);
    expect(registry.hasStatusReceivedByUser("agent-1", "instance-1", "user-a")).toBe(true);
    expect(registry.hasStatusReceivedByUser("agent-1", "instance-1", "user-b")).toBe(false);
  });

  // shared relay 的 key 必须包含 RCS session，避免同用户不同会话复用错误 relay。
  test("共享 relay 按 RCS 会话隔离", () => {
    const registry = new ConnectionRegistry();
    const shared = createSharedRelay({ rcsSessionId: "rcs-a" });
    registry.addShared(shared);

    expect(registry.getShared("instance-1", "user-1", "rcs-a")).toBe(shared);
    expect(registry.getShared("instance-1", "user-1", "rcs-b")).toBeUndefined();
  });

  // 获取已有 shared relay 时应增加引用，确保最后一个客户端才触发清理。
  test("获取已有共享 relay 时递增引用计数", () => {
    const registry = new ConnectionRegistry();
    const shared = createSharedRelay({ refCount: 1 });
    registry.addShared(shared);

    expect(registry.acquireExisting("instance-1", "user-1", "rcs-1")).toBe(shared);
    expect(shared.refCount).toBe(2);
  });

  // 首次异步获取完成后应登记 relay，并对首次调用标记 created。
  test("首次获取共享 relay 时登记并标记创建者", async () => {
    const registry = new ConnectionRegistry();
    const shared = createSharedRelay({ refCount: 99 });

    const result = await registry.acquireRelay("instance-1", "user-1", "rcs-1", async () => shared);

    expect(result).toEqual({ shared, created: true });
    expect(shared.refCount).toBe(1);
    expect(registry.getShared("instance-1", "user-1", "rcs-1")).toBe(shared);
  });

  // 并发首次获取应共享同一 factory 调用，但仅发起者标记为 created。
  test("并发首次获取共享同一个创建过程", async () => {
    const registry = new ConnectionRegistry();
    const shared = createSharedRelay();
    let resolveFactory: ((value: typeof shared) => void) | undefined;
    let calls = 0;
    const factory = () => {
      calls++;
      return new Promise<typeof shared>((resolve) => {
        resolveFactory = resolve;
      });
    };

    const first = registry.acquireRelay("instance-1", "user-1", "rcs-1", factory);
    const second = registry.acquireRelay("instance-1", "user-1", "rcs-1", factory);
    resolveFactory?.(shared);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(firstResult.created).toBe(true);
    expect(secondResult.created).toBe(false);
    expect(shared.refCount).toBe(2);
  });

  // 创建失败后必须移除 in-flight 状态，使同一 key 可以安全重试。
  test("共享 relay 创建失败后允许后续重试", async () => {
    const registry = new ConnectionRegistry();
    let attempts = 0;

    await expect(
      registry.acquireRelay("instance-1", "user-1", "rcs-1", async () => {
        attempts++;
        throw new Error("relay unavailable");
      }),
    ).rejects.toThrow("relay unavailable");
    const shared = createSharedRelay();
    const retried = await registry.acquireRelay("instance-1", "user-1", "rcs-1", async () => {
      attempts++;
      return shared;
    });

    expect(attempts).toBe(2);
    expect(retried.shared).toBe(shared);
  });

  // 非最后一个引用释放时保留 relay，最后一个引用释放时才交给调用方清理。
  test("释放共享 relay 仅在引用归零时返回资源", () => {
    const registry = new ConnectionRegistry();
    const shared = createSharedRelay({ refCount: 2 });
    registry.addShared(shared);

    expect(registry.release("instance-1", "user-1", "rcs-1")).toBeUndefined();
    expect(registry.release("instance-1", "user-1", "rcs-1")).toBe(shared);
    expect(registry.getShared("instance-1", "user-1", "rcs-1")).toBeUndefined();
  });

  // 指定实例关闭时单个 WebSocket 的 close 异常不能阻塞同实例其他连接。
  test("按实例关闭时隔离单个连接关闭异常", () => {
    const registry = new ConnectionRegistry();
    const failingWs = createWs();
    failingWs.close = () => {
      throw new Error("close failed");
    };
    const healthyWs = createWs();
    registry.addClient("bad", createClient({ ws: failingWs, instanceId: "instance-a" }));
    registry.addClient("good", createClient({ ws: healthyWs, instanceId: "instance-a" }));
    registry.addClient("other", createClient({ ws: createWs(), instanceId: "instance-b" }));

    registry.closeClientsByInstance("instance-a", 4001, "terminated");

    expect(healthyWs.closed).toEqual([[4001, "terminated"]]);
  });

  // 全局关闭应释放每个客户端的 relay、清空注册表，并隔离单个 relay 的关闭异常。
  test("全局关闭清理客户端并隔离 relay 关闭异常", () => {
    const registry = new ConnectionRegistry();
    let healthyClosed = 0;
    const broken = createClient({
      relayHandle: {
        state: "open",
        send() {},
        close() {
          throw new Error("broken");
        },
      },
    });
    const healthy = createClient({
      relayHandle: {
        state: "open",
        send() {},
        close() {
          healthyClosed++;
        },
      },
    });
    registry.addClient("broken", broken);
    registry.addClient("healthy", healthy);

    registry.closeAll(4000, "shutdown");

    expect(healthyClosed).toBe(1);
    expect(registry.clientCount).toBe(0);
  });

  // 所有客户端遍历应在清理前暴露完整集合，便于宿主统一回收资源。
  test("遍历所有客户端返回当前完整集合", () => {
    const registry = new ConnectionRegistry();
    registry.addClient("one", createClient({ userId: "user-a" }));
    registry.addClient("two", createClient({ userId: "user-b" }));
    const users: string[] = [];

    registry.forEachAllClients((client) => users.push(client.userId));

    expect(users).toEqual(["user-a", "user-b"]);
  });
});
