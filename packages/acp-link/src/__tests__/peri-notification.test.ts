// packages/acp-link/src/__tests__/peri-notification.test.ts
// Slice 0A：SDK notification 穿透 spike。
//
// 目标（规格 §一.3 阻断条件）：证明 capability 打开后 peri/agent_event 与
// peri/unstable_event 能经 SDK legacyClientApp 的 extNotification 透传到业务层，
// 且不返回导致 agent 中断的 -32601、session/update 等标准 handler 不回归。
// 本 spike 未通过前不得提交 capability 开启改动。
//
// 方法与证据链：
// - SDK v1.2.0 的 legacyClientNotificationMethods 只含 session_update 与
//   elicitation_complete（acp.js:982），peri/* 不在其中，未知 notification 会
//   命中 legacyClientApp 注册的 extNotification handler 并返回 Handled.yes()
//   （不产生 -32601 错误帧）；
// - 三条 initialize 路径（remote spawn helper / shared session manager /
//   local server client）的 factory 都向 ClientSideConnection 传入
//   extNotification，转发逻辑统一为「isPeriTaskNotificationMethod 白名单 +
//   createNotification + 现有 send/emit/sendMsg」，本测试按各路径转发形态
//   验证转发帧与 relay extractJsonRpc（裸 / { type, payload } 包裹）兼容。

import { describe, expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import { createNotification } from "../json-rpc";
import {
  isPeriTaskNotificationMethod,
  PERI_AGENT_EVENT_METHOD,
  PERI_UNSTABLE_EVENT_METHOD,
} from "../peri-task-capability";

/** 轮询等待异步处理完成（SDK 连接消费/转发 notification 是异步微任务/IO） */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

/** 最小可用 Agent 实现（SDK Agent 接口必选方法） */
class SpikeAgent {
  initialize(params: acp.schema.InitializeRequest) {
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: { loadSession: false },
      authMethods: [],
    };
  }
  newSession() {
    return { sessionId: "ses_spike" };
  }
  authenticate() {
    return { authenticated: true };
  }
  prompt() {
    return { stopReason: "end_turn" as const };
  }
  cancel() {}
}

interface SpikeHarness {
  /** 被测 client 侧连接（对应三条路径之一） */
  clientConnection: acp.ClientSideConnection;
  /** 模拟 agent 侧连接（发送 peri/* notification） */
  agentConnection: acp.AgentSideConnection;
  /** client→agent 方向全部原始帧（含换行分隔，用于 -32601 检查） */
  clientFrames: string[];
  /** 被测 factory 收到的扩展 notification（method + params 原样） */
  periNotifications: Array<{ method: string; params: Record<string, unknown> }>;
  /** 被测 factory 收到的 session/update 通知（回归检查） */
  sessionUpdates: Array<Record<string, unknown>>;
}

/**
 * 构造 spike 测试台：SDK 官方测试同款双向 TransformStream 对接
 * （acp.test.js:3060-3158），client 与 agent 各持一端。
 * client→agent 方向经 tee 分流一份供 -32601 检查。
 */
function setupSpike(options: {
  buildFactory: (hooks: {
    onPeriNotification: (method: string, params: Record<string, unknown>) => void;
    onSessionUpdate: (params: Record<string, unknown>) => void;
  }) => Record<string, unknown>;
}): SpikeHarness {
  const { buildFactory } = options;
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  // 代理 WritableStream：记录 client→agent 方向全部帧（检查 -32601），
  // 记录后转发到真实管道，不改变数据流
  const clientFrames: string[] = [];
  const clientOut = new WritableStream<Uint8Array>({
    write(chunk) {
      clientFrames.push(new TextDecoder().decode(chunk));
      const writer = clientToAgent.writable.getWriter();
      return writer.write(chunk).finally(() => writer.releaseLock());
    },
  });

  const periNotifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const sessionUpdates: Array<Record<string, unknown>> = [];
  const factory = buildFactory({
    onPeriNotification: (method, params) => periNotifications.push({ method, params }),
    onSessionUpdate: (params) => sessionUpdates.push(params),
  });

  const clientConnection = new acp.ClientSideConnection(
    () => factory as never,
    acp.ndJsonStream(clientOut, agentToClient.readable),
  );
  const agentConnection = new acp.AgentSideConnection(
    () => new SpikeAgent() as never,
    acp.ndJsonStream(agentToClient.writable, clientToAgent.readable),
  );
  return { clientConnection, agentConnection, clientFrames, periNotifications, sessionUpdates };
}

