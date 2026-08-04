// packages/chat-channel/src/channel/gateway-open.test.ts
// Gateway.handleOpen 主流程测试（C6 迁移自 src/__tests__/yjs-frontend-lifecycle.test.ts）：
// keepalive 心跳与 4501 终态、spawn 错误分类（4500/4502/1011）、环境解析与纵深授权、
// 坏 sessionId 降级、缓冲与容量配额。共享 relay / 握手时序见 gateway-shared-relay.test.ts。

import { afterEach, describe, expect, test } from "bun:test";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import {
  codedError,
  createGateway,
  createRelayEvents,
  createSpawnClassifier,
  createWs,
} from "./connection-test-helpers";

type ScheduledInterval = {
  callback: () => void;
  cleared: boolean;
  delay: number | undefined;
};

const originalSetInterval = Object.getOwnPropertyDescriptor(globalThis, "setInterval");
const originalClearInterval = Object.getOwnPropertyDescriptor(globalThis, "clearInterval");
const originalDateNow = Object.getOwnPropertyDescriptor(Date, "now");
let intervals: ScheduledInterval[] = [];

function installIntervalFakes(now: () => number): void {
  intervals = [];
  Object.defineProperty(globalThis, "setInterval", {
    configurable: true,
    value: (callback: () => void, delay?: number) => {
      const interval = { callback, cleared: false, delay };
      intervals.push(interval);
      return interval;
    },
  });
  Object.defineProperty(globalThis, "clearInterval", {
    configurable: true,
    value: (interval: ScheduledInterval) => {
      interval.cleared = true;
    },
  });
  Object.defineProperty(Date, "now", { configurable: true, value: now });
}

function restoreProperty(target: object, name: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(target, name, descriptor);
  } else {
    Reflect.deleteProperty(target, name);
  }
}

