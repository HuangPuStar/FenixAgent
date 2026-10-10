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

class FakeWs {
  readyState = 1;
  failSend = false;
  readonly messages: Array<Record<string, unknown>> = [];

  send(message: string): void {
    if (this.failSend) throw new Error("synthetic relay send failure");
    this.messages.push(JSON.parse(message));
  }

  close(): void {
    this.readyState = 3;
  }

  ping(): void {}
}

function createAgent(autoInitialize: boolean) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const requests: RpcRequest[] = [];
  const loadedSessions = new Set<string>();
  let input = "";
  let initializeId: number | string | undefined;
  let killCount = 0;
  const process = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    killed: false,
    exitCode: null as number | null,
    signalCode: null,
    kill() {
      killCount += 1;
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
  const respond = (id: number | string, result: unknown) => {
    stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  };
  const notifySession = (sessionId: string) => {
    stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply" } } } })}\n`,
    );
  };
  const initialize = () => {
    if (initializeId === undefined) throw new Error("initialize 尚未到达测试 Agent");
    respond(initializeId, {
      protocolVersion: 1,
      agentInfo: { name: "relay-lifecycle-test", version: "1" },
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
    });
  };
  const failInitialization = () => {
    if (initializeId === undefined) throw new Error("initialize 尚未到达测试 Agent");
    stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: initializeId, error: { code: -32603, message: "sensitive upstream details" } })}\n`,
    );
  };
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
          initializeId = request.id;
          if (autoInitialize) queueMicrotask(initialize);
          break;
        case "session/new": {
          const sessionId = loadedSessions.size === 0 ? "ses-lifecycle" : `ses-lifecycle-${loadedSessions.size + 1}`;
          loadedSessions.add(sessionId);
          respond(request.id, { sessionId });
          break;
        }
        case "session/prompt": {
          const sessionId = String(request.params?.sessionId);
          if (!loadedSessions.has(sessionId)) {
            stdout.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "Session is not loaded" } })}\n`,
            );
            break;
          }
          notifySession(sessionId);
          respond(request.id, { stopReason: "end_turn" });
          break;
        }
        default:
          respond(request.id, {});
      }
    }
  });
  return {
    process: process as unknown as childProcess.ChildProcess,
    requests,
    initialize,
    failInitialization,
    notifySession,
    get killCount() {
      return killCount;
    },
  };
}

const handles: Array<{ close(): Promise<void> }> = [];
const restoreSpies: Array<() => void> = [];

function createHarness(autoInitialize = true) {
  let handlers: WebsocketHandlers | undefined;
  const serveSpy = spyOn(Bun, "serve").mockImplementation(((options: { websocket: WebsocketHandlers }) => {
    handlers = options.websocket;
    return { port: 0, stop: () => {}, reload: () => {} };
  }) as unknown as typeof Bun.serve);
  const agents: Array<ReturnType<typeof createAgent>> = [];
  const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(() => {
    const agent = createAgent(autoInitialize);
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
      cwd: "/tmp/acp-relay-lifecycle-test",
    });
    handles.push(handle);
    if (!handlers) throw new Error("WebSocket handlers 未注册");
    return { handlers, agents, handle };
  } finally {
    serveSpy.mockRestore();
  }
}

async function send(harness: ReturnType<typeof createHarness>, ws: FakeWs, message: Record<string, unknown>) {
  await harness.handlers.message(ws, JSON.stringify(message));
  if (message.id !== undefined) {
    await waitUntil(() => ws.messages.some((response) => response.id === message.id));
  } else if (message.type === "connect") {
    await waitUntil(() =>
      ws.messages.some((response) => {
        const payload = response.payload as Record<string, unknown> | undefined;
        return response.type === "status" && payload?.connected === true && payload.capabilities != null;
      }),
    );
  }
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("测试 Agent 响应超时");
    await Bun.sleep(1);
  }
}

function disconnect(harness: ReturnType<typeof createHarness>, ws: FakeWs) {
  ws.close();
  harness.handlers.close(ws);
}

async function open(harness: ReturnType<typeof createHarness>, ws: FakeWs) {
  harness.handlers.open(ws);
  await send(harness, ws, { type: "connect" });
}

