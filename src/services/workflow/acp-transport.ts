/**
 * ACP Transport 实现 — workflow-engine Transport 接口的薄包装。
 *
 * 使用 JSON-RPC 2.0 协议与 acp-link 通信，复用 ACPProtocol 解析层，
 * 与前端 ACPClient 共享同一套协议逻辑。
 *
 * ACP 协议流程：
 * 1. relay 连接建立（由 ChannelFactory 完成），relay handle 自动发 connect
 * 2. 等待 acp-link 回传 status { connected: true }（agent 进程初始化完成）
 * 3. 发 session/new → 等待 JSON-RPC response（获得 sessionId）
 * 4. 发 session/prompt → 接收 session/update notification 流 → 等待 JSON-RPC response
 *
 * 分层：
 * - workflow/index.ts（服务层）：负责环境解析、实例启动、relay 连接
 * - acp-transport.ts（本文件）：仅封装 ACP 协议流程
 */

import type { AgentMessage, AgentRequest, AgentResponse, AgentSession, Transport } from "@fenix/workflow-engine";
import { ACPProtocol, type ProtocolEvents } from "acp-link/client";
import type { SessionUpdate } from "acp-link/types";

// ---------- JSON-RPC 2.0 工具（与 acp-link/json-rpc 对齐） ----------

/** ACP 方法名常量 — 与 acp-link/src/json-rpc.ts ACP_METHOD 保持一致 */
const METHOD = {
  SESSION_NEW: "session/new",
  SESSION_PROMPT: "session/prompt",
} as const;

let _nextRpcId = 0;

/** 生成自增 JSON-RPC 请求 id */
function nextRpcId(): number {
  _nextRpcId += 1;
  return _nextRpcId;
}

/** 构造 JSON-RPC 2.0 请求 */
function createRequest(
  method: string,
  params?: unknown,
): { jsonrpc: "2.0"; id: number; method: string; params: unknown } {
  return { jsonrpc: "2.0", id: nextRpcId(), method, params: params ?? {} };
}

// ---------- 消息通道抽象 ----------

/** 底层消息收发通道 — 不依赖具体实现 */
export interface AgentChannel {
  /** 发送消息到 agent */
  send(message: unknown): void;
  /** 订阅来自 agent 的消息，返回取消订阅函数 */
  onMessage(handler: (msg: Record<string, unknown>) => void): () => void;
}

/** 创建消息通道的工厂 — 由 RCS 服务层注入 */
export type ChannelFactory = (envName: string, options?: { spawnedEnvIds?: Set<string> }) => Promise<AgentChannel>;

// ---------- 注入点 ----------

let _channelFactory: ChannelFactory | null = null;

/** 注入通道工厂（由服务层调用） */
export function setChannelFactory(factory: ChannelFactory | null): void {
  _channelFactory = factory;
}

// ---------- 常量 ----------

/** 等待 agent 进程初始化完成（connect → status）的最大时间 */
const AGENT_INIT_TIMEOUT_MS = 120_000;
/** session/new JSON-RPC 握手超时（agent 冷启动可能需要加载模型、连接 MCP） */
const NEW_SESSION_TIMEOUT_MS = 120_000;
/** session/prompt 执行超时 */
const DEFAULT_EXECUTE_TIMEOUT_MS = 10 * 60 * 1000;

// ---------- 辅助函数 ----------

/** 将 relay handle 传来的已解析对象喂给 ACPProtocol（它期望 JSON 字符串输入） */
function feedProtocol(protocol: ACPProtocol, msg: Record<string, unknown>): void {
  protocol.handleMessage(JSON.stringify(msg));
}

// ---------- AcpAgentSession ----------

/** 基于 AgentChannel 的 Agent 会话 — 使用 JSON-RPC 2.0 协议 */
class AcpAgentSession implements AgentSession {
  private readonly sessionId: string;
  private readonly channel: AgentChannel;
  private readonly protocol: ACPProtocol;

  constructor(channel: AgentChannel, sessionId: string, protocol: ACPProtocol) {
    this.channel = channel;
    this.sessionId = sessionId;
    this.protocol = protocol;
  }

