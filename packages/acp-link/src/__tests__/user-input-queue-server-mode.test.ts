// packages/acp-link/src/__tests__/user-input-queue-server-mode.test.ts
// Peri steer（用户输入队列）在 server mode（server.ts dispatchIncomingMessage）的端到端契约：
// 前端 WS 发来的 session/input/* 必须经同一个 relay 连接原样转发给 agent 进程（stdio
// JSON-RPC 上的扩展方法），并把 agent 的 result / error（含 data.rejected）原样回传。
// 覆盖 client mode 未覆盖的接线点：acp-dispatcher.ts 的透传实现被 server.ts 复用后，
// server mode 分派确实走到了同一路径（否则 WS 只会拿到 -32601 Method not found）。

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createAcpServer } from "../server.js";

interface WebsocketHandlers {
  open(ws: unknown): void;
  message(ws: unknown, raw: unknown): Promise<void> | void;
  close(ws: unknown): void;
}

interface RpcRequest {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

type AgentResponse = { result?: unknown; error?: { code: number; message: string; data?: unknown } };

class FakeWs {
  readyState = 1;
  readonly messages: Array<Record<string, unknown>> = [];

  send(message: string): void {
    this.messages.push(JSON.parse(message));
  }

  close(): void {
    this.readyState = 3;
  }

  ping(): void {}
}

const SNAPSHOT = {
  sessionId: "ses-input",
  generation: 4,
  revision: 2,
  items: [{ inputId: "in_1", content: "排队消息", originalDraft: "草稿", state: "queued" }],
};

/**
 * 假 peri agent：只处理 initialize / session/new / session/input/*，
 * 其余请求回空对象；可通过 responses 注入成功结果或 JSON-RPC 错误。
 */
function createAgent(responses: Record<string, AgentResponse>) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const requests: RpcRequest[] = [];
  let input = "";
  const process = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    killed: false,
    exitCode: null as number | null,
    signalCode: null,
    kill() {
      this.killed = true;
      this.exitCode = 0;
      stdin.end();
      stdout.end();
      this.emit("exit", 0);
      return true;
    },
  });
  stdin.once("finish", () => {
    process.exitCode = 0;
    stdout.end();
    process.emit("exit", 0);
  });
  const write = (message: unknown) => stdout.write(`${JSON.stringify(message)}\n`);
  stdin.on("data", (chunk: Buffer) => {
    input += chunk.toString();
    let newline = input.indexOf("\n");
    while (newline !== -1) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      newline = input.indexOf("\n");
      if (!line) continue;
      const request = JSON.parse(line) as RpcRequest;
      if (request.id === undefined) continue;
      requests.push(request);
      switch (request.method) {
        case "initialize":
          write({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: 1,
              agentInfo: { name: "peri-user-input-test", version: "1" },
              agentCapabilities: { _meta: { "peri.userInputQueue": true } },
            },
          });
          break;
        case "session/new":
          write({ jsonrpc: "2.0", id: request.id, result: { sessionId: "ses-input" } });
          break;
        default: {
          const response = responses[request.method];
          if (response?.error) write({ jsonrpc: "2.0", id: request.id, error: response.error });
          else write({ jsonrpc: "2.0", id: request.id, result: response?.result ?? {} });
        }
      }
    }
  });
  return {
    process: process as unknown as childProcess.ChildProcess,
    requests,
    /** 模拟 peri 主动推送的 user_input_* 事件（复用 peri/agent_event 通道） */
    notify: (method: string, params: Record<string, unknown>) => write({ jsonrpc: "2.0", method, params }),
  };
}

const handles: Array<{ close(): Promise<void> }> = [];
const restoreSpies: Array<() => void> = [];

