/**
 * ACP Transport 实现 — workflow-engine Transport 接口的薄包装。
 *
 * 职责：
 * - 仅负责 ACP 协议（new_session → prompt → session_update 流 → prompt_complete）
 * - 不关心底层是 relay / WebSocket / EventBus
 * - 底层通信由注入的 ChannelFactory 回调提供
 *
 * ACP 协议流程（relay 模式）：
 * 1. relay 连接建立（由 ChannelFactory 完成），acp-link 自动发 connect → status
 * 2. 发 new_session → 等待 session_created（获得真实 sessionId）
 * 3. 发 prompt → 接收 session_update 流 → 等待 prompt_complete
 *
 * 分层：
 * - workflow/index.ts（服务层）：负责环境解析、实例启动、relay 连接
 * - acp-transport.ts（本文件）：仅封装 ACP 协议流程
 */

import type { AgentMessage, AgentRequest, AgentResponse, AgentSession, Transport } from "@fenix/workflow-engine";
import { log } from "../../logger";

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

const NEW_SESSION_TIMEOUT_MS = 30_000;
const DEFAULT_EXECUTE_TIMEOUT_MS = 10 * 60 * 1000;

// ---------- 辅助函数 ----------

function getField<T>(obj: unknown, field: string): T | undefined {
  if (obj && typeof obj === "object" && field in obj) {
    return (obj as Record<string, unknown>)[field] as T;
  }
}

// ---------- AcpAgentSession ----------

/** 基于 AgentChannel 的 Agent 会话 — 只做 ACP 协议 */
class AcpAgentSession implements AgentSession {
  private readonly sessionId: string;
  private readonly channel: AgentChannel;

  constructor(channel: AgentChannel, sessionId: string) {
    this.channel = channel;
    this.sessionId = sessionId;
  }

