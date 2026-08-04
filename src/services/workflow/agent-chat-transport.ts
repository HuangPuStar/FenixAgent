/**
 * AgentChatTransport — 复用 agent-chat-service 能力的 Transport 实现。
 *
 * 替代独立的 acp-transport.ts，通过 agent-chat-service 的
 * createAgentSession + startPromptTurn 完成 ACP 通信。
 *
 * 分层：
 * - workflow/index.ts（服务层）：负责环境解析 + 实例启动
 * - agent-chat-transport.ts（本文件）：桥接 agent-chat-service，实现 Transport 接口
 */

import { createLogger } from "@fenix/logger";
import type { EngineRelayHandle } from "@fenix/plugin-sdk";
import type { AgentMessage, AgentRequest, AgentResponse, AgentSession, Transport } from "@fenix/workflow-engine";
import { WorkflowError, WorkflowErrorCode } from "@fenix/workflow-engine";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { environment } from "../../db/schema";
import { connectAgentRelay } from "../../transport/agent-relay";
import { markInstanceRelayAttached, markInstanceRelayDetached, touchInstanceActivity } from "../acp-idle-monitor";
import {
  type AgentSession as ChatAgentSession,
  createAgentSession,
  type PromptTurn,
  startPromptTurn,
} from "../agent-chat-service";
import { ensureRunning } from "../instance";

const logger = createLogger("wf-agent-chat");

// ---------- 常量 ----------

/** session/prompt 执行超时（毫秒） */
const DEFAULT_EXECUTE_TIMEOUT_MS = 10 * 60 * 1000;

// ---------- JSON-RPC 消息提取 ----------

/**
 * 从 relay 消息中提取 JSON-RPC 对象。
 * relay 消息可能以两种格式到达：
 *   A) 原始 JSON-RPC：{ jsonrpc: "2.0", method / result, ... }
 *   B) 包裹格式：{ type: "session_update", payload: { jsonrpc: "2.0", ... } }
 */
function extractJsonRpc(msg: unknown): Record<string, unknown> | null {
  const asAny = msg as Record<string, unknown>;
  if (asAny.jsonrpc === "2.0") return asAny;
  const payload = asAny.payload as Record<string, unknown> | undefined;
  if (payload?.jsonrpc === "2.0") return payload;
  return null;
}

/** 从 JSON-RPC 通知中提取 session/update 的 payload */
function extractSessionUpdate(rpc: Record<string, unknown>): Record<string, unknown> | null {
  if (rpc.method !== "session/update") return null;
  const params = rpc.params as Record<string, unknown> | undefined;
  return (params?.update as Record<string, unknown>) ?? null;
}

// ---------- AgentChatSessionAdapter ----------

/**
 * 基于 PromptTurn 的 Agent 会话适配器。
 * 对 workflow engine 暴露 AgentSession.execute() 接口，
 * 内部通过 PromptTurn.events() 迭代收集流式输出。
 *
 * 导出供测试直接构造 fake turn 验证 execute 语义（见 src/__tests__/agent-chat-transport.test.ts）。
 */
export class AgentChatSessionAdapter implements AgentSession {
  private readonly turn: PromptTurn;
  /** 实例 ID：用于 idle/activity 观测埋点（touch / relay attach / detach） */
  private readonly instanceId: string;

  constructor(
    turn: PromptTurn,
    chatSession: ChatAgentSession,
    /** 执行超时兜底时长（毫秒）；测试注入小值，生产使用 DEFAULT_EXECUTE_TIMEOUT_MS */
    private readonly timeoutMs: number = DEFAULT_EXECUTE_TIMEOUT_MS,
  ) {
    this.turn = turn;
    this.instanceId = chatSession.instanceId;
  }

