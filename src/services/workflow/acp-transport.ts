/**
 * ACP Transport 实现 — 将 workflow-engine 的 Transport 接口桥接到 RCS 的 ACP WebSocket 基础设施。
 *
 * 工作流程：
 * 1. connect() 检查 agent 在线状态，发送 session/create 创建会话
 * 2. execute() 发送 user 消息，通过 EventBus 收集 assistant 响应
 * 3. 等待 prompt_complete 信号后拼接输出并返回 AgentResponse
 */

import type { AgentRequest, AgentResponse, AgentSession, Transport } from "@fenix/workflow-engine";
import { nanoid } from "nanoid";
import { log } from "../../logger";
import type { SessionEvent } from "../../transport/event-bus";
import { getAcpEventBus } from "../../transport/event-bus";
import { sendToAgentWs } from "../../transport/relay";

// ---------- 常量 ----------

/** 等待 session/create 响应的超时时间（30s） */
const SESSION_CREATE_TIMEOUT_MS = 30_000;

// ---------- 类型 ----------

/** session_update 消息中的 message 字段 */
interface SessionUpdateMessage {
  role: string;
  content?: string;
  [key: string]: unknown;
}

/** prompt_complete 消息中可能携带的元数据 */
interface PromptCompleteMetadata {
  model?: string;
  tokens?: { input: number; output: number };
  [key: string]: unknown;
}

// ---------- 辅助函数 ----------

/** 创建超时 Promise，超时时抛出 AbortError */
function createTimeoutPromise(ms: number, label: string): Promise<never> {
  return new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new DOMException(`${label} timed out after ${ms}ms`, "AbortError"));
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

/** 从 SessionEvent 的 payload 中提取 type 字段 */
function getPayloadType(event: SessionEvent): string {
  const payload = event.payload;
  if (payload && typeof payload === "object" && "type" in payload) {
    return String((payload as Record<string, unknown>).type);
  }
  return "";
}

/** 从 SessionEvent 的 payload 中提取指定字段 */
function getPayloadField<T>(event: SessionEvent, field: string): T | undefined {
  const payload = event.payload;
  if (payload && typeof payload === "object" && field in payload) {
    return (payload as Record<string, unknown>)[field] as T;
  }
}

// ---------- AcpAgentSession ----------

/** 基于 ACP WebSocket 的 Agent 会话实现 */
class AcpAgentSession implements AgentSession {
  private readonly sessionId: string;
  private readonly agentId: string;

  constructor(agentId: string, sessionId: string) {
    this.agentId = agentId;
    this.sessionId = sessionId;
  }

  async execute(request: AgentRequest): Promise<AgentResponse> {
    const startTime = Date.now();
    const chunks: string[] = [];

    if (request.signal?.aborted) {
      throw new DOMException("Request aborted", "AbortError");
    }

    const bus = getAcpEventBus(this.agentId);
    // 先创建一个空订阅占位，确保 finally 中可以安全调用
    const unsub = bus.subscribe(() => {});

    try {
      unsub(); // 立即释放占位订阅

      return await new Promise<AgentResponse>((resolve, reject) => {
        let abortCleanup: (() => void) | null = null;

        const innerUnsub = bus.subscribe((event: SessionEvent) => {
          if (event.direction !== "inbound") return;

          const type = getPayloadType(event);
          const eventSessionId = getPayloadField<string>(event, "session_id");
          if (eventSessionId !== this.sessionId) return;

          switch (type) {
            case "session_update": {
              const message = getPayloadField<SessionUpdateMessage>(event, "message");
              if (message?.role === "assistant" && typeof message.content === "string") {
                chunks.push(message.content);
              }
              break;
            }

            case "prompt_complete": {
              const metadata = getPayloadField<PromptCompleteMetadata>(event, "metadata");
              const latencyMs = Date.now() - startTime;
              innerUnsub();
              abortCleanup?.();
              resolve({
                stdout: chunks.join(""),
                exit_code: 0,
                tokens: metadata?.tokens,
                model: metadata?.model,
                latency_ms: latencyMs,
              });
              break;
            }

            case "error": {
              innerUnsub();
              abortCleanup?.();
              resolve({
                stdout: chunks.join(""),
                exit_code: 1,
                latency_ms: Date.now() - startTime,
              });
              break;
            }
          }
        });

        // 监听 AbortSignal
        if (request.signal) {
          const onAbort = () => {
            innerUnsub();
            reject(new DOMException("Request aborted", "AbortError"));
          };
          request.signal.addEventListener("abort", onAbort, { once: true });
          abortCleanup = () => request.signal?.removeEventListener("abort", onAbort);
        }

        // 构建并发送 user 消息
        const userMsg: Record<string, unknown> = {
          type: "user",
          session_id: this.sessionId,
          content: request.prompt,
        };
        if (request.skill) {
          userMsg.skill = request.skill;
        }
        if (request.cwd) {
          userMsg.cwd = request.cwd;
        }

        const sent = sendToAgentWs(this.agentId, userMsg);
        if (!sent) {
          innerUnsub();
          abortCleanup?.();
          reject(new Error("Agent not found or offline"));
          return;
        }

        log(`[ACP-Transport] Sent user message: sessionId=${this.sessionId} promptLength=${request.prompt.length}`);
      });
    } finally {
      unsub();
    }
  }
}

