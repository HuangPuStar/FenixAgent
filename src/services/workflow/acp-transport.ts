/**
 * ACP Transport 实现 — 将 workflow-engine 的 Transport 接口桥接到 RCS 的 ACP WebSocket 基础设施。
 *
 * 工作流程：
 * 1. connect() 通过 EnvironmentResolver 解析环境名称为 envId，必要时启动实例
 * 2. connect() 发送 session/create 创建会话
 * 3. execute() 发送 user 消息，通过 EventBus 收集完整会话流（assistant/tool_call/tool_result）
 * 4. 等待 prompt_complete 信号后拼接输出并返回 AgentResponse
 */

import type { AgentMessage, AgentRequest, AgentResponse, AgentSession, Transport } from "@fenix/workflow-engine";
import { nanoid } from "nanoid";
import { log } from "../../logger";
import { findAcpConnectionByAgentId, sendToAgentWs } from "../../transport/acp-ws-handler";
import type { SessionEvent } from "../../transport/event-bus";
import { getAcpEventBus } from "../../transport/event-bus";

// ---------- EnvironmentResolver 注入 ----------

/** Environment name → envId + ensureRunning 的回调 */
export interface EnvironmentResolver {
  /** 解析环境名称为 envId，如果环境不在线则自动启动 */
  resolve(name: string): Promise<{ envId: string; started: boolean }>;
}

/** 全局 Environment 解析器，由 createAcpTransport 时注入 */
let _environmentResolver: EnvironmentResolver | null = null;

/** 设置 Environment 解析器（per-engine 调用时注入） */
export function setEnvironmentResolver(resolver: EnvironmentResolver | null): void {
  _environmentResolver = resolver;
}

// ---------- 常量 ----------

/** 等待 session/create 响应的超时时间（30s） */
const SESSION_CREATE_TIMEOUT_MS = 30_000;

/** 等待 agent 执行响应的默认超时时间（10 分钟） */
const DEFAULT_EXECUTE_TIMEOUT_MS = 10 * 60 * 1000;

// ---------- 类型 ----------

/** session_update 消息中的 message 字段 */
interface SessionUpdateMessage {
  role: string;
  content?: string;
  tool_name?: string;
  [key: string]: unknown;
}

/** prompt_complete 消息中可能携带的元数据 */
interface PromptCompleteMetadata {
  model?: string;
  tokens?: { input: number; output: number };
  [key: string]: unknown;
}

// ---------- 辅助函数 ----------

/** 创建超时 Promise，超时时 reject 一个 AbortError */
function createTimeoutPromise<T>(ms: number, label: string): Promise<T> {
  return new Promise<T>((_, reject) => {
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
    const collectedMessages: AgentMessage[] = [];

    if (request.signal?.aborted) {
      throw new DOMException("Request aborted", "AbortError");
    }

    const bus = getAcpEventBus(this.agentId);
    // cleanupFn 在 subscribe 后设置，finally 中作为安全网调用
    let cleanupFn: (() => void) | null = null;

    try {
      return await new Promise<AgentResponse>((resolve, reject) => {
        let abortCleanup: (() => void) | null = null;
        let settled = false;

        // 执行超时定时器
        const timeoutTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanupFn = null;
          abortCleanup?.();
          reject(new DOMException(`Agent execute timed out after ${DEFAULT_EXECUTE_TIMEOUT_MS}ms`, "AbortError"));
        }, DEFAULT_EXECUTE_TIMEOUT_MS);
        if (typeof timeoutTimer.unref === "function") timeoutTimer.unref();

        const innerUnsub = bus.subscribe((event: SessionEvent) => {
          if (event.direction !== "inbound") return;

          const type = getPayloadType(event);
          const eventSessionId = getPayloadField<string>(event, "session_id");
          if (eventSessionId !== this.sessionId) return;

          switch (type) {
            case "session_update": {
              const message = getPayloadField<SessionUpdateMessage>(event, "message");
              if (!message) break;

              switch (message.role) {
                case "assistant": {
                  if (typeof message.content === "string") {
                    chunks.push(message.content);
                  }
                  collectedMessages.push({
                    role: "assistant",
                    content: message.content ?? "",
                  });
                  break;
                }
                case "tool_call": {
                  collectedMessages.push({
                    role: "tool_call",
                    content: message.content ?? "",
                    tool_name: message.tool_name,
                  });
                  break;
                }
                case "tool_result": {
                  collectedMessages.push({
                    role: "tool_result",
                    content: message.content ?? "",
                    tool_name: message.tool_name,
                  });
                  break;
                }
                case "user": {
                  collectedMessages.push({
                    role: "user",
                    content: message.content ?? "",
                  });
                  break;
                }
              }
              break;
            }

            case "prompt_complete": {
              if (settled) return;
              settled = true;
              cleanupFn = null;
              innerUnsub();
              abortCleanup?.();
              clearTimeout(timeoutTimer);
              const metadata = getPayloadField<PromptCompleteMetadata>(event, "metadata");
              const latencyMs = Date.now() - startTime;
              resolve({
                stdout: chunks.join(""),
                exit_code: 0,
                tokens: metadata?.tokens,
                model: metadata?.model,
                latency_ms: latencyMs,
                messages: collectedMessages,
              });
              break;
            }

            case "error": {
              if (settled) return;
              settled = true;
              cleanupFn = null;
              innerUnsub();
              abortCleanup?.();
              clearTimeout(timeoutTimer);
              const errorMsg =
                getPayloadField<string>(event, "message") ?? getPayloadField<string>(event, "error") ?? "";
              const existingChunks = chunks.join("");
              const stderr = errorMsg
                ? existingChunks
                  ? `${existingChunks}\n\n[Error] ${errorMsg}`
                  : `[Error] ${errorMsg}`
                : existingChunks;
              resolve({
                stdout: stderr,
                exit_code: 1,
                latency_ms: Date.now() - startTime,
                messages: collectedMessages,
              });
              break;
            }
          }
        });

        // 设置清理函数供 finally 安全网使用
        cleanupFn = () => {
          innerUnsub();
        };

        // 监听 AbortSignal
        if (request.signal) {
          const onAbort = () => {
            if (settled) return;
            settled = true;
            cleanupFn = null;
            innerUnsub();
            clearTimeout(timeoutTimer);
            reject(new DOMException("Request aborted", "AbortError"));
          };
          request.signal.addEventListener("abort", onAbort, { once: true });
          abortCleanup = () => request.signal?.removeEventListener("abort", onAbort);
        }

        // 构建并发送 user 消息（精简版：只传 prompt）
        const userMsg: Record<string, unknown> = {
          type: "user",
          session_id: this.sessionId,
          content: request.prompt,
        };

        const sent = sendToAgentWs(this.agentId, userMsg);
        if (!sent) {
          if (settled) return;
          settled = true;
          cleanupFn = null;
          innerUnsub();
          abortCleanup?.();
          clearTimeout(timeoutTimer);
          reject(new Error("Agent not found or offline"));
          return;
        }

        log(`[ACP-Transport] Sent user message: sessionId=${this.sessionId} promptLength=${request.prompt.length}`);
      });
    } finally {
      // 安全网：确保任何路径（包括意外异常）都清理订阅
      (cleanupFn as (() => void) | null)?.();
    }
  }
}

