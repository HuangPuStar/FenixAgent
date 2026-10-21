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

import {
  acquireAgentExecution,
  type AgentSession as ChatAgentSession,
  classifyAgentTurnEvent,
  getBoundAgentRuntime,
  iterateWithSignal,
  markAgentExecutionIdleReclaimable,
  type PromptTurn,
  waitWithSignal,
} from "@fenix/agent-runtime/runtime";
// 按组织列环境候选改经运行 port 的只读观测面（1.4 W6b）：本包不再直取环境仓储，
// 环境域的数据访问留在 agent-runtime 内，这里只消费它的只读投影。
// JSON-RPC 帧提取的唯一实现在 chat-channel 协议层（1.4 W6a 收口）：本包此前自带一份私有副本，
// 与 agent-runtime 的副本、chat-channel 的正本三处语义等价却各自演进，故一并删除改指正本。
import { extractJsonRpc } from "@fenix/chat-channel";
import { createLogger } from "@fenix/logger";
import type { EngineRelayHandle } from "@fenix/plugin-sdk";
import type { AgentMessage, AgentRequest, AgentResponse, AgentSession, Transport } from "@fenix/workflow-engine";
import { WorkflowError, WorkflowErrorCode } from "@fenix/workflow-engine";
import { acquireInstanceLease, recordSpawnedInstanceRuntime, releaseInstanceLease } from "./instance-lease";

const logger = createLogger("wf-agent-chat");

// ---------- 常量 ----------

/** session/prompt 执行超时（毫秒） */
const DEFAULT_EXECUTE_TIMEOUT_MS = 10 * 60 * 1000;