function createHarness(responses: Record<string, AgentResponse>) {
  let handlers: WebsocketHandlers | undefined;
  const serveSpy = spyOn(Bun, "serve").mockImplementation(((options: { websocket: WebsocketHandlers }) => {
    handlers = options.websocket;
    return { port: 0, stop: () => {}, reload: () => {} };
  }) as unknown as typeof Bun.serve);
  const agents: Array<ReturnType<typeof createAgent>> = [];
  const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(() => {
    const agent = createAgent(responses);
    agents.push(agent);
    return agent.process;
  });
  restoreSpies.push(() => spawnSpy.mockRestore());
  try {
    const handle = createAcpServer({
      port: 0,
      host: "127.0.0.1",
      command: "test-agent",
      args: [],
      cwd: "/tmp/acp-user-input-queue-test",
    });
    handles.push(handle);
    if (!handlers) throw new Error("WebSocket handlers 未注册");
    return { handlers, agents, handle };
  } finally {
    serveSpy.mockRestore();
  }
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("测试 Agent 响应超时");
    await Bun.sleep(1);
  }
}

async function send(harness: ReturnType<typeof createHarness>, ws: FakeWs, message: Record<string, unknown>) {
  await harness.handlers.message(ws, JSON.stringify(message));
  if (message.id !== undefined) {
    await waitUntil(() => ws.messages.some((response) => response.id === message.id));
  }
}

function findResponse(ws: FakeWs, id: number | string): Record<string, unknown> {
  const response = ws.messages.find((message) => message.id === id);
  if (!response) throw new Error(`未收到 id=${id} 的响应`);
  return response;
}

/** 连接 agent 并建立会话：session/input/* 需要 socketSessions 绑定才能收到事件回推 */
async function openSession(harness: ReturnType<typeof createHarness>, ws: FakeWs): Promise<void> {
  harness.handlers.open(ws);
  await send(harness, ws, { type: "connect" });
  await send(harness, ws, { jsonrpc: "2.0", id: "new-session", method: "session/new", params: {} });
  expect(findResponse(ws, "new-session")).toMatchObject({ result: { sessionId: "ses-input" } });
}

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const restore of restoreSpies.splice(0)) restore();
});