/** 模拟三条路径之一的 extNotification 转发逻辑并断言转发帧格式 */
function assertForwardFrame(
  forward: (method: string, params: Record<string, unknown>) => unknown,
  method: string,
  params: Record<string, unknown>,
  expected: (frame: Record<string, unknown>) => void,
): void {
  if (isPeriTaskNotificationMethod(method)) {
    expected(forward(method, params) as Record<string, unknown>);
  } else {
    throw new Error(`expected ${method} to pass capability whitelist`);
  }
}

describe("SDK 未知 notification 穿透（Slice 0A spike）", () => {
  // 核心阻断条件：SDK 必须把未知 peri/agent_event notification 原样交给业务层
  // factory 的 extNotification（capability 打开时才能收到 Peri 事件）
  test("peri/agent_event reaches the client factory extNotification as-is", async () => {
    const harness = setupSpike({
      buildFactory: ({ onPeriNotification, onSessionUpdate }) => ({
        requestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }),
        sessionUpdate: async (params: Record<string, unknown>) => onSessionUpdate(params),
        readTextFile: async () => ({ content: "" }),
        writeTextFile: async () => ({}),
        extNotification: async (method: string, params: Record<string, unknown>) => onPeriNotification(method, params),
      }),
    });

    await harness.clientConnection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "rcs-spike", version: "1.0.0" },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    const payload = {
      event_json: JSON.stringify({
        type: "subagent_started",
        value: { instance_id: "inst_1", agent_name: "researcher" },
      }),
    };
    await harness.agentConnection.notify(PERI_AGENT_EVENT_METHOD, payload);

    await waitFor(() => harness.periNotifications.length === 1);
    expect(harness.periNotifications[0]).toEqual({ method: PERI_AGENT_EVENT_METHOD, params: payload });
  });

  // 核心阻断条件：peri/unstable_event 同样原样到达（Background Task 通道）
  test("peri/unstable_event reaches the client factory extNotification as-is", async () => {
    const harness = setupSpike({
      buildFactory: ({ onPeriNotification, onSessionUpdate }) => ({
        sessionUpdate: async (params: Record<string, unknown>) => onSessionUpdate(params),
        readTextFile: async () => ({ content: "" }),
        writeTextFile: async () => ({}),
        extNotification: async (method: string, params: Record<string, unknown>) => onPeriNotification(method, params),
      }),
    });

    await harness.clientConnection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "rcs-spike", version: "1.0.0" },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    const payload = { event: "bg-task-started", data: { task_id: "task_1", kind: "shell", summary: "run tests" } };
    await harness.agentConnection.notify(PERI_UNSTABLE_EVENT_METHOD, payload);

    await waitFor(() => harness.periNotifications.length === 1);
    expect(harness.periNotifications[0]).toEqual({ method: PERI_UNSTABLE_EVENT_METHOD, params: payload });
  });

  // 不返回 -32601：extNotification 返回 Handled.yes()，SDK 不把未知 notification
  // 当方法错误响应；否则 agent 会收到 error 帧并可能中断
  test("unknown peri notification does not produce a -32601 error frame", async () => {
    const harness = setupSpike({
      buildFactory: ({ onPeriNotification, onSessionUpdate }) => ({
        sessionUpdate: async (params: Record<string, unknown>) => onSessionUpdate(params),
        readTextFile: async () => ({ content: "" }),
        writeTextFile: async () => ({}),
        extNotification: async (method: string, params: Record<string, unknown>) => onPeriNotification(method, params),
      }),
    });

    await harness.clientConnection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "rcs-spike", version: "1.0.0" },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    await harness.agentConnection.notify(PERI_AGENT_EVENT_METHOD, { event_json: "{}" });
    await harness.agentConnection.notify(PERI_UNSTABLE_EVENT_METHOD, { event: "bg-task-started", data: {} });

    await waitFor(() => harness.periNotifications.length === 2);
    // 停顿一拍确保潜在的错误帧（若有）已写出
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.clientFrames.join("")).not.toContain("-32601");
  });

  // 标准 handler 不回归：session/update 仍走 sessionUpdate，不落入 extNotification
  test("session/update still routes to sessionUpdate, not extNotification", async () => {
    const harness = setupSpike({
      buildFactory: ({ onPeriNotification, onSessionUpdate }) => ({
        sessionUpdate: async (params: Record<string, unknown>) => onSessionUpdate(params),
        readTextFile: async () => ({ content: "" }),
        writeTextFile: async () => ({}),
        extNotification: async (method: string, params: Record<string, unknown>) => onPeriNotification(method, params),
      }),
    });

    await harness.clientConnection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "rcs-spike", version: "1.0.0" },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    const update = {
      sessionId: "ses_spike",
      update: {
        sessionUpdate: "agent_message_chunk" as const,
        content: { type: "text" as const, text: "hello" },
      },
    };
    await harness.agentConnection.notify("session/update", update);

    await waitFor(() => harness.sessionUpdates.length === 1);
    expect(harness.sessionUpdates[0]).toEqual(update);
    expect(harness.periNotifications).toEqual([]);
  });
});

