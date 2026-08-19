import { afterEach, describe, expect, test } from "bun:test";
import { AppError } from "../errors";
import { shouldCountInstanceActivity } from "../services/acp-idle-monitor";
import { classifyPermanentSpawnFailure, isMachineOfflineError } from "../services/chat-channel-error-classify";
import {
  DEFAULT_MACHINE_CONNECTION_TIMEOUT_MS,
  type MachineSleep,
  type MachineStatusReader,
  waitForMachineConnection,
} from "../services/machine-connection-waiter";
import { clearOrgCache, loadOrgContext, setTestOrgContext } from "../services/org-context";
import { EventBus, getAllEventBuses, getEventBus, removeEventBus } from "../transport/event-bus";

afterEach(async () => {
  setTestOrgContext(null);
  await clearOrgCache();
  for (const [sessionId] of getAllEventBuses()) {
    removeEventBus(sessionId);
  }
});

describe("round15 isolated service boundaries", () => {
  // 已在线机器不应等待，避免无谓延迟启动请求。
  test("returns immediately when the machine is already online", async () => {
    const reads: string[] = [];
    const wait: MachineSleep = async () => {
      throw new Error("should not wait");
    };

    await waitForMachineConnection(
      "machine-1",
      DEFAULT_MACHINE_CONNECTION_TIMEOUT_MS,
      async (machineId) => {
        reads.push(machineId);
        return true;
      },
      wait,
    );

    expect(reads).toEqual(["machine-1"]);
  });

  // 离线机器在后续轮询上线后应正常放行。
  test("polls until an offline machine becomes online", async () => {
    let reads = 0;
    const delays: number[] = [];
    const reader: MachineStatusReader = async () => {
      reads += 1;
      return reads === 3;
    };
    const wait: MachineSleep = async (delayMs) => {
      delays.push(delayMs);
    };

    await waitForMachineConnection("machine-1", 1_000, reader, wait);

    expect(reads).toBe(3);
    expect(delays).toEqual([1_000, 1_000]);
  });

  // 首次轮询应使用一秒退避间隔。
  test("uses the initial one-second poll delay", async () => {
    const delays: number[] = [];
    let reads = 0;

    await waitForMachineConnection(
      "machine-1",
      1_000,
      async () => ++reads === 2,
      async (delayMs) => {
        delays.push(delayMs);
      },
    );

    expect(delays).toEqual([1_000]);
  });

  // 连接超时前不应调用等待函数，避免超时请求残留资源。
  test("fails without waiting when the connection timeout has elapsed", async () => {
    let waits = 0;

    await expect(
      waitForMachineConnection(
        "machine-timeout",
        0,
        async () => false,
        async () => {
          waits += 1;
        },
      ),
    ).rejects.toThrow("machine 'machine-timeout' connection timed out");

    expect(waits).toBe(0);
  });

  // 超时错误必须携带机器标识，便于定位失败租户的目标节点。
  test("includes the requested machine id in timeout errors", async () => {
    await expect(waitForMachineConnection("tenant-a-machine", 0, async () => false)).rejects.toThrow(
      "tenant-a-machine",
    );
  });

  // 机器状态读取异常必须原样传播，不能伪装成超时。
  test("propagates machine status reader failures", async () => {
    await expect(
      waitForMachineConnection("machine-1", 1_000, async () => {
        throw new Error("status store unavailable");
      }),
    ).rejects.toThrow("status store unavailable");
  });

  // 测试注入的组织上下文必须覆盖请求中的其他组织，保证租户边界确定。
  test("uses the injected organization context instead of a conflicting request organization", async () => {
    setTestOrgContext({ organizationId: "org-a", userId: "user-a", role: "member" });

    const context = await loadOrgContext(
      { id: "user-a" },
      new Request("http://localhost/?activeOrganizationId=org-b", { headers: { "x-active-org-id": "org-c" } }),
    );

    expect(context).toEqual({ organizationId: "org-a", userId: "user-a", role: "member" });
  });

  // 不同租户的注入上下文不能复用上一次调用的组织信息。
  test("switches injected organization contexts between tenants", async () => {
    setTestOrgContext({ organizationId: "org-a", userId: "user-a", role: "owner" });
    const first = await loadOrgContext({ id: "user-a" }, new Request("http://localhost/"));
    setTestOrgContext({ organizationId: "org-b", userId: "user-b", role: "admin" });
    const second = await loadOrgContext({ id: "user-b" }, new Request("http://localhost/"));

    expect(first?.organizationId).toBe("org-a");
    expect(second?.organizationId).toBe("org-b");
    expect(second?.userId).toBe("user-b");
  });

  // 注入上下文允许缺省组织名，前端展示层应保留空值而非伪造名称。
  test("preserves a null organization name in injected context", async () => {
    setTestOrgContext({ organizationId: "org-a", organizationName: undefined, userId: "user-a", role: "member" });

    const context = await loadOrgContext({ id: "user-a" }, new Request("http://localhost/"));

    expect(context?.organizationName).toBeUndefined();
  });

  // 机器离线 AppError 必须进入不可重连的离线分支。
  test("classifies MACHINE_OFFLINE AppError as a machine offline failure", () => {
    expect(isMachineOfflineError(new AppError("offline", "MACHINE_OFFLINE"))).toBe(true);
  });

  // 无关应用错误不能被误判为机器离线，避免错误关闭客户端连接。
  test("does not classify unrelated AppError as a machine offline failure", () => {
    expect(isMachineOfflineError(new AppError("forbidden", "FORBIDDEN", 403))).toBe(false);
  });

  // 非 Error 输入必须安全返回 false，错误处理链不能再次抛错。
  test("handles null offline error input safely", () => {
    expect(isMachineOfflineError(null)).toBe(false);
  });

  // 禁用自动启动属于确定性配置失败，应停止自动重连。
  test("classifies disabled auto-start as a permanent spawn failure", () => {
    expect(classifyPermanentSpawnFailure(new AppError("disabled", "AUTO_START_DISABLED"))).toBe("auto_start_disabled");
  });

  // 会话配额耗尽属于确定性失败，应把稳定诊断码返回给客户端。
  test("classifies exhausted sessions as a permanent spawn failure", () => {
    expect(classifyPermanentSpawnFailure(new AppError("full", "MAX_SESSIONS_REACHED"))).toBe("max_sessions_reached");
  });

  // 权限拒绝不是 spawn 配置失败，客户端仍应遵循其既有错误处理路径。
  test("does not classify forbidden access as a permanent spawn failure", () => {
    expect(classifyPermanentSpawnFailure(new AppError("forbidden", "FORBIDDEN", 403))).toBeNull();
  });

  // 未知异常可能是瞬时故障，不能错误禁止重连。
  test("does not classify unknown errors as permanent spawn failures", () => {
    expect(classifyPermanentSpawnFailure(new Error("temporary failure"))).toBeNull();
  });

  // JSON-RPC 消息始终代表真实业务交互，应更新活动时间。
  test("counts JSON-RPC messages as instance activity", () => {
    expect(shouldCountInstanceActivity({ jsonrpc: "2.0", type: "ping" })).toBe(true);
  });

  // 保活消息不能阻止后台实例因长期无业务活动而回收。
  test("ignores keep-alive messages for instance activity", () => {
    expect(shouldCountInstanceActivity({ type: "keep_alive" })).toBe(false);
  });

  // 心跳消息不能被计为业务活动。
  test("ignores heartbeat messages for instance activity", () => {
    expect(shouldCountInstanceActivity({ type: "heartbeat" })).toBe(false);
  });

  // ping/pong 协议消息不能延长实例生命周期。
  test("ignores ping and pong messages for instance activity", () => {
    expect(shouldCountInstanceActivity({ type: "ping" })).toBe(false);
    expect(shouldCountInstanceActivity({ type: "pong" })).toBe(false);
  });

  // 未标记为保活的消息应保守地计入业务活动。
  test("counts untyped messages as instance activity", () => {
    expect(shouldCountInstanceActivity({})).toBe(true);
  });

  // 每个会话拥有独立事件流，分页读取不得泄漏其他租户的数据。
  test("isolates paginated event reads between session buses", () => {
    const tenantABus = getEventBus("tenant-a-session");
    const tenantBBus = getEventBus("tenant-b-session");
    tenantABus.publish({ id: "a-1", sessionId: "tenant-a-session", type: "user", payload: {}, direction: "outbound" });
    tenantBBus.publish({ id: "b-1", sessionId: "tenant-b-session", type: "user", payload: {}, direction: "outbound" });

    expect(tenantABus.getEventsSince(0).map((event) => event.id)).toEqual(["a-1"]);
    expect(tenantBBus.getEventsSince(0).map((event) => event.id)).toEqual(["b-1"]);
  });

  // 分页游标等于最新序号时应返回空页。
  test("returns an empty page when the cursor equals the latest sequence", () => {
    const bus = new EventBus();
    bus.publish({ id: "event-1", sessionId: "session-1", type: "user", payload: null, direction: "outbound" });

    expect(bus.getEventsSince(bus.getLastSeqNum())).toEqual([]);
  });

  // 删除会话总线必须关闭旧资源，旧引用不能继续发布事件。
  test("releases and closes a removed session event bus", () => {
    const bus = getEventBus("release-session");
    removeEventBus("release-session");

    expect(getAllEventBuses().has("release-session")).toBe(false);
    expect(() =>
      bus.publish({ id: "late", sessionId: "release-session", type: "user", payload: {}, direction: "outbound" }),
    ).toThrow("EventBus is closed");
  });

  // 移除一个会话总线不得释放同租户的其他会话资源。
  test("releases only the requested session event bus", () => {
    const first = getEventBus("tenant-a-session-1");
    const second = getEventBus("tenant-a-session-2");
    removeEventBus("tenant-a-session-1");

    expect(() =>
      first.publish({
        id: "closed",
        sessionId: "tenant-a-session-1",
        type: "user",
        payload: {},
        direction: "outbound",
      }),
    ).toThrow();
    expect(() =>
      second.publish({ id: "open", sessionId: "tenant-a-session-2", type: "user", payload: {}, direction: "outbound" }),
    ).not.toThrow();
  });
});