  async execute(request: AgentRequest): Promise<AgentResponse> {
    const startTime = Date.now();
    const chunks: string[] = [];
    const collectedMessages: AgentMessage[] = [];

    // 发送 prompt
    this.turn.prompt([{ type: "text", text: request.prompt }]);
    logger.debug(`Sent prompt: promptLength=${request.prompt.length}`);

    let settled = false;
    let abortCleanup: (() => void) | null = null;

    return new Promise<AgentResponse>((resolve, reject) => {
      // 执行超时兜底：节点 timeout 配置大于 timeoutMs（如 1200s）时，保证 execute 仍有界失败。
      // 必须 reject 而非静默置位——否则 Promise 永不 settle，且 settled 会吞掉后续节点 abort
      //（唯一可用的退出路径被禁用，节点永久挂起）。NODE_TIMEOUT 由 engine 侧不重试。
      const timeoutTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // run 结束释放 relay 引用计数，恢复 idle 观察窗口；detach 在实例已
        // stop（supplement 已 unregister）后执行是 no-op，天然幂等
        markInstanceRelayDetached(this.instanceId);
        abortCleanup?.();
        logger.error(`Agent execute timed out: timeoutMs=${this.timeoutMs}`);
        reject(new WorkflowError("Agent execute timed out", WorkflowErrorCode.NODE_TIMEOUT));
      }, this.timeoutMs);
      if (typeof timeoutTimer.unref === "function") timeoutTimer.unref();

      // Abort signal 支持
      if (request.signal) {
        const onAbort = (): void => {
          if (settled) return;
          settled = true;
          markInstanceRelayDetached(this.instanceId);
          clearTimeout(timeoutTimer);
          reject(new DOMException("Request aborted", "AbortError"));
        };
        request.signal.addEventListener("abort", onAbort, { once: true });
        abortCleanup = () => request.signal?.removeEventListener("abort", onAbort);
      }

      // 异步迭代 PromptTurn 事件流
      this.iterateEvents(startTime, chunks, collectedMessages)
        .then((result) => {
          if (settled) return;
          settled = true;
          markInstanceRelayDetached(this.instanceId);
          clearTimeout(timeoutTimer);
          abortCleanup?.();
          resolve(result);
        })
        .catch((err) => {
          if (settled) return;
          settled = true;
          markInstanceRelayDetached(this.instanceId);
          clearTimeout(timeoutTimer);
          abortCleanup?.();
          reject(err);
        });
    });
  }

  /**
   * 迭代 PromptTurn.events() 流，收集输出直到收到 JSON-RPC 响应。
   */
  private async iterateEvents(
    startTime: number,
    chunks: string[],
    collectedMessages: AgentMessage[],
  ): Promise<AgentResponse> {
    for await (const msg of this.turn.events()) {
      // 每条 relay 消息都计入业务活跃，防止长任务被 activity 硬超时误杀；
      // 保活消息由 shouldCountInstanceActivity 内部过滤（acp-idle-monitor），
      // 卡死实例仍会在 activity 硬超时后被回收，保留兜底语义
      const asAny = msg as unknown as Record<string, unknown>;
      touchInstanceActivity(this.instanceId, asAny);

      // 先检测传输层 error（与 JSON-RPC 无关）
      if (asAny.type === "error") {
        const errorMsg = (asAny.payload as Record<string, unknown> | undefined)?.message as string | undefined;
        const existing = chunks.join("");
        return {
          stdout: errorMsg ? (existing ? `${existing}\n\n[Error] ${errorMsg}` : `[Error] ${errorMsg}`) : existing,
          exit_code: 1,
          latency_ms: Date.now() - startTime,
          messages: collectedMessages,
        };
      }

      // 传输层 relay 关闭（实例被 idle 回收 / 手动停止 / 机器断连）：relay 不会再推送任何
      // 消息，不识别会导致事件流永久挂起。与 type==="error" 同模式返回 exit_code=1 失败，
      // 由 engine 按 NODE_FAILED 走节点重试（relay 瞬断时可自愈）。
      if (asAny.type === "relay_closed") {
        const payload = asAny.payload as Record<string, unknown> | undefined;
        const code = typeof payload?.code === "string" ? payload.code : "relay_disconnected";
        const existing = chunks.join("");
        return {
          stdout: existing
            ? `${existing}\n\n[Error] Agent connection closed (${code})`
            : `[Error] Agent connection closed (${code})`,
          exit_code: 1,
          latency_ms: Date.now() - startTime,
          messages: collectedMessages,
        };
      }

      // 提取 JSON-RPC 对象（兼容原始和包裹两种格式）
      const rpc = extractJsonRpc(msg);
      if (!rpc) {
        // 非 JSON-RPC 消息（如 status / keepalive），跳过
        continue;
      }

      // 顶层 JSON-RPC error 响应（{jsonrpc, id, error}，createErrorResponse 形态）：
      // 无 result 字段，若不单独处理会被静默跳过，run 将挂到执行超时才失败
      const rpcError = rpc.error as { message?: string } | null | undefined;
      if (rpcError && typeof rpcError === "object") {
        const errorMsg = rpcError.message ?? "Agent error";
        const existing = chunks.join("");
        return {
          stdout: existing ? `${existing}\n\n[Error] ${errorMsg}` : `[Error] ${errorMsg}`,
          exit_code: 1,
          latency_ms: Date.now() - startTime,
          messages: collectedMessages,
        };
      }

      // 检测 JSON-RPC 响应（session/prompt 完成信号）
      const result = rpc.result as Record<string, unknown> | null | undefined;
      if (result !== undefined && result !== null) {
        // JSON-RPC error
        if ("error" in result) {
          const errObj = result.error as Record<string, unknown>;
          const errorMsg = (errObj.message as string) ?? "Agent error";
          const existing = chunks.join("");
          return {
            stdout: existing ? `${existing}\n\n[Error] ${errorMsg}` : `[Error] ${errorMsg}`,
            exit_code: 1,
            latency_ms: Date.now() - startTime,
            messages: collectedMessages,
          };
        }

        const stopReason = (result.stopReason as string) ?? "end_turn";
        const usage = result.usage as { totalTokens?: number; inputTokens?: number; outputTokens?: number } | undefined;

        if (stopReason === "error") {
          const existing = chunks.join("");
          return {
            stdout: existing || "Agent returned error stop reason",
            exit_code: 1,
            latency_ms: Date.now() - startTime,
            messages: collectedMessages,
          };
        }

        return {
          stdout: chunks.join(""),
          exit_code: 0,
          tokens: usage ? { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 } : undefined,
          latency_ms: Date.now() - startTime,
          messages: collectedMessages,
        };
      }

      // 检测 session/update 通知 → 收集文本和工具调用信息
      const update = extractSessionUpdate(rpc);
      if (update) {
        this.collectUpdate(update, chunks, collectedMessages);
      }
    }

    // 事件流意外结束（无 JSON-RPC 响应）
    logger.warn("PromptTurn events stream ended without JSON-RPC response");
    return {
      stdout: chunks.join(""),
      exit_code: 0,
      latency_ms: Date.now() - startTime,
      messages: collectedMessages,
    };
  }

  /** 从 session/update payload 中提取文本和工具调用信息 */
  private collectUpdate(update: Record<string, unknown>, chunks: string[], messages: AgentMessage[]): void {
    const sessionUpdate = update.sessionUpdate as string | undefined;
    if (!sessionUpdate) return;

    switch (sessionUpdate) {
      case "agent_message_chunk": {
        const text = ((update as Record<string, unknown>).content as { text?: string } | undefined)?.text ?? "";
        if (text) {
          chunks.push(text);
          messages.push({ role: "assistant", content: text });
        }
        break;
      }
      case "tool_call": {
        const title = (update as Record<string, unknown>).title as string | undefined;
        const status = (update as Record<string, unknown>).status as string | undefined;
        if (title) {
          messages.push({
            role: "tool_call",
            content: `${title} (${status ?? "unknown"})`,
            tool_name: title,
          });
        }
        break;
      }
      case "user_message_chunk": {
        const text = ((update as Record<string, unknown>).content as { text?: string } | undefined)?.text ?? "";
        if (text) {
          messages.push({ role: "user", content: text });
        }
        break;
      }
    }
  }
}