  async execute(request: AgentRequest): Promise<AgentResponse> {
    const startTime = Date.now();
    const chunks: string[] = [];
    const collectedMessages: AgentMessage[] = [];

    if (request.signal?.aborted) {
      throw new DOMException("Request aborted", "AbortError");
    }

    let cleanupFn: (() => void) | null = null;

    try {
      return await new Promise<AgentResponse>((resolve, reject) => {
        let abortCleanup: (() => void) | null = null;
        let settled = false;

        const timeoutTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanupFn = null;
          abortCleanup?.();
          reject(new DOMException(`Agent execute timed out after ${DEFAULT_EXECUTE_TIMEOUT_MS}ms`, "AbortError"));
        }, DEFAULT_EXECUTE_TIMEOUT_MS);
        if (typeof timeoutTimer.unref === "function") timeoutTimer.unref();

        const unsub = this.channel.onMessage((msg) => {
          const type = getField<string>(msg, "type") ?? "";

          switch (type) {
            // { type: "session_update", payload: { sessionId, update: { sessionUpdate, ... } } }
            case "session_update": {
              const payload = getField<Record<string, unknown>>(msg, "payload");
              if (!payload) break;

              const update = getField<Record<string, unknown>>(payload, "update");
              if (!update) break;

              const sessionUpdate = getField<string>(update, "sessionUpdate") ?? "";

              switch (sessionUpdate) {
                case "agent_message_chunk": {
                  const content = getField<Record<string, unknown>>(update, "content");
                  const text = getField<string>(content, "text") ?? "";
                  if (text) chunks.push(text);
                  collectedMessages.push({ role: "assistant", content: text });
                  break;
                }
                case "tool_call": {
                  const title = getField<string>(update, "title") ?? "";
                  const status = getField<string>(update, "status") ?? "";
                  collectedMessages.push({
                    role: "tool_call",
                    content: `${title} (${status})`,
                    tool_name: title,
                  });
                  break;
                }
                case "user_message_chunk": {
                  const content = getField<Record<string, unknown>>(update, "content");
                  const text = getField<string>(content, "text") ?? "";
                  if (text) collectedMessages.push({ role: "user", content: text });
                  break;
                }
              }
              break;
            }

            // { type: "prompt_complete", payload: { stopReason, usage?: { totalTokens, inputTokens, outputTokens } } }
            case "prompt_complete": {
              if (settled) return;
              settled = true;
              cleanupFn = null;
              unsub();
              abortCleanup?.();
              clearTimeout(timeoutTimer);

              const payload = getField<Record<string, unknown>>(msg, "payload");
              const usage = getField<Record<string, number>>(payload, "usage");
              resolve({
                stdout: chunks.join(""),
                exit_code: 0,
                tokens: usage ? { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 } : undefined,
                latency_ms: Date.now() - startTime,
                messages: collectedMessages,
              });
              break;
            }

            // { type: "error", payload: { message: string } }
            case "error": {
              if (settled) return;
              settled = true;
              cleanupFn = null;
              unsub();
              abortCleanup?.();
              clearTimeout(timeoutTimer);

              const payload = getField<Record<string, unknown>>(msg, "payload");
              const errorMsg = getField<string>(payload, "message") ?? "";
              const existing = chunks.join("");
              const stderr = errorMsg
                ? existing
                  ? `${existing}\n\n[Error] ${errorMsg}`
                  : `[Error] ${errorMsg}`
                : existing;
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

        cleanupFn = () => unsub();

        if (request.signal) {
          const onAbort = () => {
            if (settled) return;
            settled = true;
            cleanupFn = null;
            unsub();
            clearTimeout(timeoutTimer);
            reject(new DOMException("Request aborted", "AbortError"));
          };
          request.signal.addEventListener("abort", onAbort, { once: true });
          abortCleanup = () => request.signal?.removeEventListener("abort", onAbort);
        }

        // 发送 prompt 消息：{ type: "prompt", payload: { content: [{ type: "text", text: "..." }] } }
        this.channel.send({
          type: "prompt",
          payload: {
            content: [{ type: "text", text: request.prompt }],
          },
        });

        log(`[ACP-Transport] Sent prompt: sessionId=${this.sessionId} promptLength=${request.prompt.length}`);
      });
    } finally {
      (cleanupFn as (() => void) | null)?.();
    }
  }
}

// ---------- AcpTransport ----------

class AcpTransport implements Transport {
  async connect(agentId: string, options?: { cwd?: string; spawnedEnvIds?: Set<string> }): Promise<AgentSession> {
    if (!_channelFactory) {
      throw new Error("No channel factory configured for ACP Transport");
    }

    const channel = await _channelFactory(agentId, { spawnedEnvIds: options?.spawnedEnvIds });

    // ACP 协议：发 new_session → 等待 session_created
    const sessionId = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsub();
        reject(new DOMException(`new_session timed out after ${NEW_SESSION_TIMEOUT_MS}ms`, "AbortError"));
      }, NEW_SESSION_TIMEOUT_MS);
      if (typeof timeout.unref === "function") timeout.unref();

      const unsub = channel.onMessage((msg) => {
        const type = getField<string>(msg, "type") ?? "";

        if (type === "session_created") {
          clearTimeout(timeout);
          unsub();
          const payload = getField<Record<string, unknown>>(msg, "payload");
          const sid = getField<string>(payload, "sessionId");
          if (!sid) {
            reject(new Error("session_created response missing sessionId"));
            return;
          }
          resolve(sid);
        }

        if (type === "error") {
          clearTimeout(timeout);
          unsub();
          const payload = getField<Record<string, unknown>>(msg, "payload");
          reject(new Error(getField<string>(payload, "message") ?? "new_session error"));
        }
      });

      // 发送 new_session 消息
      channel.send({ type: "new_session", payload: { cwd: options?.cwd } });
      log(`[ACP-Transport] Sent new_session: agent=${agentId}`);
    });

    log(`[ACP-Transport] Session created: agent=${agentId} sessionId=${sessionId}`);
    return new AcpAgentSession(channel, sessionId);
  }

  isReady(): boolean {
    return true;
  }
}

// ---------- 工厂函数 ----------

export function createAcpTransport(): Transport {
  return new AcpTransport();
}
