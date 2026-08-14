import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EngineRelayHandle } from "@fenix/plugin-sdk";
import type { AuthContext } from "../plugins/auth";
import type { SpawnedInstance } from "../services/instance";
import {
  type ExternalRelayEnvironment,
  handleExternalRelayClose,
  handleExternalRelayMessage,
  handleExternalRelayOpen,
  setExternalRelayDeps,
} from "../transport/relay/external-relay";
import type { WsConnection } from "../transport/ws-types";

interface MockWs extends WsConnection {
  messages: string[];
  closed: Array<[number | undefined, string | undefined]>;
}

/** 假 WS：记录 send 内容与 close 参数，readyState 恒为 OPEN */
function createWs(): MockWs {
  return {
    readyState: 1,
    messages: [],
    closed: [],
    send(message) {
      this.messages.push(message);
    },
    close(code, reason) {
      this.closed.push([code, reason]);
    },
  };
}

interface MockRelayHandle {
  handle: EngineRelayHandle;
  /** unknown[]：EngineRelayMessage 与 JSON-RPC 对象均可入列，断言时任意结构比对 */
  sent: unknown[];
  unsubCalls: number;
  listeners: Array<(message: { type: string; payload?: unknown }) => void>;
}

/** 假 relay handle：记录 send、收集 onMessage listener、统计 unsub 调用 */
function createRelayHandle(): MockRelayHandle {
  const mock: MockRelayHandle = {
    handle: { state: "open", send: () => undefined, close: () => undefined },
    sent: [],
    unsubCalls: 0,
    listeners: [],
  };
  mock.handle = {
    state: "open",
    send: (message) => {
      mock.sent.push(message);
    },
    onMessage: (listener) => {
      mock.listeners.push(listener);
      return () => {
        mock.unsubCalls += 1;
      };
    },
    close: () => undefined,
  };
  return mock;
}

/** 构造 handler 依赖的最小 environment 视图 */
function makeEnv(overrides: Partial<ExternalRelayEnvironment> = {}): ExternalRelayEnvironment {
  return { id: "env-1", organizationId: "org-1", userId: "user-1", ...overrides };
}

/** 构造完整 SpawnedInstance（handler 只读 .id，其余字段保证类型完整） */
function makeInstance(id: string): SpawnedInstance {
  return {
    id,
    userId: "user-1",
    port: 0,
    pid: null,
    status: "running",
    command: "",
    error: null,
    apiKey: "",
    createdAt: new Date(),
    environmentId: "env-1",
    instanceNumber: 1,
  };
}

const authCtx: AuthContext = { organizationId: "org-1", userId: "user-1", role: "owner" };

/** 记录 deps 调用轨迹，供各用例断言 */
const calls = {
  connected: [] as string[],
  attached: [] as string[],
  detached: [] as string[],
  touched: [] as Array<{ instanceId: string; type: string | undefined }>,
};

/**
 * 安装测试依赖。setExternalRelayDeps 以 defaultDeps 为基底合并 partial，
 * 因此每次安装必须重新带上全部记录实现（否则上一次注入会被 defaultDeps 冲掉）。
 */
function installTestDeps(overrides: Partial<Parameters<typeof setExternalRelayDeps>[0]> = {}): void {
  setExternalRelayDeps({
    getEnvironmentById: async () => undefined,
    getRunningInstancesByEnvironment: () => [],
    connectAgentRelay: async (instanceId) => {
      calls.connected.push(instanceId);
      return createRelayHandle().handle;
    },
    markRelayAttached: (instanceId) => calls.attached.push(instanceId),
    markRelayDetached: (instanceId) => calls.detached.push(instanceId),
    touchActivity: (instanceId, message) =>
      calls.touched.push({
        instanceId,
        type: typeof message.type === "string" ? message.type : undefined,
      }),
    ...overrides,
  });
}