// ---------- AcpTransport ----------

/** ACP Transport 实现 — 通过 WebSocket 与 acp-link Agent 通信 */
class AcpTransport implements Transport {
  /**
   * 连接到指定 agent，创建 ACP 会话。
   * @param agentId - agent 环境 ID（如 env_xxx）
   * @param options.cwd - 可选的工作目录，传递给 session/create
   */
  async connect(agentId: string, options?: { cwd?: string }): Promise<AgentSession> {
    // 检查 agent 在线状态
    const { findMachineConnectionByAgentId } = await import("../../transport/acp-ws-handler");
    const conn = await findMachineConnectionByAgentId(agentId);
    if (!conn) {
      throw new Error(`Agent not found or offline: ${agentId}`);
    }

    // 生成关联 ID 用于匹配 session/create 响应
    const correlationId = nanoid(12);
    const bus = getAcpEventBus(agentId);
    let unsub: (() => void) | null = null;

    const sessionId = await Promise.race([
      createTimeoutPromise(SESSION_CREATE_TIMEOUT_MS, "session/create"),

      new Promise<string>((resolve, reject) => {
        unsub = bus.subscribe((event: SessionEvent) => {
          if (event.direction !== "inbound") return;

          const type = getPayloadType(event);

          if (type === "session/create") {
            // 匹配关联 ID：检查 payload 中的 id 字段
            const responseId = getPayloadField<string>(event, "id");
            if (responseId !== correlationId) return;

            const newSessionId = getPayloadField<string>(event, "session_id");
            if (!newSessionId) {
              reject(new Error("session/create response missing session_id"));
              return;
            }

            log(`[ACP-Transport] Session created: sessionId=${newSessionId} agentId=${agentId}`);
            resolve(newSessionId);
          }

          // agent 断连
          if (type === "agent_disconnect") {
            reject(new Error("Agent disconnected during session creation"));
          }
        });

        // 发送 session/create 消息
        const createMsg: Record<string, unknown> = {
          type: "session/create",
          id: correlationId,
        };
        if (options?.cwd) {
          createMsg.cwd = options.cwd;
        }

        const sent = sendToAgentWs(agentId, createMsg);
        if (!sent) {
          reject(new Error("Agent not found or offline"));
          return;
        }

        log(`[ACP-Transport] Sent session/create: agentId=${agentId} correlationId=${correlationId}`);
      }),
    ]).finally(() => {
      unsub?.();
    });

    return new AcpAgentSession(agentId, sessionId);
  }

  /** 检查 Transport 是否可用 */
  isReady(): boolean {
    return true;
  }
}

// ---------- 工厂函数 ----------

/** 创建 ACP Transport 实例 */
export function createAcpTransport(): Transport {
  return new AcpTransport();
}