describe("Gateway handleOpen", () => {
  afterEach(() => {
    restoreProperty(globalThis, "setInterval", originalSetInterval);
    restoreProperty(globalThis, "clearInterval", originalClearInterval);
    restoreProperty(Date, "now", originalDateNow);
  });

  // 客户端 keep_alive 会续期，页面可见期间不会因连接建立时间到期而关闭。
  test("renews the YJS WS keepalive timeout after a client keep_alive", async () => {
    let now = 1_000_000;
    installIntervalFakes(() => now);
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const lifecycle = createGateway(registry, broadcaster, relayEvents);
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");
    const keepalive = intervals.find((interval) => interval.delay === 30_000);

    now = 1_050_000;
    await lifecycle.handleMessage(ws, "ws-1", JSON.stringify({ type: "keep_alive" }));
    now = 1_100_000;
    keepalive?.callback();

    expect(ws.closed).toEqual([]);

    now = 1_110_001;
    keepalive?.callback();

    expect(ws.closed).toEqual([[4501, "client keepalive timeout"]]);
  });

  // 新连接从客户端登记时刻开始计时：首个 30 秒周期仍保活，连续 60 秒未收到客户端
  // keep_alive 才以 4501 终态关闭（客户端停止自动重连，回到可见时手动重连）。
  test("closes the YJS WS only after the client keepalive timeout elapses from registration", async () => {
    let now = 1_000_000;
    installIntervalFakes(() => now);
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const lifecycle = createGateway(registry, broadcaster, relayEvents);
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");
    const keepalive = intervals.find((interval) => interval.delay === 30_000);
    expect(keepalive).toBeDefined();

    now = 1_030_000;
    keepalive?.callback();

    expect(ws.closed).toEqual([]);
    expect(ws.messages.map((message) => JSON.parse(message))).toContainEqual({ type: "keep_alive" });

    now = 1_060_000;
    keepalive?.callback();

    expect(ws.closed).toEqual([[4501, "client keepalive timeout"]]);
    expect(
      ws.messages.map((message) => JSON.parse(message)).filter((message) => message.type === "keep_alive"),
    ).toHaveLength(1);
  });

  // 兼容形态：抛 MACHINE_OFFLINE 码错误（历史/外部调用方形态）仍走 4500 终态，
  // 错误详情（message 含敏感诊断）只进服务端日志，客户端帧恒为脱敏文案。
  test("reports MACHINE_OFFLINE connection failures with a safe client error", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const errors: unknown[] = [];
    const thrown = codedError("MACHINE_OFFLINE", "machine secret diagnostic");
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      ensureRunning: async () => {
        throw thrown;
      },
      reportError: (_message, error) => errors.push(error),
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");

    expect(errors).toEqual([thrown]);
    expect(JSON.parse(ws.messages[0] ?? "{}")).toEqual({
      type: "error",
      payload: { code: "machine_unavailable", message: "Agent connection error" },
    });
    expect(ws.closed).toEqual([[4500, "machine offline"]]);
  });

  // 真实形态一：ensureNode 抛 AGENT_NODE_UNAVAILABLE（节点未注册/已回收/未 connected），
  // 等价机器不可达 → 4500 终态；message 中的 machineId 与状态详情不得泄漏给客户端。
  test("closes 4500 and masks details when ensureNode throws AGENT_NODE_UNAVAILABLE", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const errors: unknown[] = [];
    const thrown = codedError("AGENT_NODE_UNAVAILABLE", "Agent node for machine mach_x is unavailable");
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      ensureRunning: async () => {
        throw thrown;
      },
      reportError: (_message, error) => errors.push(error),
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");

    expect(errors).toEqual([thrown]);
    expect(JSON.parse(ws.messages[0] ?? "{}")).toEqual({
      type: "error",
      payload: { code: "machine_unavailable", message: "Agent connection error" },
    });
    expect(ws.closed).toEqual([[4500, "machine offline"]]);
    // 客户端帧不得出现 machineId 与原始诊断文案（machine_unavailable 为合法脱敏错误码，不在此列）
    expect(ws.messages.join("")).not.toContain("mach_x");
  });

  // 真实形态二：core launch 竞态窗口抛 NODE_OFFLINE（ensureNode 放行后机器断连）→
  // 同样 4500 终态且不泄漏 nodeId。
  test("closes 4500 when core launch fails with NODE_OFFLINE in the disconnect race window", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const errors: unknown[] = [];
    const thrown = codedError("NODE_OFFLINE", "Core node is offline: mach_x");
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      ensureRunning: async () => {
        throw thrown;
      },
      reportError: (_message, error) => errors.push(error),
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");

    expect(errors).toEqual([thrown]);
    expect(JSON.parse(ws.messages[0] ?? "{}")).toEqual({
      type: "error",
      payload: { code: "machine_unavailable", message: "Agent connection error" },
    });
    expect(ws.closed).toEqual([[4500, "machine offline"]]);
    expect(ws.messages.join("")).not.toContain("mach_x");
  });

  // 负例：瞬时/未知的 spawn 失败（INSTANCE_NOT_VISIBLE 防御分支、普通 Error）必须仍走
  // 1011 通用分支，钉住判定边界，防止错误分类面过度扩大把非永久失败变成终态。
  test("keeps 1011 generic branch for non-permanent spawn failures", async () => {
    for (const thrown of [
      codedError("INSTANCE_NOT_VISIBLE", "Instance 'i-1' spawned but missing from runtime registry"),
      new Error("boom"),
    ]) {
      const registry = new ConnectionRegistry();
      const broadcaster = new YjsBroadcaster(registry);
      const relayEvents = createRelayEvents(registry, broadcaster, []);
      const lifecycle = createGateway(registry, broadcaster, relayEvents, {
        ensureRunning: async () => {
          throw thrown;
        },
      });
      const ws = createWs();

      await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");

      expect(JSON.parse(ws.messages[0] ?? "{}")).toEqual({
        type: "error",
        payload: { message: "Agent connection error" },
      });
      expect(ws.closed).toEqual([[1011, "spawn failed"]]);
    }
  });

  // autoStart 关闭是配置态，重连不会改变配置：必须 close 4502 进入终态停止自动重连，
  // 错误帧携带 auto_start_disabled 诊断码，message 保持脱敏（实例编号只进服务端日志）。
  test("closes 4502 with auto_start_disabled when ensureRunning throws AUTO_START_DISABLED", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const errors: unknown[] = [];
    const thrown = codedError("AUTO_START_DISABLED", "实例 2 未运行且 autoStart 已禁用");
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      ensureRunning: async () => {
        throw thrown;
      },
      reportError: (_message, error) => errors.push(error),
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");

    expect(errors).toEqual([thrown]);
    expect(JSON.parse(ws.messages[0] ?? "{}")).toEqual({
      type: "error",
      payload: { code: "auto_start_disabled", message: "Agent connection error" },
    });
    expect(ws.closed).toEqual([[4502, "spawn rejected"]]);
    // 客户端帧不得泄漏实例编号与原始诊断文案
    expect(ws.messages.join("")).not.toContain("autoStart");
    expect(ws.messages.join("")).not.toContain("2");
  });

  // maxSessions 上限是配置态，重连不会释放实例：同样 close 4502 终态并携带诊断码。
  test("closes 4502 with max_sessions_reached when ensureRunning throws MAX_SESSIONS_REACHED", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const errors: unknown[] = [];
    const thrown = codedError("MAX_SESSIONS_REACHED", "已达到最大实例数 3");
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      ensureRunning: async () => {
        throw thrown;
      },
      reportError: (_message, error) => errors.push(error),
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");

    expect(errors).toEqual([thrown]);
    expect(JSON.parse(ws.messages[0] ?? "{}")).toEqual({
      type: "error",
      payload: { code: "max_sessions_reached", message: "Agent connection error" },
    });
    expect(ws.closed).toEqual([[4502, "spawn rejected"]]);
  });

  // launch spec 构建条件是配置态（如 RCS_DISABLE_LOCAL_EXECUTION 且无远程机器），
  // 每次 spawn 必然失败：编排域 LaunchSpecBuildError 同样坍缩为 4502 终态。
  test("closes 4502 with launch_spec_build_failed on LAUNCH_SPEC_BUILD_FAILED", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const errors: unknown[] = [];
    const thrown = codedError(
      "LAUNCH_SPEC_BUILD_FAILED",
      "Cannot spawn instance: environment 'env-1' has no machineId",
    );
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      ensureRunning: async () => {
        throw thrown;
      },
      reportError: (_message, error) => errors.push(error),
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");

    expect(errors).toEqual([thrown]);
    expect(JSON.parse(ws.messages[0] ?? "{}")).toEqual({
      type: "error",
      payload: { code: "launch_spec_build_failed", message: "Agent connection error" },
    });
    expect(ws.closed).toEqual([[4502, "spawn rejected"]]);
    // 客户端帧不得泄漏 envId 与原始诊断文案
    expect(ws.messages.join("")).not.toContain("env-1");
    expect(ws.messages.join("")).not.toContain("machineId");
  });

  // 坏 sessionId（历史 session_* 书签、ACP ses_* 混入、实例回收后编号失效）应降级为默认实例继续连接，
  // 连接建立后由 ACP 层重建会话；不得以 4004 拒绝连接（4004 不在客户端终态码集合，会触发相同 URL 无限重连）。
  test("degrades to the default instance when the sessionId cannot be resolved", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const seen: Array<number | undefined> = [];
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      resolveInstanceNumberFromSession: async () => {
        throw new Error("Invalid instance session id");
      },
      ensureRunning: async (_userId, _agentId, _mode, instanceNumber) => {
        seen.push(instanceNumber);
        return { instance: { id: "instance-1" } };
      },
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1", "ses_inst_env_9");

    expect(ws.closed).toEqual([]);
    expect(seen).toEqual([undefined]);
    expect(registry.getClient("ws-1")).toBeDefined();
  });

  // 环境不存在是不可恢复的引用失效：必须保持 4004 终态关闭（配合客户端 NO_RECONNECT_CODES 停止自动重连）。
  test("keeps closing 4004 when the environment no longer exists", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      getEnvironment: async () => undefined,
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");

    expect(ws.closed).toEqual([[4004, "env not found"]]);
  });

  // 环境查询拒绝时必须安全释放 pending 容量、记录固定元数据并关闭连接。
  test("rejects environment lookup failures without leaking pending capacity", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const reports: Array<[string, unknown]> = [];
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      getEnvironment: async () => {
        throw new Error("environment secret");
      },
      reportError: (message, error) => reports.push([message, error]),
      maxClients: () => 1,
    });
    const firstWs = createWs();
    const secondWs = createWs();

    await lifecycle.handleOpen(firstWs, "ws-1", "user-1", "agent-1", null);
    await lifecycle.handleOpen(secondWs, "ws-2", "user-1", "agent-1", null);

    expect(JSON.parse(firstWs.messages[0] ?? "{}")).toEqual({
      type: "error",
      payload: { message: "Agent connection error" },
    });
    expect(firstWs.closed).toEqual([[1011, "environment lookup failed"]]);
    expect(secondWs.closed).toEqual([[1011, "environment lookup failed"]]);
    expect(reports).toEqual([
      ["[YJS-FE] Failed to load environment", { agentId: "agent-1" }],
      ["[YJS-FE] Failed to load environment", { agentId: "agent-1" }],
    ]);
  });

  // 组织环境的成员资格由路由 authContext 验证；gateway 注入的纵深 authorizer 不能按个人 owner 拒绝它。
  test("allows an organization environment owned by another user through the injected authorizer", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    let ensureCalls = 0;
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      getEnvironment: async () => ({ organizationId: "org-1", userId: "other-user" }),
      authorizeEnvironment: (userId, environment) =>
        environment.organizationId !== null && environment.organizationId !== undefined
          ? true
          : !environment.userId || environment.userId === userId,
      ensureRunning: async () => {
        ensureCalls += 1;
        return { instance: { id: "instance-1" } };
      },
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", null);

    expect(ensureCalls).toBe(1);
    lifecycle.handleClose("ws-1");
  });

  // 个人环境的所有者不同时，gateway 的纵深校验必须在启动实例和连接 relay 前拒绝。
  test("rejects a personal environment owned by another user before starting an agent", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    let ensureCalls = 0;
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      getEnvironment: async () => ({ userId: "other-user" }),
      authorizeEnvironment: (userId, environment) =>
        environment.organizationId !== null && environment.organizationId !== undefined
          ? true
          : !environment.userId || environment.userId === userId,
      ensureRunning: async () => {
        ensureCalls += 1;
        return { instance: { id: "instance-1" } };
      },
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", null);

    expect(ensureCalls).toBe(0);
    expect(JSON.parse(ws.messages[0] ?? "{}")).toEqual({
      type: "error",
      payload: { message: "Environment not found" },
    });
    expect(ws.closed).toEqual([[4003, "unauthorized"]]);
  });

  // classifier 注入点：宿主返回 null（非机器离线非永久）时即使错误带 code 也走 1011，
  // 钉住"分类判定属于宿主语义、gateway 只消费分类结果"的边界。
  test("relies on the injected classifier result instead of inspecting error codes", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const classifier = createSpawnClassifier();
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      ensureRunning: async () => {
        throw codedError("MACHINE_OFFLINE", "machine secret");
      },
      // 宿主侧判定为瞬时失败（例如包装层未透传错误码）：gateway 必须走 1011 而非 4500
      isMachineOffline: () => false,
      classifyPermanentSpawnFailure: classifier.classifyPermanentSpawnFailure,
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");

    expect(ws.closed).toEqual([[1011, "spawn failed"]]);
  });
});