// ---------- AgentChatTransport ----------

/**
 * Transport 实现，复用 agent-chat-service 的 ACP 通信能力。
 * 按 organizationId 隔离，构造时注入。
 */
class AgentChatTransport implements Transport {
  private readonly organizationId: string;

  constructor(organizationId: string) {
    this.organizationId = organizationId;
  }

  async connect(envName: string, options?: { cwd?: string; spawnedInstanceIds?: Set<string> }): Promise<AgentSession> {
    logger.debug(`connect start: envName=${envName}`);

    // 1. 按 name + orgId 查 Environment
    const [envRow] = await db
      .select({ id: environment.id, userId: environment.userId })
      .from(environment)
      .where(and(eq(environment.name, envName), eq(environment.organizationId, this.organizationId)))
      .limit(1);

    if (!envRow) throw new Error(`Environment '${envName}' not found`);

    // 2. 确保实例运行
    // I4 调用方迁移说明：Workflow 编排保留 ensureRunning 的会话语义（复用运行实例，
    // autoStart / maxSessions 检查），而非迁移到 controller.spawnInstance——后者无
    // 复用语义且受 maxConcurrency 限制（总是创建新实例），替换会改变 Transport 接口
    // 行为（每次 connect 新建实例）。ensureRunning 内部的 spawn 分支已收敛到编排域
    // 入口 spawnInstanceViaController（instance.ts 的私有 helper）；配套的
    // cleanupSpawnedInstances（workflow/index.ts）按 instanceId 精确停止本次 run 实际
    // spawn 的实例（见下方 spawnedInstanceIds 记录），reused 实例不归本 run 所有、
    // 不清理，语义与实现一致。
    const { instance, status } = await ensureRunning("system", envRow.id, "system");
    if (status === "spawned") {
      // 记录实例 ID 而非环境 ID：cleanup 按 instanceId 停止，避免按 envId 停止时
      // 误杀同环境内其他 run 或用户交互启动的实例（C-P1.1）
      options?.spawnedInstanceIds?.add(instance.id);
    }

    // 3. 连接 relay
    const handle: EngineRelayHandle = await connectAgentRelay(instance.id, "");
    logger.debug(`connect relay ready: envName=${envName} instanceId=${instance.id}`);

    // run 期间实例视为"前台使用"：relayCount>0 阻止 idle 回收（acp-idle-monitor），
    // activity 硬超时由 execute 内 touchInstanceActivity 维持
    markInstanceRelayAttached(instance.id);

    // 4. 创建 chat AgentSession（不传 stopInstance，实例由 workflow cleanup 统一管理）
    const chatSession = createAgentSession({
      relayHandle: handle,
      instanceId: instance.id,
      // 不传 stopInstance：ensureRunning 的实例不随单次执行销毁
    });

    // 5. 创建 ACP session + PromptTurn
    // startPromptTurn 失败（session/new、session/load 的 rpc error）必须配对释放
    // attach 的引用计数，否则 relayCount 残留，实例失去 idle 回收出口，只能等
    // activity 硬超时兜底
    let turn: PromptTurn;
    try {
      ({ turn } = await startPromptTurn({ session: chatSession }));
    } catch (err) {
      markInstanceRelayDetached(instance.id);
      throw err;
    }
    logger.info(`connect done: envName=${envName} instanceId=${instance.id}`);

    return new AgentChatSessionAdapter(turn, chatSession);
  }

  isReady(): boolean {
    return true;
  }
}

// ---------- 工厂函数 ----------

/** 创建 AgentChatTransport 实例，按 organizationId 隔离。 */
export function createAgentChatTransport(organizationId: string): Transport {
  return new AgentChatTransport(organizationId);
}