async function newSession(harness: ReturnType<typeof createHarness>, ws: FakeWs) {
  await send(harness, ws, { jsonrpc: "2.0", id: "new-session", method: "session/new", params: {} });
  expect(ws.messages.find((message) => message.id === "new-session")).toMatchObject({
    result: { sessionId: "ses-lifecycle" },
  });
}

async function prompt(harness: ReturnType<typeof createHarness>, ws: FakeWs, id: string, sessionId = "ses-lifecycle") {
  await send(harness, ws, {
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: { sessionId, content: [{ type: "text", text: "test" }] },
  });
  expect(ws.messages.find((message) => message.id === id)).toMatchObject({ result: { stopReason: "end_turn" } });
}

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const restore of restoreSpies.splice(0)) restore();
});

describe("本地 Agent 实例与 relay 生命周期隔离", () => {
  // 页面刷新只释放 relay，原会话无需重新加载即可继续对话，消息必须送到新连接。
  test("refresh preserves the agent session and sends notifications to the new relay", async () => {
    const harness = createHarness();
    const firstWs = new FakeWs();
    await open(harness, firstWs);
    await newSession(harness, firstWs);
    await prompt(harness, firstWs, "first-prompt");
    disconnect(harness, firstWs);

    expect(harness.agents[0]?.killCount).toBe(0);
    const secondWs = new FakeWs();
    await open(harness, secondWs);
    await prompt(harness, secondWs, "restored-prompt");

    expect(harness.agents).toHaveLength(1);
    expect(harness.agents[0]?.requests.filter((request) => request.method === "session/load")).toHaveLength(0);
    expect(secondWs.messages).toContainEqual(
      expect.objectContaining({
        method: "session/update",
        params: expect.objectContaining({ sessionId: "ses-lifecycle" }),
      }),
    );
    expect(firstWs.messages.some((message) => message.id === "restored-prompt")).toBe(false);
  });

  // 多个 relay 共享实例，关闭一个连接不能结束其他连接的会话，RPC 响应只回发起者。
  test("multiple relays share one agent without leaking RPC responses", async () => {
    const harness = createHarness();
    const firstWs = new FakeWs();
    const secondWs = new FakeWs();
    await open(harness, firstWs);
    await newSession(harness, firstWs);
    await open(harness, secondWs);
    await prompt(harness, firstWs, "first-only");
    expect(secondWs.messages.some((message) => message.id === "first-only")).toBe(false);
    disconnect(harness, firstWs);
    await prompt(harness, secondWs, "second-only");
    expect(harness.agents).toHaveLength(1);
    expect(harness.agents[0]?.killCount).toBe(0);
  });

  // 同一实例内两个会话分别绑定 relay，即使 RPC id 相同，响应和会话通知也不能串流。
  test("different sessions isolate notifications and identical RPC ids", async () => {
    const harness = createHarness();
    const firstWs = new FakeWs();
    const secondWs = new FakeWs();
    await open(harness, firstWs);
    await newSession(harness, firstWs);
    await open(harness, secondWs);
    await send(harness, secondWs, { jsonrpc: "2.0", id: "second-session", method: "session/new", params: {} });
    expect(secondWs.messages.find((message) => message.id === "second-session")).toMatchObject({
      result: { sessionId: "ses-lifecycle-2" },
    });
    await Promise.all([
      prompt(harness, firstWs, "shared-rpc-id"),
      prompt(harness, secondWs, "shared-rpc-id", "ses-lifecycle-2"),
    ]);
    for (const [ws, otherSessionId] of [
      [firstWs, "ses-lifecycle-2"],
      [secondWs, "ses-lifecycle"],
    ] as const) {
      expect(ws.messages.filter((message) => message.id === "shared-rpc-id")).toHaveLength(1);
      expect(
        ws.messages.some(
          (message) =>
            message.method === "session/update" &&
            (message.params as Record<string, unknown> | undefined)?.sessionId === otherSessionId,
        ),
      ).toBe(false);
    }
    expect(harness.agents).toHaveLength(1);
  });

  // 同一会话仍有存活 relay 时，最后发起请求的连接关闭不能丢失 Agent 后续异步通知。
  test("closing the latest session relay preserves notifications for another bound relay", async () => {
    const harness = createHarness();
    const firstWs = new FakeWs();
    const secondWs = new FakeWs();
    await open(harness, firstWs);
    await newSession(harness, firstWs);
    await prompt(harness, firstWs, "first-binding");
    await open(harness, secondWs);
    await prompt(harness, secondWs, "second-binding");
    disconnect(harness, secondWs);
    const firstMessageCount = firstWs.messages.length;
    harness.agents[0]?.notifySession("ses-lifecycle");
    await waitUntil(() => firstWs.messages.length > firstMessageCount);
    expect(firstWs.messages.at(-1)).toMatchObject({
      method: "session/update",
      params: { sessionId: "ses-lifecycle" },
    });
    expect(harness.agents[0]?.killCount).toBe(0);
  });

  // disconnect 控制帧只解除当前 relay 绑定，不能终止共享实例或继续收到旧会话通知。
  test("transport disconnect detaches only the requesting relay", async () => {
    const harness = createHarness();
    const firstWs = new FakeWs();
    const secondWs = new FakeWs();
    await open(harness, firstWs);
    await newSession(harness, firstWs);
    await open(harness, secondWs);
    await prompt(harness, secondWs, "shared-session");
    await send(harness, firstWs, { type: "disconnect" });
    const firstMessageCount = firstWs.messages.length;
    const secondMessageCount = secondWs.messages.length;
    harness.agents[0]?.notifySession("ses-lifecycle");
    await waitUntil(() => secondWs.messages.length > secondMessageCount);
    expect(firstWs.messages).toHaveLength(firstMessageCount);
    expect(harness.agents[0]?.killCount).toBe(0);
    await prompt(harness, secondWs, "after-disconnect");
  });

  // relay 切换到新会话后必须移除旧会话投递绑定，旧通知不得写入新会话视图。
  test("switching sessions removes the relay's previous notification binding", async () => {
    const harness = createHarness();
    const ws = new FakeWs();
    await open(harness, ws);
    await newSession(harness, ws);
    await send(harness, ws, { jsonrpc: "2.0", id: "another-session", method: "session/new", params: {} });
    const previousMessageCount = ws.messages.length;
    harness.agents[0]?.notifySession("ses-lifecycle");
    harness.agents[0]?.notifySession("ses-lifecycle-2");
    await waitUntil(() => ws.messages.length > previousMessageCount);
    expect(ws.messages.slice(previousMessageCount)).toEqual([
      expect.objectContaining({
        method: "session/update",
        params: expect.objectContaining({ sessionId: "ses-lifecycle-2" }),
      }),
    ]);
  });

  // connect 并发到达且初始化尚未完成时只能启动一个 Agent，两个 relay 均应获得就绪状态。
  test("concurrent connects share the in-flight initialization", async () => {
    const harness = createHarness(false);
    const firstWs = new FakeWs();
    const secondWs = new FakeWs();
    const firstConnect = open(harness, firstWs);
    const secondConnect = open(harness, secondWs);
    await waitUntil(() => harness.agents.length > 0 && harness.agents.every((agent) => agent.requests.length > 0));
    for (const agent of harness.agents) agent.initialize();
    await Promise.all([firstConnect, secondConnect]);
    expect(harness.agents).toHaveLength(1);
    for (const ws of [firstWs, secondWs]) {
      expect(ws.messages).toContainEqual(
        expect.objectContaining({ type: "status", payload: expect.objectContaining({ connected: true }) }),
      );
    }
  });

  // 只有实例真正停止才终止子进程；重复停止必须幂等，避免重复回收同一资源。
  test("server shutdown terminates the retained agent exactly once", async () => {
    const harness = createHarness();
    const ws = new FakeWs();
    await open(harness, ws);
    await newSession(harness, ws);
    disconnect(harness, ws);
    expect(harness.agents[0]?.killCount).toBe(0);
    const closing = harness.handle.close();
    expect(harness.handle.close()).toBe(closing);
    await closing;
    expect(harness.agents[0]?.killCount).toBe(0);
    expect(harness.agents[0]?.process.exitCode).toBe(0);
  });

  // 初始化中的旧页面关闭后，新 relay 应复用同一次启动，不能丢失初始化结果或再启动进程。
  test("disconnect during initialization does not invalidate a reconnecting relay", async () => {
    const harness = createHarness(false);
    const firstWs = new FakeWs();
    harness.handlers.open(firstWs);
    await harness.handlers.message(firstWs, JSON.stringify({ type: "connect" }));
    await waitUntil(() => (harness.agents[0]?.requests.length ?? 0) > 0);
    disconnect(harness, firstWs);
    const secondWs = new FakeWs();
    const secondConnect = open(harness, secondWs);
    await Bun.sleep(0);
    for (const agent of harness.agents) agent.initialize();
    await secondConnect;
    expect(harness.agents).toHaveLength(1);
    expect(harness.agents[0]?.killCount).toBe(0);
    await newSession(harness, secondWs);
    await prompt(harness, secondWs, "initialized-prompt");
  });

  // 实例在初始化完成前停止时必须释放进程，迟到的初始化不得让已停止实例恢复为就绪。
  test("shutdown during initialization prevents a late ready status", async () => {
    const harness = createHarness(false);
    const ws = new FakeWs();
    harness.handlers.open(ws);
    await harness.handlers.message(ws, JSON.stringify({ type: "connect" }));
    await waitUntil(() => (harness.agents[0]?.requests.length ?? 0) > 0);
    await harness.handle.close();
    expect(harness.agents[0]?.killCount).toBe(0);
    expect(harness.agents[0]?.process.exitCode).toBe(0);
    expect(
      ws.messages.some((message) => {
        const payload = message.payload as Record<string, unknown> | undefined;
        return message.type === "status" && payload?.connected === true;
      }),
    ).toBe(false);
  });

  // 共享初始化失败时新 relay 必须获得安全错误，即使原发起者已断开；随后重试应能重新启动。
  test("initialization failure reaches surviving relays and permits a clean retry", async () => {
    const harness = createHarness(false);
    const firstWs = new FakeWs();
    const secondWs = new FakeWs();
    harness.handlers.open(firstWs);
    await harness.handlers.message(firstWs, JSON.stringify({ type: "connect" }));
    harness.handlers.open(secondWs);
    await harness.handlers.message(secondWs, JSON.stringify({ type: "connect" }));
    await waitUntil(() => (harness.agents[0]?.requests.length ?? 0) > 0);
    disconnect(harness, firstWs);
    harness.agents[0]?.failInitialization();
    await waitUntil(() => secondWs.messages.some((message) => message.type === "error"));
    expect(JSON.stringify(secondWs.messages)).not.toContain("sensitive upstream details");
    expect(harness.agents[0]?.killCount).toBe(0);
    expect(harness.agents[0]?.process.exitCode).toBe(0);
    const retry = send(harness, secondWs, { type: "connect" });
    await waitUntil(() => (harness.agents[1]?.requests.length ?? 0) > 0);
    harness.agents[1]?.initialize();
    await retry;
    expect(harness.agents).toHaveLength(2);
  });

  // 单个 relay 发送失败必须隔离，不能让就绪广播终止共享 Agent 或阻断其他健康连接。
  test("a failing relay cannot terminate shared initialization for healthy relays", async () => {
    const harness = createHarness(false);
    const failedWs = new FakeWs();
    const healthyWs = new FakeWs();
    harness.handlers.open(failedWs);
    await harness.handlers.message(failedWs, JSON.stringify({ type: "connect" }));
    failedWs.failSend = true;
    const healthyConnect = open(harness, healthyWs);
    await waitUntil(() => (harness.agents[0]?.requests.length ?? 0) > 0);
    harness.agents[0]?.initialize();
    await healthyConnect;
    expect(harness.agents).toHaveLength(1);
    expect(harness.agents[0]?.killCount).toBe(0);
    await newSession(harness, healthyWs);
    await prompt(harness, healthyWs, "healthy-prompt");
  });
});
