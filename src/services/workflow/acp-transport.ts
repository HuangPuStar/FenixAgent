/**
 * ACP Transport 实现 — workflow-engine Transport 接口的薄包装。
 *
 * 职责：
 * - 仅负责 ACP 协议（session/create、发 user 消息、收响应）
 * - 不关心底层是 relay / WebSocket / EventBus
 * - 底层通信由注入的 SessionFactory 回调提供
 *
 * 分层：
 * - workflow/index.ts（服务层）：负责环境解析、实例启动、relay 连接
 * - acp-transport.ts（本文件）：仅封装 ACP 协议流程
 */

import type { AgentMessage, AgentRequest, AgentResponse, AgentSession, Transport } from "@fenix/workflow-engine";
import { nanoid } from "nanoid";
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

const SESSION_CREATE_TIMEOUT_MS = 30_000;
const DEFAULT_EXECUTE_TIMEOUT_MS = 10 * 60 * 1000;

// ---------- 类型 ----------

interface SessionUpdateMessage {
  role: string;
  content?: string;
  tool_name?: string;
}

interface PromptCompleteMetadata {
  model?: string;
  tokens?: { input: number; output: number };
}

// ---------- 辅助函数 ----------

function createTimeoutPromise<T>(ms: number, label: string): Promise<T> {
  return new Promise<T>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new DOMException(`${label} timed out after ${ms}ms`, "AbortError"));
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

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
          const msgSessionId = getField<string>(msg, "session_id");
          if (msgSessionId && msgSessionId !== this.sessionId) return;

          switch (type) {
            case "session_update": {
              const message = getField<SessionUpdateMessage>(msg, "message");
              if (!message) break;

              switch (message.role) {
                case "assistant":
                  if (typeof message.content === "string") chunks.push(message.content);
                  collectedMessages.push({ role: "assistant", content: message.content ?? "" });
                  break;
                case "tool_call":
                  collectedMessages.push({
                    role: "tool_call",
                    content: message.content ?? "",
                    tool_name: message.tool_name,
                  });
                  break;
                case "tool_result":
                  collectedMessages.push({
                    role: "tool_result",
                    content: message.content ?? "",
                    tool_name: message.tool_name,
                  });
                  break;
                case "user":
                  collectedMessages.push({ role: "user", content: message.content ?? "" });
                  break;
              }
              break;
            }

            case "prompt_complete": {
              if (settled) return;
              settled = true;
              cleanupFn = null;
              unsub();
              abortCleanup?.();
              clearTimeout(timeoutTimer);
              const metadata = getField<PromptCompleteMetadata>(msg, "metadata");
              resolve({
                stdout: chunks.join(""),
                exit_code: 0,
                tokens: metadata?.tokens,
                model: metadata?.model,
                latency_ms: Date.now() - startTime,
                messages: collectedMessages,
              });
              break;
            }

            case "error": {
              if (settled) return;
              settled = true;
              cleanupFn = null;
              unsub();
              abortCleanup?.();
              clearTimeout(timeoutTimer);
              const errorMsg = getField<string>(msg, "message") ?? getField<string>(msg, "error") ?? "";
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

        this.channel.send({
          type: "user",
          session_id: this.sessionId,
          content: request.prompt,
        });

        log(`[ACP-Transport] Sent user message: sessionId=${this.sessionId} promptLength=${request.prompt.length}`);
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

    // session/create 流程
    const correlationId = nanoid(12);
    const sessionId = await Promise.race<string>([
      createTimeoutPromise(SESSION_CREATE_TIMEOUT_MS, "session/create"),

      new Promise<string>((resolve, reject) => {
        const unsub = channel.onMessage((msg) => {
          const type = getField<string>(msg, "type") ?? "";

          if (type === "session/create") {
            const responseId = getField<string>(msg, "id");
            if (responseId !== correlationId) return;

            const newSessionId = getField<string>(msg, "session_id");
            if (!newSessionId) {
              reject(new Error("session/create response missing session_id"));
              return;
            }
            unsub();
            resolve(newSessionId);
          }

          if (type === "error") {
            unsub();
            reject(new Error(getField<string>(msg, "message") ?? "session/create error"));
          }
        });

        channel.send({ type: "session/create", id: correlationId });
        log(`[ACP-Transport] Sent session/create: agent=${agentId} correlationId=${correlationId}`);
      }),
    ]);

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