  async execute(request: AgentRequest): Promise<AgentResponse> {
    const startTime = Date.now();
    const chunks: string[] = [];
    const collectedMessages: AgentMessage[] = [];

    if (request.signal?.aborted) {
      throw new DOMException("Request aborted", "AbortError");
    }

    // 监听 session/update notification 收集流式输出
    const updateHandler = (payload: ProtocolEvents["session_update"]): void => {
      collectSessionUpdate(payload.update, chunks, collectedMessages);
    };

    this.protocol.on("session_update", updateHandler);

    let cleanupFn: (() => void) | null = () => {
      this.protocol.off("session_update", updateHandler);
    };

    try {
      return await new Promise<AgentResponse>((resolve, reject) => {
        let settled = false;
        let abortCleanup: (() => void) | null = null;

        // 执行超时兜底
        const timeoutTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanupFn = null;
          abortCleanup?.();
          console.error(
            `[workflow] Agent execute timed out after ${DEFAULT_EXECUTE_TIMEOUT_MS}ms: sessionId=${this.sessionId}`,
          );
          reject(new DOMException(`Agent execute timed out after ${DEFAULT_EXECUTE_TIMEOUT_MS}ms`, "AbortError"));
        }, DEFAULT_EXECUTE_TIMEOUT_MS);
        if (typeof timeoutTimer.unref === "function") timeoutTimer.unref();

        // 发送 session/prompt JSON-RPC 请求
        const promptId = nextRpcId();
        // 字段名必须用 content（与 acp-link server handlePrompt 的 params.content 对齐）
        const promptReq = createRequest(METHOD.SESSION_PROMPT, {
          content: [{ type: "text", text: request.prompt }],
        });

        // 监听 JSON-RPC 响应（匹配 prompt 请求 id）
        const rpcHandler = (payload: ProtocolEvents["rpc_response"]): void => {
          if (payload.id !== promptId) return;
          if (settled) return;
          settled = true;
          cleanupFn = null;
          this.protocol.off("rpc_response", rpcHandler);
          this.protocol.off("error", errorHandler);
          abortCleanup?.();
          clearTimeout(timeoutTimer);

          const result = payload.result as Record<string, unknown> | null;

          // JSON-RPC error response：result 本身包含 error 字段
          if (result && "error" in result) {
            const errObj = result.error as Record<string, unknown>;
            const errorMsg = (errObj.message as string) ?? "Agent error";
            const existing = chunks.join("");
            resolve({
              stdout: existing ? `${existing}\n\n[Error] ${errorMsg}` : `[Error] ${errorMsg}`,
              exit_code: 1,
              latency_ms: Date.now() - startTime,
              messages: collectedMessages,
            });
            return;
          }

          const stopReason = (result?.stopReason as string) ?? "end_turn";
          const usage = result?.usage as
            | { totalTokens?: number; inputTokens?: number; outputTokens?: number }
            | undefined;

          // stopReason 为 error 视为执行失败
          if (stopReason === "error") {
            const existing = chunks.join("");
            resolve({
              stdout: existing || "Agent returned error stop reason",
              exit_code: 1,
              latency_ms: Date.now() - startTime,
              messages: collectedMessages,
            });
            return;
          }

          resolve({
            stdout: chunks.join(""),
            exit_code: 0,
            tokens: usage ? { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 } : undefined,
            latency_ms: Date.now() - startTime,
            messages: collectedMessages,
          });
        };

        // 监听传输层 error（relay 断连等）
        const errorHandler = (payload: ProtocolEvents["error"]): void => {
          if (settled) return;
          settled = true;
          cleanupFn = null;
          this.protocol.off("rpc_response", rpcHandler);
          this.protocol.off("error", errorHandler);
          abortCleanup?.();
          clearTimeout(timeoutTimer);

          const existing = chunks.join("");
          const stderr = payload.message
            ? existing
              ? `${existing}\n\n[Error] ${payload.message}`
              : `[Error] ${payload.message}`
            : existing;
          resolve({
            stdout: stderr,
            exit_code: 1,
            latency_ms: Date.now() - startTime,
            messages: collectedMessages,
          });
        };

        this.protocol.on("rpc_response", rpcHandler);
        this.protocol.on("error", errorHandler);

        // Abort signal 支持
        if (request.signal) {
          const onAbort = (): void => {
            if (settled) return;
            settled = true;
            cleanupFn = null;
            this.protocol.off("rpc_response", rpcHandler);
            this.protocol.off("error", errorHandler);
            clearTimeout(timeoutTimer);
            reject(new DOMException("Request aborted", "AbortError"));
          };
          request.signal.addEventListener("abort", onAbort, { once: true });
          abortCleanup = () => request.signal?.removeEventListener("abort", onAbort);
        }

        this.channel.send(promptReq);
        console.error(
          `[workflow] ACP sent prompt: sessionId=${this.sessionId} promptLength=${request.prompt.length} rpcId=${promptId}`,
        );
      });
    } finally {
      (cleanupFn as (() => void) | null)?.();
    }
  }
}

