import { randomUUID } from "node:crypto";
import { environment } from "@fenix/agent-runtime/db";
import { log, error as logError, requestAls } from "@fenix/logger";
import { NotFoundError } from "@fenix/platform-sdk";
import { and, eq } from "drizzle-orm";
import { getAgentRuntimeDatabase } from "../server/db";
import { agentInstanceService } from "../server/services/agent-instance-service";
import { createWebEnvironment } from "../server/services/environment-web";
import { connectAgentRelay } from "../server/transport/agent-relay";
import type { InstanceSpawnSource } from "../types/instance";

// 编排域依赖注入点（对齐 openai-chat.ts 的 setOpenAIChatRouteDeps 模式）：
// openAgentSession 的「spawn → relay → turn」编排依赖集中在此，测试可注入 fake
// 覆盖失败回滚路径，避免 mock.module。
const defaultDeps = {
  resolveInstance: agentInstanceService.resolveInstanceForOperation.bind(agentInstanceService),
  ensureInstanceRuntime: agentInstanceService.ensureInstanceRuntime.bind(agentInstanceService),
  connectAgentRelay,
};
const deps = { ...defaultDeps };

/** 测试用：覆盖 agent-chat-service 的编排域依赖，避免 mock.module。 */
export function setAgentChatServiceDeps(overrides: Partial<typeof deps> | null): void {
  if (overrides) {
    Object.assign(deps, overrides);
    return;
  }
  Object.assign(deps, defaultDeps);
}

export type { AgentSession, PromptTurn, PromptTurnStartOptions } from "./agent-prompt-turn";
export { createAgentSession, createPromptTurn, startPromptTurn } from "./agent-prompt-turn";

import { resolveSessionMcpServers } from "../server/services/session-mcp-provider";
import {
  type AgentExecutionLease,
  acquireAgentExecution,
  markAgentExecutionIdleReclaimable,
} from "./agent-execution-admission";
import { type AgentSession, createAgentSession, type PromptTurn, startPromptTurn } from "./agent-prompt-turn";
import { waitWithSignal } from "./agent-turn-events";

// ── 编排层：一站式从 agentId 启动到 PromptTurn ──

export interface OpenAgentSessionInput {
  userId: string;
  /** agent_config.id（非 environment.id），函数内部自动解析为对应的 environment */
  agentConfigId: string;
  organizationId: string;
  /** 可选：恢复已有会话时传入 ACP session ID */
  sessionId?: string;
  startSource: InstanceSpawnSource;
  /** Cancellation covers runtime readiness, relay connection and ACP handshake. */
  signal?: AbortSignal;
  /**
   * 触发本次会话的关联 ID（§7）：HTTP 触发由路由从请求上下文取出后传入，
   * 定时 / 队列等独立入口传入口自建的值；不传时由本函数兜底解析（见 openAgentSession）。
   */
  requestId?: string;
  /**
   * 会话级 MCP 条目（通道 B）。省略时由宿主注册的 provider 解析（云盘 token 等）；
   * 显式传入 `[]` 表示本次不注入，用于测试或需要关闭云盘工具的入口。
   */
  mcpServers?: readonly Record<string, unknown>[];
}

export interface OpenAgentSessionResult {
  turn: PromptTurn;
  instanceId: string;
}

/**
 * 一站式打开 Agent 会话：解析持久 api/primary Instance → 确保 runtime → 连接 relay →
 * 创建 AgentSession → startPromptTurn。
 *
 * 每次调用创建独立 relay 消费租约、ACP session 与 turn，但复用当前环境与用户的持久 Instance；
 * dispose 只释放请求资源，runtime 生命周期由 Coordinator 管理。
 *
 * @param input.agentConfigId — agent_config.id（非 environment.id），用于解析 Environment 与持久 Instance
 */
export async function openAgentSession(input: OpenAgentSessionInput): Promise<OpenAgentSessionResult> {
  const execution = acquireAgentExecution({ userId: input.userId, source: input.startSource, signal: input.signal });
  try {
    return await openAdmittedAgentSession(input, execution);
  } catch (error) {
    execution.release();
    throw error;
  }
}