// ---------- AcpTransport ----------

/** ACP Transport 实现 — 通过 WebSocket 与 acp-link Agent 通信 */
class AcpTransport implements Transport {
  /**
   * 连接到指定 agent，创建 ACP 会话。
   * @param agentId - Environment name（如 "my-agent"），通过 EnvironmentResolver 解析为 envId
   * @param options.spawnedEnvIds - 收集启动的环境 ID（由调度器传入）
   */
  async connect(agentId: string, options?: { cwd?: string; spawnedEnvIds?: Set<string> }): Promise<AgentSession> {
    // 通过 EnvironmentResolver 解析环境名称
    let resolvedId = agentId;

    if (_environmentResolver) {
      const { envId, started } = await _environmentResolver.resolve(agentId);
      resolvedId = envId;
      if (started) {
        log(`[ACP-Transport] Started environment "${agentId}" → env "${envId}"`);
        // 记录到 spawnedEnvIds，供 workflow 结束后统一销毁
        options?.spawnedEnvIds?.add(envId);
      } else {
        log(`[ACP-Transport] Resolved environment "${agentId}" → env "${envId}" (already online)`);
      }
    } else {
      // 无 resolver 时直接按 agentId 查找（向后兼容）
      const conn = findAcpConnectionByAgentId(resolvedId);
      if (!conn) {
        throw new Error(`Agent not found or offline: ${agentId}`);
      }
    }

    // 确认连接存在
    const conn = findAcpConnectionByAgentId(resolvedId);
    if (!conn) {
      throw new Error(`Agent not found or offline after resolve: ${agentId} → ${resolvedId}`);
    }

    // 生成关联 ID 用于匹配 session/create 响应
    const correlationId = nanoid(12);
    const bus = getAcpEventBus(resolvedId);
    let unsub: (() => void) | null = null;

    const sessionId = await Promise.race<string>([
      createTimeoutPromise(SESSION_CREATE_TIMEOUT_MS, "session/create"),

      new Promise<string>((resolve, reject) => {
        unsub = bus.subscribe((event: SessionEvent) => {
          if (event.direction !== "inbound") return;

          const type = getPayloadType(event);

          if (type === "session/create") {
            const responseId = getPayloadField<string>(event, "id");
            if (responseId !== correlationId) return;

            const newSessionId = getPayloadField<string>(event, "session_id");
            if (!newSessionId) {
              reject(new Error("session/create response missing session_id"));
              return;
            }

            log(`[ACP-Transport] Session created: sessionId=${newSessionId} agentId=${resolvedId}`);
            resolve(newSessionId);
          }

          if (type === "agent_disconnect") {
            reject(new Error("Agent disconnected during session creation"));
          }
        });

        // 发送 session/create 消息
        const createMsg: Record<string, unknown> = {
          type: "session/create",
          id: correlationId,
        };

        const sent = sendToAgentWs(resolvedId, createMsg);
        if (!sent) {
          reject(new Error("Agent not found or offline"));
          return;
        }

        log(`[ACP-Transport] Sent session/create: agentId=${resolvedId} correlationId=${correlationId}`);
      }),
    ]).finally(() => {
      unsub?.();
    });

    return new AcpAgentSession(resolvedId, sessionId);
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
