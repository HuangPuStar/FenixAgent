import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RemoteTransport } from "@fenix/remote-runtime";
import { setConfig } from "../config";
import {
  resetAllStubs,
  stubCoreBootstrap,
  stubEnvironmentRepo,
  stubEnvironmentService,
  stubRegistry,
  stubRegistryHeartbeat,
} from "../test-utils/helpers";
import {
  closeAllAcpConnections,
  findMachineConnectionByAgentId,
  findMachineConnectionById,
  getAgentMachineCache,
  handleAcpWsClose,
  handleAcpWsMessage,
  handleAcpWsOpen,
  listAcpConnections,
  sendToAgentWs,
  sendToWs,
  setAgentMachineCache,
  triggerMachineCleanupByMachineId,
} from "../transport/acp-ws-handler";
import type { WsConnection } from "../transport/ws-types";
import type { AcpConnectionEntry } from "../types/store";

class FakeWs implements WsConnection {
  readyState = 1;
  sent: string[] = [];
  closed: Array<[number | undefined, string | undefined]> = [];
  throwOnSend = false;

  send(data: string | Uint8Array): void {
    if (this.throwOnSend) throw new Error("send failed");
    this.sent.push(typeof data === "string" ? data : new TextDecoder().decode(data));
  }

  close(code?: number, reason?: string): void {
    this.closed.push([code, reason]);
    this.readyState = 3;
  }
}

function frame(ws: FakeWs, index = 0): Record<string, unknown> {
  return JSON.parse(ws.sent[index] ?? "{}") as Record<string, unknown>;
}

