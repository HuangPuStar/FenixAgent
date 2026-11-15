import { extractJsonRpc } from "@fenix/chat-channel";
import { ACPPending, ACPProtocol } from "acp-link/client";
import * as z from "zod/v4";
import type { TemporaryE2eHttp, TemporaryE2eHttpConfig } from "./http";

/** ACP 测试连接配置；认证沿用 HTTP Key，不把凭据放进 URL。 */
interface AcpConfig extends TemporaryE2eHttpConfig {
  signal: AbortSignal;
  relayUrl: string;
}

/** 复用 acp-link 的协议解析和 pending 关联，仅适配公开 WebSocket 测试入口。 */
export class TemporaryE2eAcp {
  private readonly protocol = new ACPProtocol();
  private readonly pending = new ACPPending();
  private readonly socket: WebSocket;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly ready = new Promise<void>((resolve, reject) => {
    this.readyResolve = resolve;
    this.readyReject = reject;
  });
  private sequence = 0;
  private failure: Error | undefined;
  private sessionId = "";
  private text = "";
  private prompting = false;
  private closed = false;

  constructor(
    private readonly config: AcpConfig,
    private readonly log: TemporaryE2eHttp["log"],
  ) {
    const base = new URL(config.baseUrl);
    const url = new URL(config.relayUrl, base);
    url.protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
    if (url.origin !== base.origin || url.username || url.password) throw new Error("ACP relay 必须与 API 同源");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    log(`\n>>> WS [A/ACP] ${url.href}`);
    log({ Authorization: "Bearer <redacted>" });
    this.protocol.on("status", ({ connected }) => {
      if (connected) this.readyResolve();
    });
    this.protocol.on("error", ({ message }) => this.fail(new Error(`ACP: ${message}`)));
    this.protocol.on("rpc_response", ({ id, result }) => this.pending.tryResolve(id, result));
    this.protocol.on("session_update", ({ sessionId, update }) => {
      if (!this.prompting || sessionId !== this.sessionId) return;
      const chunk = z
        .object({
          sessionUpdate: z.literal("agent_message_chunk"),
          content: z.object({ type: z.literal("text"), text: z.string() }),
        })
        .safeParse(update);
      if (chunk.success) this.text += chunk.data.content.text;
    });
    this.protocol.on("permission_request", () => this.fail(new Error("ACP 会话请求工具授权；本测试要求纯文本回复")));
    this.protocol.on("interactive_question", () => this.fail(new Error("ACP 会话请求人工输入；本测试要求纯文本回复")));
    this.socket = new WebSocket(url, { headers: { Authorization: `Bearer ${config.apiKey}` } });
    this.socket.onmessage = ({ data }) => {
      try {
        const parsed: unknown = JSON.parse(String(data));
        log("<<< WS [A/ACP]");
        log(parsed);
        if (!parsed || typeof parsed !== "object") throw new Error("ACP 返回非法消息");
        const rpc = extractJsonRpc(parsed);
        if (rpc) {
          // 未知通知不进入 SDK 的裸 console 日志；所有帧已走上方统一脱敏。
          if (rpc.method && !["session/update", "session/request_permission"].includes(String(rpc.method))) return;
          this.protocol.handleMessage(JSON.stringify(rpc));
        } else if (
          "type" in parsed &&
          ["status", "error", "permission_request", "interactive_question"].includes(String(parsed.type))
        )
          this.protocol.handleMessage(JSON.stringify(parsed));
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    this.socket.onerror = () => this.fail(new Error("ACP WebSocket 连接错误"));
    this.socket.onclose = ({ code }) => {
      if (!this.closed) this.fail(new Error(`ACP WebSocket 提前关闭 (${code})`));
    };
  }

  /** 等待 Agent status 后只创建一次 ACP session；cwd 由服务端注入。 */
  async connect(): Promise<void> {
    await this.bounded(this.ready, "ACP status");
    const result = z.object({ sessionId: z.string().min(1) }).parse(await this.rpc("session/new", {}));
    this.sessionId = result.sessionId;
  }

  /** 在同一 ACP session 串行发送一轮，聚合正确 session 的文本并等待对应 RPC 终态。 */
  async prompt(text: string): Promise<string> {
    if (!this.sessionId || this.prompting) throw new Error("ACP session 未就绪或上一轮未结束");
    this.text = "";
    this.prompting = true;
    try {
      const result = z
        .object({ stopReason: z.literal("end_turn") })
        .parse(await this.rpc("session/prompt", { sessionId: this.sessionId, content: [{ type: "text", text }] }));
      if (!result || !this.text.trim()) throw new Error("ACP 未返回当前 session 的文本回复");
      return this.text;
    } finally {
      this.prompting = false;
    }
  }

  /** 结束 relay；失败或取消时先请求取消当前 turn，不停止共享 Runtime。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error("ACP 测试连接已释放"));
    this.socket.close(1000, "E2E complete");
    this.protocol.removeAllListeners();
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    if (this.prompting && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(
          JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } }),
        );
      } catch (cancelError) {
        this.log(
          `[FAIL] ACP 取消发送失败：${cancelError instanceof Error ? cancelError.message : String(cancelError)}`,
        );
      }
    }
    this.readyReject(error);
    this.pending.rejectAll(error);
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    if (this.failure) throw this.failure;
    const id = ++this.sequence;
    const request = { jsonrpc: "2.0", id, method, params };
    const response = this.bounded(this.pending.register<unknown>(id, request, 0), `ACP ${method}`);
    this.log(">>> WS [A/ACP]");
    this.log(request);
    try {
      this.socket.send(JSON.stringify(request));
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
    const result = await response;
    const error = z.object({ error: z.object({ message: z.string() }) }).safeParse(result);
    if (error.success) throw new Error(`ACP ${method}: ${error.data.error.message}`);
    return result;
  }

  private bounded<T>(operation: Promise<T>, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const error = new Error(`${label} 已取消`);
        this.fail(error);
        reject(error);
      };
      const timer = setTimeout(() => {
        const error = new Error(`${label} 超时`);
        this.fail(error);
        reject(error);
      }, this.config.timeoutMs);
      const clear = () => {
        clearTimeout(timer);
        this.config.signal.removeEventListener("abort", abort);
      };
      this.config.signal.addEventListener("abort", abort, { once: true });
      operation.then(
        (value) => {
          clear();
          resolve(value);
        },
        (error) => {
          clear();
          reject(error);
        },
      );
      if (this.config.signal.aborted) abort();
    });
  }
}