// ---------- Session update 收集 ----------

/** 从 session/update notification 中提取文本和工具调用信息 */
function collectSessionUpdate(update: SessionUpdate, chunks: string[], messages: AgentMessage[]): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = (update.content as { text?: string }).text ?? "";
      if (text) chunks.push(text);
      messages.push({ role: "assistant", content: text });
      break;
    }
    case "tool_call": {
      const title = update.title;
      const status = update.status;
      messages.push({
        role: "tool_call",
        content: `${title} (${status})`,
        tool_name: title,
      });
      break;
    }
    case "user_message_chunk": {
      const text = (update.content as { text?: string }).text ?? "";
      if (text) messages.push({ role: "user", content: text });
      break;
    }
  }
}

// ---------- AcpTransport ----------

class AcpTransport implements Transport {
  async connect(agentId: string, options?: { cwd?: string; spawnedEnvIds?: Set<string> }): Promise<AgentSession> {
    if (!_channelFactory) {
      console.error("[workflow] ACP connect FAILED: no channel factory configured");
      throw new Error("No channel factory configured for ACP Transport");
    }

    console.error(`[workflow] ACP connect start: agentId=${agentId}`);

    let channel: AgentChannel;
    try {
      channel = await _channelFactory(agentId, { spawnedEnvIds: options?.spawnedEnvIds });
    } catch (err) {
      console.error(`[workflow] ACP channelFactory FAILED: agentId=${agentId}`, err);
      throw err;
    }

    console.error(`[workflow] ACP channel ready: agentId=${agentId}`);

    // 创建协议解析器
    const protocol = new ACPProtocol();

    // 关键：先注册 status 监听器，再挂载 channel.onMessage()。
    // relay handle 会在首次 onMessage 时同步 flush buffer，
    // 如果 status 消息已被缓冲，它会立即投递到 ACPProtocol。
    // 此时 status 监听器必须已就位，否则事件会被丢弃。
    const readyPromise = this.waitForAgentReady(protocol, agentId);

    // 挂载 channel 消息 → protocol（可能同步触发 buffer flush，投递已缓冲的 status）
    const unsub = channel.onMessage((msg) => feedProtocol(protocol, msg));

    // 主动发 connect 确保 acp-link 回传 status。
    // 场景 1（新 relay handle）：relay handle onopen 已发过 connect，这里多发一次，
    //   handleConnect 检测到 state.connection 已设（同步赋值在 await init 之前），
    //   会立即回传 status { connected: true }，waitForAgentReady 提前 resolve，
    //   后续 session/new 请求在 ndjson 流中排队，agent 处理完 init 后自然处理。
    // 场景 2（复用 relay handle）：前一次连接的 status 早已消费，不发 connect 则
    //   永远等不到 status → 120s 超时 → "Node cancelled"。
    //   发 connect 后 handleConnect 检测到 agent 已初始化，直接重发完整 status。
    try {
      channel.send({ type: "connect" });
      console.error(`[workflow] ACP sent connect trigger: agentId=${agentId}`);
    } catch (err) {
      console.error(`[workflow] ACP send connect FAILED: agentId=${agentId}`, err);
      unsub();
      throw err;
    }

    try {
      // 阶段 1：等待 agent 初始化完成（status { connected: true }）
      await readyPromise;

      // 阶段 2：发 session/new → 等待 JSON-RPC response
      const sessionId = await this.createNewSession(channel, protocol, agentId, options?.cwd);

      console.error(`[workflow] ACP session created: agentId=${agentId} sessionId=${sessionId}`);
      return new AcpAgentSession(channel, sessionId, protocol);
    } catch (err) {
      console.error(`[workflow] ACP connect FAILED: agentId=${agentId}`, err);
      // 连接失败时清理 protocol 订阅
      unsub();
      throw err;
    }
  }

