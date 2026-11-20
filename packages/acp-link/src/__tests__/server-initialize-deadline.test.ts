// 本地 Agent initialize 卡住时的启动 deadline 回归：真实子进程 + 真实 SDK stdio，
// 只替换网络监听与 spawn 计数，覆盖超时收口、迟到结果、握手 EOF 与并发生成。
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { createAcpServer } from "../server.js";

// 受控 Agent：按 AGENT_TEST_MODE 决定 initialize 行为，stdin 结束即退出，便于 stopAgentProcess 快速收口。
const AGENT_SCRIPT = `
const mode = process.env.AGENT_TEST_MODE || "normal";
const initResult = {
  protocolVersion: 1,
  agentInfo: { name: "deadline-test", version: "1" },
  agentCapabilities: { loadSession: true },
};
let buffered = "";
let initializeId;
const respond = (id, result) => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
};
const respondInitialize = () => {
  if (initializeId !== undefined) respond(initializeId, initResult);
};
process.stdin.on("data", chunk => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\\n")) !== -1) {
    const request = JSON.parse(buffered.slice(0, newline));
    buffered = buffered.slice(newline + 1);
    if (request.id === undefined) continue;
    if (request.method === "initialize") {
      initializeId = request.id;
      if (mode === "hang") continue;
      if (mode === "eof") { require("node:fs").closeSync(1); continue; }
      if (mode === "late") continue;
      if (mode === "slow") { setTimeout(respondInitialize, 300); continue; }
      respondInitialize();
    } else if (request.method === "session/new") {
      respond(request.id, { sessionId: "ses-deadline" });
    }
  }
});
process.stdin.on("end", () => {
  // late 模式故意在 deadline 之后才返回 initialize，验证迟到结果不能把失败代恢复为就绪。
  if (mode === "late" && initializeId !== undefined) {
    setTimeout(() => {
      respondInitialize();
      setTimeout(() => process.exit(0), 30);
    }, 20);
    return;
  }
  process.exit(0);
});
`;

interface WsHandlers {
  open(ws: TestWs): void;
  message(ws: TestWs, message: string): Promise<void> | void;
  close(ws: TestWs): void;
}

class TestWs {
  readyState = 1;
  readonly messages: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.messages.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3;
  }

  ping(): void {}
}

interface Harness {
  handlers: WsHandlers;
  ws: TestWs;
  children: childProcess.ChildProcess[];
  handle: ReturnType<typeof createAcpServer>;
  send(ws: TestWs, message: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

const handles: Array<ReturnType<typeof createAcpServer>> = [];
const restoreSpies: Array<() => void> = [];

/** 真实子进程 + 真实 ACP SDK；spawn 只负责按顺序注入本次启动的行为模式。 */
function createHarness(options: { initializeTimeoutMs: number; modes: string[] }): Harness {
  let handlers: WsHandlers | undefined;
  const serveSpy = spyOn(Bun, "serve").mockImplementation(((serveOptions: { websocket: WsHandlers }) => {
    handlers = serveOptions.websocket;
    return { port: 0, stop() {}, reload() {} };
  }) as unknown as typeof Bun.serve);
  const realSpawn = childProcess.spawn;
  const children: childProcess.ChildProcess[] = [];
  const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(((
    command: string,
    args: readonly string[],
    spawnOptions: childProcess.SpawnOptions,
  ) => {
    const mode = options.modes[children.length] ?? "normal";
    const child = realSpawn(command, args as string[], {
      ...spawnOptions,
      env: { ...spawnOptions.env, AGENT_TEST_MODE: mode },
    });
    children.push(child);
    return child;
  }) as unknown as typeof childProcess.spawn);
  restoreSpies.push(() => spawnSpy.mockRestore());
  let handle: ReturnType<typeof createAcpServer>;
  try {
    handle = createAcpServer({
      port: 0,
      host: "127.0.0.1",
      command: process.execPath,
      args: ["--eval", AGENT_SCRIPT],
      cwd: process.cwd(),
      initializeTimeoutMs: options.initializeTimeoutMs,
    });
  } finally {
    serveSpy.mockRestore();
  }
  handles.push(handle);
  if (!handlers) throw new Error("WebSocket handlers 未注册");
  const ws = new TestWs();
  handlers.open(ws);
  return {
    handlers,
    ws,
    children,
    handle,
    send: (target, message) => handlers!.message(target, JSON.stringify(message)),
    close: () => handle.close(),
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("等待 Agent 状态超时");
    await Bun.sleep(1);
  }
}

function payloadOf(message: Record<string, unknown>): Record<string, unknown> | undefined {
  return message.payload as Record<string, unknown> | undefined;
}

function hasReadyStatus(messages: Array<Record<string, unknown>>): boolean {
  return messages.some((message) => message.type === "status" && payloadOf(message)?.connected === true);
}

function hasStartupError(messages: Array<Record<string, unknown>>): boolean {
  return messages.some((message) => message.type === "error");
}

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const restore of restoreSpies.splice(0)) restore();
});