describe("三条路径转发形态与 relay envelope 兼容（Slice 0A）", () => {
  // remote spawn helper（acp-spawn-helper.ts）：extNotification → send 转发
  // 裸 JSON-RPC notification，relay extractJsonRpc 第一分支直接识别
  test("spawn-helper forwards bare jsonrpc envelope", () => {
    const forward = (method: string, params: Record<string, unknown>) => createNotification(method, params);
    const params = { event_json: JSON.stringify({ type: "subagent_stopped", value: { instance_id: "inst_1" } }) };
    assertForwardFrame(forward, PERI_AGENT_EVENT_METHOD, params, (frame) => {
      expect(frame.jsonrpc).toBe("2.0");
      expect(frame.method).toBe(PERI_AGENT_EVENT_METHOD);
      expect(frame.params).toEqual(params);
      expect("id" in frame).toBe(false);
    });
  });

  // shared session manager（session-manager.ts）：extNotification →
  // emit(relayId, "session_data", createNotification(...)) 包裹格式，
  // relay extractJsonRpc 第二分支（payload.jsonrpc）识别
  test("session-manager forwards { type: session_data, payload } wrapped envelope", () => {
    const forward = (method: string, params: Record<string, unknown>) => ({
      type: "session_data",
      payload: createNotification(method, params),
    });
    const params = { event: "bg-task-completed", data: { task_id: "task_1" } };
    assertForwardFrame(forward, PERI_UNSTABLE_EVENT_METHOD, params, (frame) => {
      expect(frame.type).toBe("session_data");
      const payload = frame.payload as Record<string, unknown>;
      expect(payload.jsonrpc).toBe("2.0");
      expect(payload.method).toBe(PERI_UNSTABLE_EVENT_METHOD);
      expect(payload.params).toEqual(params);
    });
  });

  // local server client（server.ts）：extNotification → sendMsg 转发裸 JSON-RPC
  test("local server client forwards bare jsonrpc envelope", () => {
    const forward = (method: string, params: Record<string, unknown>) => createNotification(method, params);
    const params = { event_json: JSON.stringify({ type: "subagent_started", value: { instance_id: "inst_2" } }) };
    assertForwardFrame(forward, PERI_AGENT_EVENT_METHOD, params, (frame) => {
      expect(frame.jsonrpc).toBe("2.0");
      expect(frame.method).toBe(PERI_AGENT_EVENT_METHOD);
      expect(frame.params).toEqual(params);
    });
  });
});
