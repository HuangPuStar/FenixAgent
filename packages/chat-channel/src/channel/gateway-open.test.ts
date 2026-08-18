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
  textFrames,
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

/** 解析连接收到的 JSON 文本帧（yjs:update 快照为二进制帧，SP-A4，须过滤后再 parse） */
function parseTextFrames(ws: ReturnType<typeof createWs>): Array<Record<string, unknown>> {
  return textFrames(ws).map((message) => JSON.parse(message) as Record<string, unknown>);
}

describe("Gateway handleOpen", () => {
  afterEach(() => {
    restoreProperty(globalThis, "setInterval", originalSetInterval);
    restoreProperty(globalThis, "clearInterval", originalClearInterval);
    restoreProperty(Date, "now", originalDateNow);
  });

  // 客户端暂停 keep_alive（如页面冻结）时，服务端仍持续发送心跳且不主动关闭 YJS WS。
  test("keeps the YJS WS open when the client stops sending keep_alive", async () => {
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

    now = 1_060_000;
    keepalive?.callback();
    now = 1_120_000;
    keepalive?.callback();

    expect(ws.closed).toEqual([]);
    expect(parseTextFrames(ws).filter((message) => message.type === "keep_alive")).toHaveLength(2);
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
    expect(parseTextFrames(ws)[0]).toEqual({
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
    expect(parseTextFrames(ws)[0]).toEqual({
      type: "error",
      payload: { code: "machine_unavailable", message: "Agent connection error" },
    });
    expect(ws.closed).toEqual([[4500, "machine offline"]]);
    // 客户端帧不得出现 machineId 与原始诊断文案（machine_unavailable 为合法脱敏错误码，不在此列）
    expect(textFrames(ws).join("")).not.toContain("mach_x");
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
    expect(parseTextFrames(ws)[0]).toEqual({
      type: "error",
      payload: { code: "machine_unavailable", message: "Agent connection error" },
    });
    expect(ws.closed).toEqual([[4500, "machine offline"]]);
    expect(textFrames(ws).join("")).not.toContain("mach_x");
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

      expect(parseTextFrames(ws)[0]).toEqual({
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
    expect(parseTextFrames(ws)[0]).toEqual({
      type: "error",
      payload: { code: "auto_start_disabled", message: "Agent connection error" },
    });
    expect(ws.closed).toEqual([[4502, "spawn rejected"]]);
    // 客户端帧不得泄漏实例编号与原始诊断文案
    expect(textFrames(ws).join("")).not.toContain("autoStart");
    expect(textFrames(ws).join("")).not.toContain("2");
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
    expect(parseTextFrames(ws)[0]).toEqual({
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
    expect(parseTextFrames(ws)[0]).toEqual({
      type: "error",
      payload: { code: "launch_spec_build_failed", message: "Agent connection error" },
    });
    expect(ws.closed).toEqual([[4502, "spawn rejected"]]);
    // 客户端帧不得泄漏 envId 与原始诊断文案
    expect(textFrames(ws).join("")).not.toContain("env-1");
    expect(textFrames(ws).join("")).not.toContain("machineId");
  });

  // 坏 sessionId（历史 session_* 书签、ACP ses_* 混入、实例回收后编号失效）应降级为默认实例继续连接，
  // 连接建立后由 ACP 层重建会话；不得以 4004 拒绝连接（4004 不在客户端终态码集合，会触发相同 URL 无限重连）。
  test("degrades to the default instance when the sessionId cannot be resolved", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const seen: Array<number | undefined> = [];
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      resolveInstanceNumberFromSession: async () => null,
      ensureRunning: async (_userId, _agentId, _mode, instanceNumber) => {
        seen.push(instanceNumber);
        return { instance: { id: "instance-1" } };
      },
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1", "session_legacy_uuid");

    expect(ws.closed).toEqual([]);
    expect(seen).toEqual([undefined]);
    expect(registry.getClient("ws-1")).toBeDefined();
  });

  // 会话标识解析遇到 DB 层异常（区别于格式不可解析的 null 降级）：保留错误诊断，
  // 仍按默认实例继续连接，避免一次解析失败拖垮整个建连路径。
  test("degrades to the default instance when session resolution throws unexpectedly", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const seen: Array<number | undefined> = [];
    const errors: unknown[] = [];
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      resolveInstanceNumberFromSession: async () => {
        throw new Error("db down");
      },
      reportError: (_message, error) => errors.push(error),
      ensureRunning: async (_userId, _agentId, _mode, instanceNumber) => {
        seen.push(instanceNumber);
        return { instance: { id: "instance-1" } };
      },
    });
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1", "ses_inst_env_9");

    expect(ws.closed).toEqual([]);
    expect(seen).toEqual([undefined]);
    expect(errors).toEqual([new Error("db down")]);
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

    expect(parseTextFrames(firstWs)[0]).toEqual({
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
    expect(parseTextFrames(ws)[0]).toEqual({
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

// 回放窗口开启：load/resume 会话的窗口必须在会话命令执行完成（含清空 Chat/Session
// Doc 与 RPC 发送）后开启，使 replaySkipSynthesis 以空 Doc 为基准捕获（在清空前开启
// 会缓存旧会话内容，回放增量被全部拒绝导致新会话内容空白）；Agent 回放流到达需要
// 网络往返，窗口必然先于回放流开启，result 分支幂等重置窗口（兜底）。
describe("Gateway replay window", () => {
  // load_session action 处理完成后开启回放窗口（此时会话 Doc 已清空）。
  test("load_session opens the replay window after the command (doc clearing) completes", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const lifecycle = createGateway(registry, broadcaster, relayEvents);
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");
    const shared = registry.getShared("instance-1", "user-1", "rcs-1");
    expect(shared?.replayWindowUntil).toBeNull();

    await lifecycle.handleMessage(
      ws,
      "ws-1",
      JSON.stringify({ action: "load_session", commandId: "cmd-1", sessionId: "ses-1" }),
    );

    expect(shared?.replayWindowUntil).not.toBeNull();
    expect(shared!.replayWindowUntil!).toBeGreaterThan(Date.now());
  });

  // resume_session 与 load_session 同样触发历史回放，窗口必须同步开启。
  test("resume_session opens the replay window after the command (doc clearing) completes", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const lifecycle = createGateway(registry, broadcaster, relayEvents);
    const ws = createWs();

    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");
    const shared = registry.getShared("instance-1", "user-1", "rcs-1");

    await lifecycle.handleMessage(
      ws,
      "ws-1",
      JSON.stringify({ action: "resume_session", commandId: "cmd-2", sessionId: "ses-2" }),
    );

    expect(shared?.replayWindowUntil).not.toBeNull();
  });
});

// 10s session/list 轮询的可观测性：send 失败必须 reportError、destroyed 必须跳过、
// 门禁未置位的跳过必须计数告警（R3 门禁卡死判定依赖 skip 计数）、relay 释放必须
// 清除 timer 与在途会话同步登记（防僵尸 timer 与登记残留）。
describe("Gateway session list polling", () => {
  // 轮询回调 send 抛错必须经 reportError 暴露（此前静默 catch 会让 sessions map
  // 长期缺失更新且不可观测），错误消息须带 rcsSessionId 便于定位。
  test("reports session list poll send failures with the rcs session id", async () => {
    const now = 1_000_000;
    installIntervalFakes(() => now);
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const reports: Array<[string, unknown]> = [];
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      reportError: (message, error) => reports.push([message, error]),
      connectAgentRelay: async () =>
        ({
          state: "open",
          // 只对 session/list 帧抛错：connect 握手帧（type: "connect"）必须正常发送
          send(message: Record<string, unknown>) {
            if (message.method === "session/list") throw new Error("relay handle dead");
          },
          close() {},
        }) as never,
    });
    const ws = createWs();
    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");
    // 门禁置位：模拟 agent status 已到达，轮询不再跳过
    registry.forEachByRcsSession("rcs-1", (entry) => {
      entry.agentStatusReceived = true;
    });

    intervals.find((interval) => interval.delay === 10_000)?.callback();

    expect(reports).toHaveLength(1);
    expect(reports[0]?.[0]).toContain("rcs-1");
  });

  // relay 已销毁时轮询回调必须跳过发送（closeReleasedRelay 置 destroyed 后，
  // 即使 timer 因竞态未被清除也不得向已死的 relay 发 RPC）。
  test("skips the session list poll when the relay is destroyed", async () => {
    const now = 1_000_000;
    installIntervalFakes(() => now);
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    let sends = 0;
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      connectAgentRelay: async () =>
        ({
          state: "open",
          // 只统计 session/list 帧（connect 握手帧 type: "connect" 不计入轮询发送）
          send(message: Record<string, unknown>) {
            if (message.method === "session/list") sends += 1;
          },
          close() {},
        }) as never,
    });
    const ws = createWs();
    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");
    registry.forEachByRcsSession("rcs-1", (entry) => {
      entry.agentStatusReceived = true;
    });
    const shared = registry.getShared("instance-1", "user-1", "rcs-1");
    expect(shared).toBeDefined();
    shared!.destroyed = true;

    intervals.find((interval) => interval.delay === 10_000)?.callback();

    expect(sends).toBe(0);
  });

  // 门禁未置位时轮询跳过必须可观测（R3：status 未到达导致轮询永久跳过时，
  // 静默 return 会让"轮询是否在跑"完全不可判定）：连续 3 次（30s）reportLog 一次，
  // 成功发送后清零重新计数（防刷屏）。
  test("logs after 3 consecutive skipped polls and resets the counter after a successful send", async () => {
    const now = 1_000_000;
    installIntervalFakes(() => now);
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const logs: string[] = [];
    let sends = 0;
    const lifecycle = createGateway(registry, broadcaster, relayEvents, {
      reportLog: (message) => logs.push(message),
      connectAgentRelay: async () =>
        ({
          state: "open",
          // 只统计 session/list 帧（connect 握手帧 type: "connect" 不计入轮询发送）
          send(message: Record<string, unknown>) {
            if (message.method === "session/list") sends += 1;
          },
          close() {},
        }) as never,
    });
    const ws = createWs();
    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");
    const poll = intervals.find((interval) => interval.delay === 10_000);

    // 门禁未置位：前两次跳过不告警，第三次告警，且不发送
    poll?.callback();
    poll?.callback();
    expect(logs).toHaveLength(0);
    poll?.callback();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("rcs-1");
    expect(sends).toBe(0);

    // status 到达：恢复发送；随后门禁再失效，计数清零后重新累计到 3 次再次告警
    registry.forEachByRcsSession("rcs-1", (entry) => {
      entry.agentStatusReceived = true;
    });
    poll?.callback();
    expect(sends).toBe(1);
    registry.forEachByRcsSession("rcs-1", (entry) => {
      entry.agentStatusReceived = false;
    });
    poll?.callback();
    poll?.callback();
    poll?.callback();
    expect(logs).toHaveLength(2);
  });

  // relay 引用计数归零（所有前端连接关闭）时 closeReleasedRelay 必须清除
  // sessionListTimer 与在途会话同步登记：僵尸 timer 会向已释放的 relay 发 RPC，
  // 残留登记会让未来的响应校验误判（relay 释放后登记已无消费方）。
  test("clears the session list timer and pending sync ids when the relay is released", async () => {
    const now = 1_000_000;
    installIntervalFakes(() => now);
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const relayEvents = createRelayEvents(registry, broadcaster, []);
    const lifecycle = createGateway(registry, broadcaster, relayEvents);
    const ws = createWs();
    await lifecycle.handleOpen(ws, "ws-1", "user-1", "agent-1", "rcs-1");
    const shared = registry.getShared("instance-1", "user-1", "rcs-1");
    expect(shared).toBeDefined();
    shared!.pendingSessionSyncIds = new Set([42]);

    await lifecycle.handleClose("ws-1");

    expect(intervals.find((interval) => interval.delay === 10_000)?.cleared).toBe(true);
    expect(shared!.pendingSessionSyncIds?.size).toBe(0);
  });
});