describe("Agent initialize deadline", () => {
  // initialize 永不响应时，deadline 必须收口进程、解除 session/new 等待，重连能启动新一代。
  test("initialize 永不响应时 deadline 收口并允许重连启动新进程", async () => {
    const h = createHarness({ initializeTimeoutMs: 150, modes: ["hang", "normal"] });
    const startedAt = Date.now();
    const connect = h.send(h.ws, { type: "connect" });
    const session = h.send(h.ws, { jsonrpc: "2.0", id: "session", method: "session/new", params: {} });
    // 初始化在途时 session/new 必须等 deadline 收口后有界结束，而不是挂到 10s 等待或更久。
    await waitUntil(() => h.ws.messages.some((message) => message.id === "session"), 3000);
    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(h.ws.messages.find((message) => message.id === "session")).toMatchObject({
      error: { code: -32000 },
    });
    await Promise.all([connect, session]);
    await waitUntil(() => hasStartupError(h.ws.messages), 1000);
    expect(hasReadyStatus(h.ws.messages)).toBe(false);
    await waitUntil(() => h.children[0]?.exitCode !== null);

    const reconnect = h.send(h.ws, { type: "connect" });
    await waitUntil(() => hasReadyStatus(h.ws.messages));
    await reconnect;
    expect(h.children).toHaveLength(2);
    expect(h.children[1]?.exitCode).toBeNull();
    expect(h.children[1]?.pid).not.toBe(h.children[0]?.pid);
  }, 10_000);

  // 刚过 deadline 才返回的 initialize 不得把失败代广播为就绪，也不得阻止下一次启动。
  test("超过 deadline 才返回的 initialize 不会覆盖失败代", async () => {
    const h = createHarness({ initializeTimeoutMs: 120, modes: ["late", "normal"] });
    const connect = h.send(h.ws, { type: "connect" });
    await waitUntil(() => hasStartupError(h.ws.messages));
    await connect;
    await Bun.sleep(80);
    expect(hasReadyStatus(h.ws.messages)).toBe(false);
    await waitUntil(() => h.children[0]?.exitCode !== null);

    const reconnect = h.send(h.ws, { type: "connect" });
    await waitUntil(() => hasReadyStatus(h.ws.messages));
    await reconnect;
    expect(h.children).toHaveLength(2);
  }, 10_000);

  // 握手期间 stdout EOF 是终态：应立即失败而不必等满 deadline，且旧失败不能阻断重连。
  test("握手期间 stdout EOF 立即失败并可重连", async () => {
    const h = createHarness({ initializeTimeoutMs: 60_000, modes: ["eof", "normal"] });
    const startedAt = Date.now();
    const connect = h.send(h.ws, { type: "connect" });
    await waitUntil(() => hasStartupError(h.ws.messages));
    await connect;
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(hasReadyStatus(h.ws.messages)).toBe(false);
    await waitUntil(() => h.children[0]?.exitCode !== null);

    const reconnect = h.send(h.ws, { type: "connect" });
    await waitUntil(() => hasReadyStatus(h.ws.messages));
    await reconnect;
    expect(h.children).toHaveLength(2);
  }, 10_000);

  // 两个客户端同时 connect 只能创建一次启动，两者都应收到就绪状态。
  test("两个客户端同时 connect 共享同一次启动", async () => {
    const h = createHarness({ initializeTimeoutMs: 2000, modes: ["slow"] });
    const second = new TestWs();
    h.handlers.open(second);
    const firstConnect = h.send(h.ws, { type: "connect" });
    const secondConnect = h.send(second, { type: "connect" });
    await waitUntil(() => hasReadyStatus(h.ws.messages) && hasReadyStatus(second.messages));
    await Promise.all([firstConnect, secondConnect]);
    expect(h.children).toHaveLength(1);
    expect(h.children[0]?.exitCode).toBeNull();
  }, 10_000);

  // deadline 内完成的慢启动必须成功，不能把正常慢初始化误杀。
  test("deadline 内的慢初始化不会被误杀", async () => {
    const h = createHarness({ initializeTimeoutMs: 2000, modes: ["slow"] });
    const connect = h.send(h.ws, { type: "connect" });
    await waitUntil(() => hasReadyStatus(h.ws.messages));
    await connect;
    expect(h.children).toHaveLength(1);
    expect(h.children[0]?.exitCode).toBeNull();
    expect(hasStartupError(h.ws.messages)).toBe(false);
  }, 10_000);

  // 并发 connect 遇到卡死初始化时也必须一起收敛，并且只占一个进程配额；重连再换代。
  test("并在途初始化的两个客户端在 deadline 后一起收敛且只启动一次", async () => {
    const h = createHarness({ initializeTimeoutMs: 150, modes: ["hang", "normal"] });
    const second = new TestWs();
    h.handlers.open(second);
    const firstConnect = h.send(h.ws, { type: "connect" });
    const secondConnect = h.send(second, { type: "connect" });
    await waitUntil(() => hasStartupError(h.ws.messages) && hasStartupError(second.messages));
    await Promise.all([firstConnect, secondConnect]);
    expect(h.children).toHaveLength(1);

    const reconnect = h.send(second, { type: "connect" });
    await waitUntil(() => hasReadyStatus(second.messages));
    await reconnect;
    expect(h.children).toHaveLength(2);
  }, 10_000);
});