async function openAdmittedAgentSession(
  input: OpenAgentSessionInput,
  execution: AgentExecutionLease,
): Promise<OpenAgentSessionResult> {
  // 关联 ID 解析顺序与调度入口一致（§7）：调用方显式传入 > 当前 HTTP 请求上下文 > 独立入口自建。
  // 首条诊断日志放在 UUID 校验之前：非法 agentConfigId 被拒时同样留下关联 ID。
  input.signal?.throwIfAborted();
  const requestId = input.requestId ?? requestAls.getStore()?.requestId ?? randomUUID();
  log(`[agent-chat] Opening session: agentConfigId=${input.agentConfigId} startSource=${input.startSource}`, {
    requestId,
  });

  // 1. 解析 agentConfigId (agent_config.id) → environmentId
  // 仅对有效 UUID 做索引查询；非 UUID 提前拒绝，避免经 createWebEnvironment 降级时
  // 触发 Postgres "invalid input syntax for type uuid" 裸错误。
  // 抛 NotFoundError（而非裸 Error）：错误带稳定 code（NOT_FOUND），经 errorPlugin
  // 映射为 404，与 openai-chat 移除本地 message 嗅探前的行为保持一致。
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(input.agentConfigId)) {
    throw new NotFoundError("Agent config not found: invalid agentConfigId format");
  }

  let environmentId: string;
  const db = getAgentRuntimeDatabase();
  const existingRows = await waitWithSignal(
    Promise.resolve(
      db
        .select({ id: environment.id })
        .from(environment)
        .where(
          and(
            eq(environment.organizationId, input.organizationId),
            eq(environment.agentConfigId, input.agentConfigId),
            eq(environment.userId, input.userId),
          ),
        )
        .limit(1),
    ),
    input.signal,
  );

  if (existingRows.length > 0) {
    environmentId = existingRows[0].id;
    log(`[agent-chat] Reusing existing environment: environmentId=${environmentId} agentId=${input.agentConfigId}`, {
      requestId,
    });
  } else {
    // 自动创建 environment（名称组合避免与手动创建的环境冲突）
    // agentId 预期为标准 UUID（a-f0-9 小写），为防止非标准 ID 导致 kebab-case 校验失败，做 sanitize
    const safeSuffix = input.agentConfigId.replace(/[^a-z0-9-]/g, "").slice(0, 8) || "default";
    const autoName = `auto-${safeSuffix}`;
    const env = await waitWithSignal(
      createWebEnvironment({
        name: autoName,
        agentConfigId: input.agentConfigId,
        userId: input.userId,
        organizationId: input.organizationId,
        autoStart: true,
      }),
      input.signal,
    );
    environmentId = env.id;
    log(`[agent-chat] Auto-created environment: environmentId=${environmentId} agentId=${input.agentConfigId}`, {
      requestId,
    });
  }

  // 2. 解析并确保持久 api/primary runtime。请求只拥有 turn/relay，不拥有 runtime 生命周期。
  const instance = await waitWithSignal(
    deps.resolveInstance({
      environmentId,
      ownerUserId: input.userId,
      automaticSelection: "api",
    }),
    input.signal,
  );
  input.signal?.throwIfAborted();
  execution.attach(instance.id);
  await waitWithSignal(deps.ensureInstanceRuntime(instance, input.signal), input.signal);
  execution.confirmRuntime();
  markAgentExecutionIdleReclaimable(instance.id);
  input.signal?.throwIfAborted();
  log(`[agent-chat] Instance ready: instanceId=${instance.id}`, { requestId });

  // 3-5. 连接 relay → 创建 AgentSession → startPromptTurn。
  // 失败和正常 dispose 都只关闭本请求的 relay/listener；持久 runtime 由 Coordinator 管理。
  let session: AgentSession | null = null;
  try {
    // requestId 随 ConnectInstanceRelayRequest 进入 core 的 relay 链路，使两侧日志可关联
    const handle = await waitWithSignal(
      deps.connectAgentRelay(instance.id, input.sessionId ?? "", requestId),
      input.signal,
      (late) => late.close(),
    );
    log(`[agent-chat] Relay connected: instanceId=${instance.id}`, { requestId });

    session = createAgentSession({
      relayHandle: handle,
      instanceId: instance.id,
    });

    // 通道 B：会话级 MCP。调用方显式给出时以调用方为准；否则交给宿主注册的 provider。
    const mcpServers =
      input.mcpServers ??
      (await resolveSessionMcpServers({
        userId: input.userId,
        organizationId: input.organizationId,
        agentId: input.agentConfigId,
        instanceId: instance.id,
      }));

    const { turn } = await startPromptTurn({
      session,
      sessionId: input.sessionId,
      signal: input.signal,
      onExecutionFinished: () => execution.release(),
      ...(mcpServers === undefined ? {} : { mcpServers }),
    });
    try {
      execution.confirmRuntime();
    } catch (error) {
      await turn.dispose();
      throw error;
    }
    return { turn, instanceId: instance.id };
  } catch (err) {
    if (session) {
      await session.dispose().catch((rollbackErr) => {
        logError(`[agent-chat] Failed to release session for instance ${instance.id}:`, rollbackErr, { requestId });
      });
    }
    throw err;
  }
}