describe("server mode session/input/* 透传", () => {
  // 四个扩展方法都要走到 agent 侧扩展方法通道，方法名与 params 逐字段保持原样
  // （sessionId 是 ACP ses_* 标识，acp-link 不做 RCS 侧换算）
  test("四个方法转发到 agent 且 params 原样", async () => {
    const harness = createHarness({
      "session/input/snapshot": { result: SNAPSHOT },
      "session/input/enqueue": { result: { snapshot: SNAPSHOT, results: [{ inputId: "in_1", state: "queued" }] } },
      "session/input/dispatch": {
        result: { snapshot: SNAPSHOT, results: [{ inputId: "in_1", state: "dispatching" }] },
      },
      "session/input/takeback": {
        result: { snapshot: SNAPSHOT, results: [{ inputId: "in_1", state: "withdrawn" }], takenBack: true },
      },
    });
    const ws = new FakeWs();
    await openSession(harness, ws);

    const calls: Array<{ id: string; method: string; params: Record<string, unknown> }> = [
      { id: "snap", method: "session/input/snapshot", params: { sessionId: "ses-input", generation: 4 } },
      {
        id: "enq",
        method: "session/input/enqueue",
        params: {
          sessionId: "ses-input",
          generation: 4,
          commandId: "cmd_1",
          inputId: "in_1",
          content: [
            { type: "text", text: "先跑测试" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
          ],
          originalDraft: "先跑测试",
        },
      },
      {
        id: "disp",
        method: "session/input/dispatch",
        params: { sessionId: "ses-input", generation: 4, commandId: "cmd_1", inputIds: ["in_1"] },
      },
      {
        id: "back",
        method: "session/input/takeback",
        params: { sessionId: "ses-input", generation: 4, commandId: "cmd_1", inputId: "in_1" },
      },
    ];

    for (const call of calls) {
      await send(harness, ws, { jsonrpc: "2.0", id: call.id, method: call.method, params: call.params });
    }

    const agent = harness.agents[0];
    if (!agent) throw new Error("agent 进程未启动");
    // initialize 必须带上用户输入队列能力声明（server.ts 侧 initialize 复用
    // buildPeriCapabilityMeta 的运行时证据），否则 peri 对四个方法回 -32601
    expect(agent.requests.find((request) => request.method === "initialize")?.params).toMatchObject({
      clientCapabilities: { _meta: { "peri.userInputQueue": true } },
    });
    for (const call of calls) {
      expect(agent.requests).toContainEqual(expect.objectContaining({ method: call.method, params: call.params }));
    }
    expect(findResponse(ws, "snap")).toMatchObject({ result: SNAPSHOT });
    expect(findResponse(ws, "enq")).toMatchObject({ result: { results: [{ inputId: "in_1", state: "queued" }] } });
    expect(findResponse(ws, "back")).toMatchObject({ result: { takenBack: true } });
  });

  // peri 侧 -32602（generation 不符）与 data.rejected/snapshot 必须整包回传前端，
  // 前端据此重新对齐代际；错误码、message、data 均不得被替换
  test("agent 错误原样回传前端（-32602 带 data.rejected）", async () => {
    const harness = createHarness({
      "session/input/dispatch": {
        error: { code: -32602, message: "generation mismatch", data: { rejected: true, snapshot: SNAPSHOT } },
      },
      "session/input/enqueue": { error: { code: -32601, message: "user input queue capability not negotiated" } },
    });
    const ws = new FakeWs();
    await openSession(harness, ws);

    await send(harness, ws, {
      jsonrpc: "2.0",
      id: "disp-stale",
      method: "session/input/dispatch",
      params: { sessionId: "ses-input", generation: 1, commandId: "cmd_1", inputIds: ["in_1"] },
    });
    await send(harness, ws, {
      jsonrpc: "2.0",
      id: "enq-unnegotiated",
      method: "session/input/enqueue",
      params: {
        sessionId: "ses-input",
        generation: 1,
        commandId: "cmd_1",
        inputId: "in_1",
        content: "x",
        originalDraft: "",
      },
    });

    expect(findResponse(ws, "disp-stale")).toEqual({
      jsonrpc: "2.0",
      id: "disp-stale",
      error: { code: -32602, message: "generation mismatch", data: { rejected: true, snapshot: SNAPSHOT } },
    });
    expect(findResponse(ws, "enq-unnegotiated")).toEqual({
      jsonrpc: "2.0",
      id: "enq-unnegotiated",
      error: { code: -32601, message: "user input queue capability not negotiated" },
    });
    expect(findResponse(ws, "disp-stale")).not.toHaveProperty("result");
  });

  // 未连接 agent 时不能静默成功：回 -32000，调用方才能区分「队列空」与「链路不通」
  test("agent 未连接时回 -32000", async () => {
    const harness = createHarness({ "session/input/snapshot": { result: SNAPSHOT } });
    const ws = new FakeWs();
    harness.handlers.open(ws);

    await send(harness, ws, {
      jsonrpc: "2.0",
      id: "no-connection",
      method: "session/input/snapshot",
      params: { sessionId: "ses-input", generation: 4 },
    });

    expect(findResponse(ws, "no-connection")).toMatchObject({
      error: { code: -32000, message: "Not connected to agent" },
    });
  });

  // 三个 user_input_* 事件复用 peri/agent_event 通道：白名单不变也要能原样透传到前端 WS
  test("user_input_* 事件经 peri/agent_event 通道透传", async () => {
    const harness = createHarness({});
    const ws = new FakeWs();
    await openSession(harness, ws);

    const agent = harness.agents[0];
    if (!agent) throw new Error("agent 进程未启动");
    const eventJson = JSON.stringify({ type: "user_input_queue_changed", snapshot: SNAPSHOT });
    agent.notify("peri/agent_event", { sessionId: "ses-input", event_json: eventJson });

    await waitUntil(() => ws.messages.some((message) => message.method === "peri/agent_event"));
    expect(ws.messages.find((message) => message.method === "peri/agent_event")).toEqual({
      jsonrpc: "2.0",
      method: "peri/agent_event",
      params: { sessionId: "ses-input", event_json: eventJson },
    });
  });
});