  /** 等待 acp-link 回传 status { connected: true }，表示 agent 进程已就绪 */
  private waitForAgentReady(protocol: ACPProtocol, agentId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        protocol.off("status", handler);
        console.error(`[workflow] ACP waitForAgentReady TIMEOUT after ${AGENT_INIT_TIMEOUT_MS}ms: agentId=${agentId}`);
        reject(new DOMException(`Agent init timed out after ${AGENT_INIT_TIMEOUT_MS}ms`, "AbortError"));
      }, AGENT_INIT_TIMEOUT_MS);
      if (typeof timeout.unref === "function") timeout.unref();

      const handler = (payload: ProtocolEvents["status"]): void => {
        console.error(`[workflow] ACP received status: agentId=${agentId} connected=${payload.connected}`);
        if (payload.connected) {
          clearTimeout(timeout);
          protocol.off("status", handler);
          resolve();
        }
      };

      protocol.on("status", handler);
    });
  }

  /** 发送 session/new JSON-RPC 请求并等待响应 */
  private createNewSession(
    channel: AgentChannel,
    protocol: ACPProtocol,
    agentId: string,
    cwd?: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        protocol.off("rpc_response", rpcHandler);
        protocol.off("error", errorHandler);
        console.error(`[workflow] ACP session/new TIMEOUT after ${NEW_SESSION_TIMEOUT_MS}ms: agentId=${agentId}`);
        reject(new DOMException(`session/new timed out after ${NEW_SESSION_TIMEOUT_MS}ms`, "AbortError"));
      }, NEW_SESSION_TIMEOUT_MS);
      if (typeof timeout.unref === "function") timeout.unref();

      const reqId = nextRpcId();

      const rpcHandler = (payload: ProtocolEvents["rpc_response"]): void => {
        if (payload.id !== reqId) return;
        clearTimeout(timeout);
        protocol.off("rpc_response", rpcHandler);
        protocol.off("error", errorHandler);

        const result = payload.result as Record<string, unknown> | null;

        // JSON-RPC error response
        if (result && "error" in result) {
          const errObj = result.error as Record<string, unknown>;
          const msg = (errObj.message as string) ?? "session/new failed";
          console.error(`[workflow] ACP session/new error response: agentId=${agentId} error=${msg}`);
          reject(new Error(msg));
          return;
        }

        const sid = result?.sessionId as string | undefined;
        if (!sid) {
          console.error(`[workflow] ACP session/new missing sessionId: agentId=${agentId}`);
          reject(new Error("session/new response missing sessionId"));
          return;
        }
        resolve(sid);
      };

      const errorHandler = (payload: ProtocolEvents["error"]): void => {
        clearTimeout(timeout);
        protocol.off("rpc_response", rpcHandler);
        protocol.off("error", errorHandler);
        console.error(`[workflow] ACP session/new transport error: agentId=${agentId} msg=${payload.message}`);
        reject(new Error(payload.message ?? "session/new error"));
      };

      protocol.on("rpc_response", rpcHandler);
      protocol.on("error", errorHandler);

      const req = createRequest(METHOD.SESSION_NEW, { cwd });
      channel.send(req);
      console.error(`[workflow] ACP sent session/new: agentId=${agentId} rpcId=${reqId}`);
    });
  }

  isReady(): boolean {
    return true;
  }
}

// ---------- 工厂函数 ----------

export function createAcpTransport(): Transport {
  return new AcpTransport();
}