async function flushRegistration(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

let registeredEntries: AcpConnectionEntry[];
let registeredMachines: Array<Record<string, unknown>>;
let disconnectedMachines: Array<[string, string | undefined]>;
let stoppedHeartbeats: string[];
let unregisteredMachines: string[];
let heartbeatMachines: string[];
let environmentPolls: string[];
let facadeInstances: Array<{ instanceId: string; nodeId?: string }>;

beforeEach(() => {
  resetAllStubs();
  closeAllAcpConnections();
  setConfig({ wsKeepaliveInterval: 30 });
  registeredEntries = [];
  registeredMachines = [];
  disconnectedMachines = [];
  stoppedHeartbeats = [];
  unregisteredMachines = [];
  heartbeatMachines = [];
  environmentPolls = [];
  facadeInstances = [];

  stubRegistry({
    registerMachine: async (input: Record<string, unknown>) => {
      registeredMachines.push(input);
      return { id: "machine-43", isNew: true };
    },
    disconnectMachine: async (machineId: string, reason?: string) => {
      disconnectedMachines.push([machineId, reason]);
    },
  });
  stubRegistryHeartbeat({
    handleHeartbeat: async (machineId: string) => {
      heartbeatMachines.push(machineId);
    },
    startHeartbeat: () => {},
    stopHeartbeat: (machineId: string) => {
      stoppedHeartbeats.push(machineId);
    },
  });
  stubEnvironmentService({
    touchEnvironmentPoll: async (environmentId: string) => {
      environmentPolls.push(environmentId);
    },
  });
  stubCoreBootstrap({
    getCoreRuntime: () => ({ listInstances: () => facadeInstances }),
    registerRemoteNode: (_machineId: string, _ws: WsConnection, entry: AcpConnectionEntry) => {
      registeredEntries.push(entry);
    },
    unregisterRemoteNode: (machineId: string) => {
      unregisteredMachines.push(machineId);
    },
  });
});

afterEach(() => {
  closeAllAcpConnections();
  getAgentMachineCache().clear();
  resetAllStubs();
});

describe("round43 acp ws handler", () => {
  // 开放连接必须以 NDJSON 信封发送协议对象。
  test("sendToWs 将对象封装为带换行的 JSON 帧", () => {
    const ws = new FakeWs();

    sendToWs(ws, { type: "registered", machine_id: "machine-43" });

    expect(ws.sent).toEqual(['{"type":"registered","machine_id":"machine-43"}\n']);
  });

  // 非 OPEN 的连接不得写入任何协议帧。
  test("sendToWs 忽略已关闭连接", () => {
    const ws = new FakeWs();
    ws.readyState = 3;

    sendToWs(ws, { type: "keep_alive" });

    expect(ws.sent).toEqual([]);
  });

  // 底层发送异常不能穿透到 WS 路由回调。
  test("sendToWs 吞掉底层发送异常", () => {
    const ws = new FakeWs();
    ws.throwOnSend = true;

    expect(() => sendToWs(ws, { type: "keep_alive" })).not.toThrow();
  });

  // 未携带 machine 标识或环境绑定的连接必须被协议拒绝。
  test("未知连接以 4003 关闭且不进入连接表", () => {
    const ws = new FakeWs();

    handleAcpWsOpen(ws, "unknown-43", "user-a", null, false);

    expect(ws.closed).toEqual([[4003, "Unidentified connection; provide either boundEnvId or registry secret"]]);
    expect(listAcpConnections().find((item) => item.wsId === "unknown-43")).toBeUndefined();
  });

  // machine 连接只保存调用者身份，不会复用其他连接的用户标识。
  test("machine 快照按连接保留各自用户身份", () => {
    handleAcpWsOpen(new FakeWs(), "machine-user-a", "user-a", null, true);
    handleAcpWsOpen(new FakeWs(), "machine-user-b", "user-b", null, true);

    expect(listAcpConnections().map((item) => [item.wsId, item.userId])).toEqual([
      ["machine-user-a", "user-a"],
      ["machine-user-b", "user-b"],
    ]);
  });

  // 多行 NDJSON 必须逐行解包，损坏帧不能阻止后续合法帧。
  test("消息处理解包 NDJSON 并跳过损坏行", async () => {
    const ws = new FakeWs();
    handleAcpWsOpen(ws, "register-lines", "user-a", null, true);

    await handleAcpWsMessage(ws, "register-lines", '{"type":"register","agent_name":"alpha"}\nnot-json\n');
    await flushRegistration();

    expect(registeredMachines).toEqual([{ agentName: "alpha", tenantId: null, nodeId: null, machineId: null }]);
  });

  // 预解析对象帧应与文本帧共享注册协议。
  test("预解析 register 对象保留租户、节点和指定机器标识", async () => {
    const ws = new FakeWs();
    handleAcpWsOpen(ws, "register-object", "user-a", null, true);

    await handleAcpWsMessage(ws, "register-object", {
      type: "register",
      agent_name: "beta",
      tenant_id: "org-a",
      node_id: "node-a",
      machine_id: "machine-fixed",
    });
    await flushRegistration();

    expect(registeredMachines[0]).toEqual({
      agentName: "beta",
      tenantId: "org-a",
      nodeId: "node-a",
      machineId: "machine-fixed",
    });
  });

  // 注册完成后必须回送 registered 信封并使用注册服务返回的机器 ID。
  test("注册成功回送 registered 帧并登记 remote node", async () => {
    const ws = new FakeWs();
    handleAcpWsOpen(ws, "register-success", "user-a", null, true);

    await handleAcpWsMessage(ws, "register-success", { type: "register" });
    await flushRegistration();

    expect(frame(ws)).toEqual({ type: "registered", machine_id: "machine-43", is_new: true });
    expect(registeredEntries).toHaveLength(1);
    expect(findMachineConnectionById("machine-43")?.wsId).toBe("register-success");
  });

  // 同一连接重复注册不得重新创建机器，而应确认既有标识。
  test("重复注册回送既有 machineId", async () => {
    const ws = new FakeWs();
    handleAcpWsOpen(ws, "register-twice", "user-a", null, true);
    await handleAcpWsMessage(ws, "register-twice", { type: "register" });
    await flushRegistration();

    await handleAcpWsMessage(ws, "register-twice", { type: "register" });
    await flushRegistration();

    expect(registeredMachines).toHaveLength(1);
    expect(frame(ws, 1)).toEqual({ type: "registered", machine_id: "machine-43" });
  });

  // 注册失败应转化为协议 error 帧，避免向客户端暴露内部错误。
  test("注册失败回送通用 error 帧", async () => {
    stubRegistry({
      registerMachine: async () => {
        throw new Error("database detail");
      },
    });
    const ws = new FakeWs();
    handleAcpWsOpen(ws, "register-failure", "user-a", null, true);

    await handleAcpWsMessage(ws, "register-failure", { type: "register" });
    await flushRegistration();

    expect(frame(ws)).toEqual({ type: "error", message: "Machine registration failed" });
  });

  // 已注册机器的 heartbeat 必须只路由给该 machineId。
  test("heartbeat 路由到已注册 machine", async () => {
    const ws = new FakeWs();
    handleAcpWsOpen(ws, "heartbeat-43", "user-a", null, true);
    await handleAcpWsMessage(ws, "heartbeat-43", { type: "register" });
    await flushRegistration();

    await handleAcpWsMessage(ws, "heartbeat-43", { type: "heartbeat" });

    expect(heartbeatMachines).toEqual(["machine-43"]);
  });

  // remote 协议响应要注入 transport，并携带原始协议对象。
  test("remote 协议消息注入对应 transport", async () => {
    const ws = new FakeWs();
    const injected: unknown[] = [];
    handleAcpWsOpen(ws, "remote-43", "user-a", null, true);
    await handleAcpWsMessage(ws, "remote-43", { type: "register" });
    await flushRegistration();
    registeredEntries[0].remoteTransport = {
      injectMessage: (message: unknown) => {
        injected.push(message);
      },
    } as unknown as RemoteTransport;

    await handleAcpWsMessage(ws, "remote-43", { type: "start_result", instance_id: "instance-a", ok: true });

    expect(injected).toEqual([{ type: "start_result", instance_id: "instance-a", ok: true }]);
  });

  // session 消息只调用匹配 sessionId 的监听器，避免跨会话转发。
  test("session 消息按 sessionId 隔离监听器", async () => {
    const ws = new FakeWs();
    const delivered: Array<[string, string, unknown]> = [];
    handleAcpWsOpen(ws, "session-43", "user-a", null, true);
    await handleAcpWsMessage(ws, "session-43", { type: "register" });
    await flushRegistration();
    registeredEntries[0].sessionMessageListeners?.set("session-a", (id, type, payload) => {
      delivered.push([id, type, payload]);
    });

    await handleAcpWsMessage(ws, "session-43", {
      type: "session_data",
      session_id: "session-b",
      payload: { secret: "not-for-a" },
    });
    await handleAcpWsMessage(ws, "session-43", {
      type: "session_data",
      session_id: "session-a",
      payload: { text: "for-a" },
    });

    expect(delivered).toEqual([["session-a", "session_data", { text: "for-a" }]]);
  });

  // 缓存映射必须将发送限制到绑定机器，而不是广播给其他连接。
  test("sendToAgentWs 仅向缓存绑定的 machine 转发 session_data", async () => {
    stubRegistry({
      registerMachine: async (input: Record<string, unknown>) => ({
        id: input.agentName === "first" ? "machine-first" : "machine-second",
        isNew: true,
      }),
    });
    const first = new FakeWs();
    const second = new FakeWs();
    handleAcpWsOpen(first, "agent-first", "user-a", null, true);
    await handleAcpWsMessage(first, "agent-first", { type: "register", agent_name: "first" });
    await flushRegistration();
    handleAcpWsOpen(second, "agent-second", "user-b", null, true);
    await handleAcpWsMessage(second, "agent-second", { type: "register", agent_name: "second" });
    await flushRegistration();
    setAgentMachineCache("environment-a", "machine-first");

    expect(sendToAgentWs("environment-a", { type: "relay", payload: "only-bound" })).toBe(true);
    expect(frame(first, first.sent.length - 1)).toEqual({
      type: "session_data",
      session_id: "auto_environment-a",
      payload: { type: "relay", payload: "only-bound" },
    });
    expect(frame(second)).toEqual({ type: "registered", machine_id: "machine-second", is_new: true });
  });

  // 缺少环境所属的 agentConfig 绑定时，不得解析或缓存任意机器连接。
  test("findMachineConnectionByAgentId 拒绝未绑定 agentConfig 的环境", async () => {
    const ws = new FakeWs();
    handleAcpWsOpen(ws, "lookup-43", "user-a", null, true);
    await handleAcpWsMessage(ws, "lookup-43", { type: "register" });
    await flushRegistration();
    stubEnvironmentRepo({ getById: async () => ({ agentConfigId: null }) });

    expect(await findMachineConnectionByAgentId("environment-a")).toBeNull();
    expect(getAgentMachineCache().has("environment-a")).toBe(false);
  });

  // 关闭注册机器必须撤销 node、停止心跳并标记机器离线。
  test("关闭 machine 连接执行完整清理", async () => {
    const ws = new FakeWs();
    facadeInstances = [{ instanceId: "instance-a", nodeId: "machine-43" }];
    handleAcpWsOpen(ws, "close-43", "user-a", null, true);
    await handleAcpWsMessage(ws, "close-43", { type: "register" });
    await flushRegistration();

    handleAcpWsClose(ws, "close-43", 1006, "network lost");

    expect(disconnectedMachines).toEqual([["machine-43", "network lost"]]);
    expect(unregisteredMachines).toEqual(["machine-43"]);
    expect(stoppedHeartbeats).toEqual(["machine-43"]);
    expect(findMachineConnectionById("machine-43")).toBeNull();
  });

  // sweep 清理没有活动连接时也应按 machineId 执行断开流程。
  test("按 machineId 触发清理会停止孤立机器", () => {
    triggerMachineCleanupByMachineId("orphan-43", "heartbeat timeout");

    expect(disconnectedMachines).toEqual([["orphan-43", "heartbeat timeout"]]);
    expect(unregisteredMachines).toEqual(["orphan-43"]);
    expect(stoppedHeartbeats).toEqual(["orphan-43"]);
  });

  // keep_alive 对本地环境连接只刷新该环境的轮询活动。
  test("keep_alive 刷新已绑定环境活动", async () => {
    const ws = new FakeWs();
    handleAcpWsOpen(ws, "local-43", "user-a", "environment-a", false);

    await handleAcpWsMessage(ws, "local-43", { type: "keep_alive" });

    expect(environmentPolls).toEqual(["environment-a"]);
    handleAcpWsClose(ws, "local-43");
  });
});
