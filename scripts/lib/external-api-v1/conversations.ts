import assert from "node:assert/strict";
import { field, type ManualRunner, object } from "./runner";

/** Preserve a single opaque OpenAI session across JSON → SSE → JSON turns. */
export async function testOpenAiConversation(runner: ManualRunner, agentId: string, instanceId: string): Promise<void> {
  const marker = `OPENAI_${crypto.randomUUID()}`;
  let sessionId = "";
  const prompts = [
    `请记住本次对话口令：${marker}。只回答“已记住”，不要调用工具。`,
    "本次对话上一轮的口令是什么？只输出完整口令，不要调用工具。",
    "再次输出我们第一轮约定的完整口令，不要调用工具。",
  ];
  for (const [round, content] of prompts.entries()) {
    const stream = round === 1;
    await runner.request("POST", "/api/v1/chat/completions", {
      native: true,
      stream,
      headers: { "X-Instance-Id": instanceId, ...(sessionId ? { "X-Session-Id": sessionId } : {}) },
      body: { model: agentId, messages: [{ role: "user", content }], stream, n: 1 },
      check: (data, headers) => {
        const next = headers.get("X-Session-Id");
        assert.ok(next, "缺少 X-Session-Id");
        if (sessionId) assert.equal(next, sessionId, "续聊错误地创建了新会话");
        sessionId = next;
        assert.equal(headers.get("X-Instance-Id"), instanceId);
        assert.ok(headers.get("X-Request-Id"), "缺少 X-Request-Id");
        assert.ok(Number.isFinite(Date.parse(headers.get("X-Session-Expires-At") ?? "")), "缺少有效会话过期时间");
        let answer: string;
        if (stream) {
          assert.equal(typeof data, "string");
          answer = String(data);
        } else {
          const result = object(data);
          assert.ok(Array.isArray(result.choices) && result.choices.length === 1);
          const choice = object(result.choices[0]);
          assert.equal(object(choice.message).role, "assistant");
          assert.ok(["stop", "length"].includes(String(choice.finish_reason)));
          answer = field(choice.message, "content");
        }
        if (round > 0) assert.ok(answer.includes(marker), "多轮对话没有记住第一轮口令");
      },
    });
  }
}

/** ACP relay client for manual probes; one connection owns only its sessions and pending RPCs. */
export class AcpProbe {
  private socket: WebSocket;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private sequence = 0;
  private output = "";
  private ready: Promise<void>;
  private rejectReady: (error: Error) => void = () => {};

  constructor(
    private runner: ManualRunner,
    wsUrl: string,
    private permission: "deny" | "allow_once",
  ) {
    const url = new URL(wsUrl, runner.config.baseUrl);
    assert.equal(url.origin, new URL(runner.config.baseUrl).origin, "拒绝向其他源发送 API Key");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    runner.print("WebSocket 输入", { url: url.href, authorization: "Bearer <redacted>" });
    this.socket = new WebSocket(url.href, { headers: { authorization: `Bearer ${runner.config.apiKey}` } });
    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject;
      this.socket.addEventListener("open", () => resolve(), { once: true });
    });
    // An early disconnect can precede the next interactive step attaching its waiter.
    void this.ready.catch(() => {});
    this.socket.addEventListener("message", (event) => {
      try {
        this.receive(JSON.parse(String(event.data)));
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        this.close();
      }
    });
    this.socket.addEventListener("error", () => this.fail(new Error("ACP WebSocket 连接错误")));
    this.socket.addEventListener("close", (event) => this.fail(new Error(`ACP WebSocket 已关闭: ${event.code}`)));
  }

  /** Wait for the authenticated relay socket before sending session/new. */
  async open(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("ACP WebSocket 建连超时")), this.runner.config.timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private fail(error: Error): void {
    this.rejectReady(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private send(message: unknown): void {
    this.runner.print("ACP 输入", message);
    this.socket.send(JSON.stringify(message));
  }

  private receive(message: unknown): void {
    this.runner.print("ACP 输出", message);
    const envelope = object(message);
    const rpc = object(envelope.jsonrpc ? envelope : (envelope.payload ?? {}));
    if (rpc.jsonrpc !== "2.0") return;
    if (rpc.method === "session/update") {
      const update = object(object(rpc.params).update);
      if (update.sessionUpdate === "agent_message_chunk") {
        const content = object(update.content);
        if (content.type === "text" && typeof content.text === "string") this.output += content.text;
      }
    }
    if (rpc.method === "session/request_permission") {
      const options = object(rpc.params).options;
      const option =
        this.permission === "allow_once" && Array.isArray(options)
          ? options.map(object).find((entry) => entry.kind === "allow_once")
          : undefined;
      this.send({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          outcome: option ? { outcome: "selected", optionId: field(option, "optionId") } : { outcome: "cancelled" },
        },
      });
    }
    if (typeof rpc.id === "number" && !rpc.method) {
      const pending = this.pending.get(rpc.id);
      if (!pending) return;
      this.pending.delete(rpc.id);
      if (rpc.error) pending.reject(new Error(`ACP error: ${JSON.stringify(rpc.error)}`));
      else pending.resolve(rpc.result);
    }
  }

  /** Send raw or wrapped JSON-RPC and wait for its terminal response, not just text chunks. */
  async rpc(method: string, params: unknown, wrapped = false): Promise<{ result: unknown; text: string }> {
    assert.equal(this.socket.readyState, WebSocket.OPEN, "ACP 连接不可用");
    const id = ++this.sequence;
    this.output = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP ${method} 超时`));
        }, this.runner.config.timeoutMs);
        this.pending.set(id, { resolve, reject });
        const message = { jsonrpc: "2.0", id, method, params };
        this.send(wrapped ? { type: "acp", payload: message } : message);
      });
      return { result, text: this.output };
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  /** Release this probe without stopping the persistent Agent runtime. */
  close(): void {
    this.fail(new Error("ACP 测试连接已释放"));
    this.socket.close();
  }
}

/** Test raw/wrapped ACP requests and three serial turns in the same ACP session. */
export async function testAcpConversation(
  runner: ManualRunner,
  wsUrl: string,
  permission: "deny" | "allow_once",
): Promise<void> {
  let probe: AcpProbe | undefined;
  try {
    await runner.step("ACP WebSocket 连接", async () => {
      probe = new AcpProbe(runner, wsUrl, permission);
      await probe.open();
    });
    const client = probe!;
    const sessionId = await runner.step("ACP session/new", async () =>
      field((await client.rpc("session/new", {})).result, "sessionId"),
    );
    const marker = `ACP_${crypto.randomUUID()}`;
    const prompts = [
      `请记住本次对话口令：${marker}。只回答“已记住”，不要调用工具。`,
      "本次对话上一轮的口令是什么？只输出完整口令，不要调用工具。",
      "再次输出我们第一轮约定的完整口令，不要调用工具。",
    ];
    for (const [round, text] of prompts.entries()) {
      await runner.step(`ACP session/prompt 第 ${round + 1} 轮`, async () => {
        const answer = await client.rpc(
          "session/prompt",
          { sessionId, content: [{ type: "text", text }] },
          round === 1,
        );
        assert.equal(object(answer.result).stopReason, "end_turn", "ACP 未正常完成本轮");
        assert.ok(answer.text.trim(), "ACP 没有回答");
        runner.print("聚合回答", answer.text);
        if (round > 0) assert.ok(answer.text.includes(marker), "ACP 多轮对话没有记住第一轮口令");
      });
    }
  } finally {
    probe?.close();
  }
}
