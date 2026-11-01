import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createAcpServer, type ServerConfig } from "../server";

// 独立子进程模拟最小 ACP Agent，保留真实 SDK、stdio、初始化与关闭流程。
const AGENT_SCRIPT = `
let buffered = "";
process.stdin.on("data", chunk => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\\n")) !== -1) {
    const request = JSON.parse(buffered.slice(0, newline));
    buffered = buffered.slice(newline + 1);
    if (request.id === undefined) continue;
    const result = request.method === "initialize"
      ? { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } }
      : request.method === "session/new"
        ? { sessionId: "ses-adapter" }
        : request.method === "session/resume"
          ? { configOptions: [] }
          : { stopReason: "end_turn" };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
  }
});
process.stdin.on("end", () => process.exit(0));
`;

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

interface WsHandlers {
  open(ws: TestWs): void;
  message(ws: TestWs, message: string): Promise<void> | void;
}

const handles: Array<ReturnType<typeof createAcpServer>> = [];

/** 用真实 Agent 子进程驱动 server，仅替换网络监听以便断言协议输出。 */
function createHarness(adaptConnection?: ServerConfig["adaptConnection"]) {
  let handlers: WsHandlers | undefined;
  const serveSpy = spyOn(Bun, "serve").mockImplementation(((options: { websocket: WsHandlers }) => {
    handlers = options.websocket;
    return { port: 0, stop() {}, reload() {} };
  }) as unknown as typeof Bun.serve);
  try {
    handles.push(
      createAcpServer({
        port: 0,
        host: "127.0.0.1",
        command: process.execPath,
        args: ["--eval", AGENT_SCRIPT],
        cwd: process.cwd(),
        adaptConnection,
      }),
    );
  } finally {
    serveSpy.mockRestore();
  }
  if (!handlers) throw new Error("WebSocket handlers were not registered");
  const ws = new TestWs();
  handlers.open(ws);
  return { ws, send: (message: Record<string, unknown>) => handlers.message(ws, JSON.stringify(message)) };
}

/** 等待真实 SDK 异步响应，同时为协议或关闭故障提供明确的超时边界。 */
async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Agent response timed out");
    await Bun.sleep(1);
  }
}

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
});

describe("acp-link 可选连接适配", () => {
  // 使用真实 SDK 和 stdio 验证 WS resume 入口，不让旧方法名的测试替身掩盖问题。
  test("通过标准 SDK 恢复会话后可继续 prompt", async () => {
    const h = createHarness();
    await h.send({ type: "connect" });
    await waitUntil(() => h.ws.messages.some((message) => message.type === "status"));
    await h.send({ jsonrpc: "2.0", id: 11, method: "session/resume", params: { sessionId: "ses-history" } });
    await waitUntil(() => h.ws.messages.some((message) => message.id === 11));
    expect(h.ws.messages.find((message) => message.id === 11)).toMatchObject({ result: { sessionId: "ses-history" } });

    await h.send({
      jsonrpc: "2.0",
      id: 12,
      method: "session/prompt",
      params: { sessionId: "ses-history", content: [] },
    });
    await waitUntil(() => h.ws.messages.some((message) => message.id === 12));
    expect(h.ws.messages.find((message) => message.id === 12)).toMatchObject({ result: { stopReason: "end_turn" } });
  });

  // 适配返回的新连接必须用于后续协议操作，不能丢弃返回值或破坏 SDK 的上下文。
  test("使用适配后的连接完成新建与 prompt", async () => {
    const h = createHarness(
      (connection) =>
        new Proxy(connection, {
          get(target, property) {
            if (property === "newSession")
              return async (params: Parameters<typeof connection.newSession>[0]) => ({
                ...(await target.newSession(params)),
                _meta: { adapted: true },
              });
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    );
    await h.send({ type: "connect" });
    await waitUntil(() => h.ws.messages.some((message) => message.type === "status"));
    await h.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    await waitUntil(() => h.ws.messages.some((message) => message.id === 1));
    expect(h.ws.messages.find((message) => message.id === 1)).toMatchObject({ result: { _meta: { adapted: true } } });
    await h.send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "ses-adapter", content: [] },
    });
    await waitUntil(() => h.ws.messages.some((message) => message.id === 2));
    expect(h.ws.messages.find((message) => message.id === 2)).toMatchObject({ result: { stopReason: "end_turn" } });
  });

  // 其他实例不设置适配器时继续使用原始 SDK，不继承前一个实例的定制。
  test("未启用适配时保持原始结果", async () => {
    const h = createHarness();
    await h.send({ type: "connect" });
    await waitUntil(() => h.ws.messages.some((message) => message.type === "status"));
    await h.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    await waitUntil(() => h.ws.messages.some((message) => message.id === 1));
    const result = h.ws.messages.find((message) => message.id === 1)?.result as Record<string, unknown>;
    expect(result.sessionId).toBe("ses-adapter");
    expect(result._meta).toBeUndefined();
  });

  // 适配异常必须沿用启动失败清理，SDK 连接和子进程都应关闭。
  test("适配失败关闭底层连接并报告启动错误", async () => {
    let connectionClosed = false;
    const h = createHarness((connection) => {
      connection.closed.then(() => {
        connectionClosed = true;
      });
      throw new Error("Connection adaptation failed");
    });
    await h.send({ type: "connect" });
    await waitUntil(() => connectionClosed && h.ws.messages.some((message) => message.type === "error"));
    expect(
      h.ws.messages.some(
        (message) => message.type === "status" && (message.payload as Record<string, unknown>)?.connected === true,
      ),
    ).toBe(false);
  });
});