// ---------- JSON-RPC 消息提取 ----------

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

    const timeout = new AbortController();
    const timeoutTimer = setTimeout(
      () => timeout.abort(new WorkflowError("Agent execute timed out", WorkflowErrorCode.NODE_TIMEOUT)),
      this.timeoutMs,
    );
    const signal = request.signal ? AbortSignal.any([request.signal, timeout.signal]) : timeout.signal;
    const onAbort = (): void => {
      void this.turn.cancel().catch((error) => logger.error("Agent cancellation delivery failed", { error }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      signal.throwIfAborted();
      this.turn.prompt([{ type: "text", text: request.prompt }]);
      return await this.iterateEvents(startTime, chunks, collectedMessages, signal);
    } finally {
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timeoutTimer);
      this.releaseExecution();
    }
  }

  private executionReleased = false;
  private releaseExecution(): void {
    if (this.executionReleased) return;
    this.executionReleased = true;
    getBoundAgentRuntime().markInstanceRelayDetached(this.instanceId);
    releaseInstanceLease(this.instanceId);
  }

  /**
   * 迭代 PromptTurn.events() 流，收集输出直到收到 JSON-RPC 响应。
   */
  private async iterateEvents(
    startTime: number,
    chunks: string[],
    collectedMessages: AgentMessage[],
    signal: AbortSignal,
  ): Promise<AgentResponse> {
    for await (const msg of iterateWithSignal(this.turn.events(), signal)) {
      // 每条 relay 消息都计入业务活跃，防止长任务被 activity 硬超时误杀；
      // 保活消息由 shouldCountInstanceActivity 内部过滤（acp-idle-monitor），
      // 卡死实例仍会在 activity 硬超时后被回收，保留兜底语义
      const asAny = msg as unknown as Record<string, unknown>;
      getBoundAgentRuntime().touchInstanceActivity(this.instanceId, asAny);

      // 先检测传输层 error（与 JSON-RPC 无关）
      if (asAny.type === "error") {
        const existing = chunks.join("");
        return {
          stdout: existing ? `${existing}\n\n[Error] Agent execution failed` : "[Error] Agent execution failed",
          exit_code: 1,
          latency_ms: Date.now() - startTime,
          messages: collectedMessages,
        };
      }

      // Runtime death is fenced and reconciled by the relay connection factory.
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
        const existing = chunks.join("");
        return {
          stdout: existing ? `${existing}\n\n[Error] Agent execution failed` : "[Error] Agent execution failed",
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
          const existing = chunks.join("");
          return {
            stdout: existing ? `${existing}\n\n[Error] Agent execution failed` : "[Error] Agent execution failed",
            exit_code: 1,
            latency_ms: Date.now() - startTime,
            messages: collectedMessages,
          };
        }

        const terminal = classifyAgentTurnEvent(msg);
        const usage = result.usage as { totalTokens?: number; inputTokens?: number; outputTokens?: number } | undefined;

        if (terminal?.outcome !== "succeeded") {
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
      exit_code: 1,
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

  /**
   * 注销 PromptTurn 注册的 relay listener（C-P2.3）。
   * 不关闭 relay handle、不停止实例——实例复用语义由 AgentChatTransport / workflow
   * cleanup 管理，与 execute 内 markInstanceRelayDetached 的引用计数释放正交。
   * engine 在每次 execute 后调用，防止同实例复用场景下 N 次 run 累积 N 个死 listener。
   */
  async dispose(): Promise<void> {
    this.releaseExecution();
    await this.turn.cancel();
    this.turn.release();
    await this.turn.dispose();
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

  async connect(
    envName: string,
    options?: { cwd?: string; spawnedInstanceIds?: Set<string>; userId?: string; signal?: AbortSignal },
  ): Promise<AgentSession> {
    options?.signal?.throwIfAborted();
    const execution = acquireAgentExecution({
      userId: options?.userId ?? "",
      source: "scheduled",
      signal: options?.signal,
    });
    try {
      return await this.connectAdmitted(envName, options, execution);
    } catch (error) {
      execution.release();
      throw error;
    }
  }

  private async connectAdmitted(
    envName: string,
    options: { cwd?: string; spawnedInstanceIds?: Set<string>; userId?: string; signal?: AbortSignal } | undefined,
    execution: ReturnType<typeof acquireAgentExecution>,
  ): Promise<AgentSession> {
    logger.debug(`connect start: envName=${envName}`);

    // 1. 按 name + orgId 解析 Environment
    // 走 agent-runtime 的环境仓储而不是直读 environment 表：环境域的数据访问归 agent-runtime，
    // 本包直读会让同一张表出现第二份查询实现（§1 条件 8）。
    // 该仓储当前没有 name 维度的单行查询，这里在组织范围内取回后按 name 过滤；把查询收敛回单行的
    // `findByName(organizationId, name)` 需要 agent-runtime 侧新增仓储方法，已登记为跨包待办。
    const envCandidates = await waitWithSignal(
      getBoundAgentRuntime().observe.listEnvironmentRecordsByOrganization(this.organizationId),
      options?.signal,
    );
    options?.signal?.throwIfAborted();
    const envRow = envCandidates.find((candidate) => candidate.name === envName);

    if (!envRow) throw new Error(`Environment '${envName}' not found`);

    // Workflow owner 由既有执行上下文传递；缺失时 fail-closed，不回退 Environment owner。
    const ownerUserId = options?.userId;
    if (!ownerUserId) {
      throw new Error("INSTANCE_OWNER_REQUIRED");
    }
    if (envRow.userId !== ownerUserId) {
      throw new Error("INSTANCE_NOT_FOUND");
    }
    const runtime = getBoundAgentRuntime();
    const { instance, created } = await waitWithSignal(
      runtime.findOrCreateWorkflowInstanceWithStatus(envRow.id, ownerUserId),
      options?.signal,
    );
    if (created) options?.spawnedInstanceIds?.add(instance.id);
    options?.signal?.throwIfAborted();
    execution.attach(instance.id);
    // 选定实例即开始占用，ensure 的等待窗口也不能被创建者 run 的 cleanup 停止。
    acquireInstanceLease(instance.id);
    let handedOff = false;
    let relayAttached = false;
    let handle: EngineRelayHandle | undefined;
    let chatSession: ChatAgentSession | undefined;
    let turn: PromptTurn | undefined;
    try {
      await waitWithSignal(runtime.ensureInstanceRuntime(instance, options?.signal), options?.signal);
      execution.confirmRuntime();
      if (created && options?.spawnedInstanceIds?.has(instance.id))
        recordSpawnedInstanceRuntime(instance.id, runtime.getRuntimeSnapshot(instance.id).runtimeGeneration);
      markAgentExecutionIdleReclaimable(instance.id);
      options?.signal?.throwIfAborted();
      handle = await waitWithSignal(runtime.session.connectRelay(instance.id, ""), options?.signal, (late) =>
        late.close(),
      );
      runtime.markInstanceRelayAttached(instance.id);
      relayAttached = true;
      chatSession = runtime.session.createAgentSession({ relayHandle: handle, instanceId: instance.id });
      ({ turn } = await runtime.session.startPromptTurn({
        session: chatSession,
        signal: options?.signal,
        onExecutionFinished: () => execution.release(),
        prepareNewSession: () => runtime.refreshInstanceEnvironment(instance.id, envRow.id, ownerUserId),
      }));
      execution.confirmRuntime();
      const adapter = new AgentChatSessionAdapter(turn, chatSession);
      handedOff = true;
      logger.info(`connect done: envName=${envName} instanceId=${instance.id}`);
      return adapter;
    } catch (error) {
      if (turn) {
        await turn
          .dispose()
          .catch((cleanupError) => logger.error("Failed to release failed workflow turn", { error: cleanupError }));
      }
      try {
        if (chatSession) await chatSession.dispose();
        else await handle?.close();
      } catch (cleanupError) {
        logger.error("Failed to release failed workflow connection", { error: cleanupError });
      }
      throw error;
    } finally {
      if (!handedOff) {
        if (relayAttached) runtime.markInstanceRelayDetached(instance.id);
        releaseInstanceLease(instance.id);
      }
    }
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