describe("ExternalRelay", () => {
  beforeEach(() => {
    calls.connected = [];
    calls.attached = [];
    calls.detached = [];
    calls.touched = [];
    installTestDeps();
  });

  afterEach(() => {
    setExternalRelayDeps(null);
  });

  // 归属用户打开连接成功：连接指定实例、attach relay（阻止 idle 回收）、未收到 status 时补发 connect
  test("归属用户打开连接成功：连接指定实例并补发 connect", async () => {
    const relay = createRelayHandle();
    installTestDeps({
      getEnvironmentById: async () => makeEnv(),
      getRunningInstancesByEnvironment: () => [makeInstance("inst-1")],
      connectAgentRelay: async (instanceId) => {
        calls.connected.push(instanceId);
        return relay.handle;
      },
    });
    const ws = createWs();

    await handleExternalRelayOpen(ws, "ws-1", "env-1", authCtx);

    expect(calls.connected).toEqual(["inst-1"]);
    expect(calls.attached).toEqual(["inst-1"]);
    // 未收到 status → 补发一次 connect 触发 agent 回传 capabilities
    expect(relay.sent).toEqual([{ type: "connect" }]);
  });

  // env 不存在时以通用 reason 关闭 4004，不向客户端泄露任何内部标识
  test("env 不存在时关闭 4004 且不泄露内部标识", async () => {
    const ws = createWs();

    await handleExternalRelayOpen(ws, "ws-1", "env-missing", authCtx);

    expect(ws.closed).toEqual([[4004, "environment not found"]]);
    expect(ws.messages).toEqual([]);
    expect(calls.connected).toEqual([]);
  });

  // 多租户隔离：env 属于其他组织且非本人所有时拒绝连接
  test("env 跨组织且非本人时关闭 4003", async () => {
    installTestDeps({
      getEnvironmentById: async () => makeEnv({ organizationId: "org-2", userId: "user-2" }),
      getRunningInstancesByEnvironment: () => [makeInstance("inst-1")],
    });
    const ws = createWs();

    await handleExternalRelayOpen(ws, "ws-1", "env-1", authCtx);

    expect(ws.closed).toEqual([[4003, "unauthorized"]]);
    expect(calls.connected).toEqual([]);
  });

  // 多实例歧义：query 携带 instanceId 时精确连接指定实例，而非第一个 running 实例
  test("query 携带 instanceId 时精确连接指定实例", async () => {
    installTestDeps({
      getEnvironmentById: async () => makeEnv(),
      getRunningInstancesByEnvironment: () => [makeInstance("inst-1"), makeInstance("inst-2")],
    });
    const ws = createWs();

    await handleExternalRelayOpen(ws, "ws-1", "env-1", authCtx, "inst-2");

    expect(calls.connected).toEqual(["inst-2"]);
    expect(ws.closed).toEqual([]);
  });

  // query 携带的 instanceId 不属于该 env 的任何 running 实例时拒绝，防止跨实例/跨租户连接
  test("query instanceId 不匹配任何 running 实例时关闭 4004", async () => {
    installTestDeps({
      getEnvironmentById: async () => makeEnv(),
      getRunningInstancesByEnvironment: () => [makeInstance("inst-1")],
    });
    const ws = createWs();

    await handleExternalRelayOpen(ws, "ws-1", "env-1", authCtx, "inst-404");

    expect(ws.closed).toEqual([[4004, "no running instance"]]);
    expect(calls.connected).toEqual([]);
  });

  // 薄转发端点不 spawn：无 running 实例时直接关闭，绝不调用启动路径
  test("无 running 实例时关闭 4004 且不 spawn", async () => {
    installTestDeps({ getEnvironmentById: async () => makeEnv() });
    const ws = createWs();

    await handleExternalRelayOpen(ws, "ws-1", "env-1", authCtx);

    expect(ws.closed).toEqual([[4004, "no running instance"]]);
    expect(calls.connected).toEqual([]);
    expect(calls.attached).toEqual([]);
  });

  // 错误脱敏：relay 连接失败时 reason 为通用文案，不携带错误原文（可能含 machineId）
  test("connectAgentRelay 抛错时关闭 1011 且 reason 脱敏", async () => {
    installTestDeps({
      getEnvironmentById: async () => makeEnv(),
      getRunningInstancesByEnvironment: () => [makeInstance("inst-1")],
      connectAgentRelay: async () => {
        throw new Error("Core node is offline: machine-42");
      },
    });
    const ws = createWs();

    await handleExternalRelayOpen(ws, "ws-1", "env-1", authCtx);

    expect(ws.closed).toEqual([[1011, "relay connect failed"]]);
    expect(JSON.stringify(ws.closed)).not.toContain("machine-42");
    expect(calls.attached).toEqual([]);
  });

  // 握手竞态：open 异步期间到达的客户端消息先缓存，flush 时跳过 connect 后原样回放
  test("open 异步期间客户端消息被缓存并在 flush 后转发", async () => {
    let resolveConnect!: (handle: EngineRelayHandle) => void;
    const connectPromise = new Promise<EngineRelayHandle>((resolve) => {
      resolveConnect = resolve;
    });
    const relay = createRelayHandle();
    installTestDeps({
      getEnvironmentById: async () => makeEnv(),
      getRunningInstancesByEnvironment: () => [makeInstance("inst-1")],
      connectAgentRelay: async () => connectPromise,
    });
    const ws = createWs();
    const openPromise = handleExternalRelayOpen(ws, "ws-1", "env-1", authCtx);

    // connect 未 resolve 前（open 进行中）到达的消息：connect 与 session/prompt 均应被缓存
    handleExternalRelayMessage(ws, "ws-1", JSON.stringify({ type: "connect" }));
    handleExternalRelayMessage(
      ws,
      "ws-1",
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { prompt: "hi" } }),
    );
    resolveConnect(relay.handle);
    await openPromise;

    // 缓存的 connect 被丢弃（core 已自动发送），session/prompt 原样回放，另补发唯一一次 connect
    expect(relay.sent).toEqual([
      { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { prompt: "hi" } },
      { type: "connect" },
    ]);
  });

  // connect 去重：open 完成后客户端再发 connect 一律丢弃，agent 不会收到重复 connect
  test("客户端 connect 消息被丢弃，不转发给 agent", async () => {
    const relay = createRelayHandle();
    installTestDeps({
      getEnvironmentById: async () => makeEnv(),
      getRunningInstancesByEnvironment: () => [makeInstance("inst-1")],
      connectAgentRelay: async () => relay.handle,
    });
    const ws = createWs();

    await handleExternalRelayOpen(ws, "ws-1", "env-1", authCtx);
    handleExternalRelayMessage(ws, "ws-1", { type: "connect" });

    // agent 只收到补发的唯一一次 connect
    expect(relay.sent).toEqual([{ type: "connect" }]);
  });

  // acp-link 心跳兼容：客户端 ping 直接回 pong，不进入转发路径
  test("客户端 ping 直接回 pong", async () => {
    const relay = createRelayHandle();
    installTestDeps({
      getEnvironmentById: async () => makeEnv(),
      getRunningInstancesByEnvironment: () => [makeInstance("inst-1")],
      connectAgentRelay: async () => relay.handle,
    });
    const ws = createWs();

    await handleExternalRelayOpen(ws, "ws-1", "env-1", authCtx);
    relay.sent.length = 0; // 清空补发 connect，聚焦 ping 断言
    handleExternalRelayMessage(ws, "ws-1", { type: "ping" });

    expect(ws.messages).toEqual([JSON.stringify({ type: "pong" })]);
    expect(relay.sent).toEqual([]);
  });

  // 薄转发边界：JSON-RPC 消息原样透传，不加工协议、不注入 cwd
  test("客户端 JSON-RPC 消息原样转发到 agent", async () => {
    const relay = createRelayHandle();
    installTestDeps({
      getEnvironmentById: async () => makeEnv(),
      getRunningInstancesByEnvironment: () => [makeInstance("inst-1")],
      connectAgentRelay: async () => relay.handle,
    });
    const ws = createWs();

    await handleExternalRelayOpen(ws, "ws-1", "env-1", authCtx);
    relay.sent.length = 0;
    const rpc = { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { prompt: "hi" } };
    handleExternalRelayMessage(ws, "ws-1", rpc);

    expect(relay.sent).toEqual([rpc]);
    // JSON-RPC 消息计入实例活跃度，防止连接期间被 activity 硬超时误回收
    expect(calls.touched).toEqual([{ instanceId: "inst-1", type: undefined }]);
  });

  // status 竞态：relay 建立后 agent 立即回传 status 时原样转发，且不再补发 connect
  test("收到 agent status 后原样转发且不再补发 connect", async () => {
    const relay = createRelayHandle();
    // onMessage 注册时立即推送 status，模拟「relay 建立后 agent 立刻回 capabilities」的竞态
    relay.handle.onMessage = (listener) => {
      listener({ type: "status", payload: { connected: true, capabilities: ["session/list"] } });
      relay.listeners.push(listener);
      return () => {
        relay.unsubCalls += 1;
      };
    };
    installTestDeps({
      getEnvironmentById: async () => makeEnv(),
      getRunningInstancesByEnvironment: () => [makeInstance("inst-1")],
      connectAgentRelay: async () => relay.handle,
    });
    const ws = createWs();

    await handleExternalRelayOpen(ws, "ws-1", "env-1", authCtx);

    expect(ws.messages).toEqual([
      JSON.stringify({ type: "status", payload: { connected: true, capabilities: ["session/list"] } }),
    ]);
    expect(relay.sent).toEqual([]); // 已收到 status，不补发 connect
  });

  // agent 侧连接丢失：先发通用 error 事件，再以 1011 关闭客户端连接
  test("agent relay_closed 时发送 error 并关闭 1011", async () => {
    const relay = createRelayHandle();
    installTestDeps({
      getEnvironmentById: async () => makeEnv(),
      getRunningInstancesByEnvironment: () => [makeInstance("inst-1")],
      connectAgentRelay: async () => relay.handle,
    });
    const ws = createWs();

    await handleExternalRelayOpen(ws, "ws-1", "env-1", authCtx);
    relay.listeners[0]({ type: "relay_closed" });

    expect(ws.messages).toEqual([JSON.stringify({ type: "error", payload: { message: "Agent connection lost" } })]);
    expect(ws.closed).toEqual([[1011, "agent connection lost"]]);
  });

  // 资源清理：客户端断开时注销 onMessage（防 listener 泄漏）并递减 relayCount；重复 close 幂等
  test("客户端断开时注销 onMessage 并递减 relayCount，重复 close 幂等", async () => {
    const relay = createRelayHandle();
    installTestDeps({
      getEnvironmentById: async () => makeEnv(),
      getRunningInstancesByEnvironment: () => [makeInstance("inst-1")],
      connectAgentRelay: async () => relay.handle,
    });
    const ws = createWs();

    await handleExternalRelayOpen(ws, "ws-1", "env-1", authCtx);
    handleExternalRelayClose(ws, "ws-1");

    expect(relay.unsubCalls).toBe(1);
    expect(calls.detached).toEqual(["inst-1"]);
    // 重复 close 幂等：不再重复注销/递减
    handleExternalRelayClose(ws, "ws-1");
    expect(relay.unsubCalls).toBe(1);
    expect(calls.detached).toEqual(["inst-1"]);
  });
});
