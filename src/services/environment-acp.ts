import { randomBytes } from "node:crypto";
import { environmentRepo, sessionRepo } from "../repositories";
import type { RegisterEnvironmentRequest } from "../types/api";
import type { EnvironmentRecord } from "../repositories";
import { NotFoundError, AppError } from "../errors";
import { findOrCreateForEnvironment } from "./session";
import { toResponse, deleteEnvironment } from "./environment-core";
import { log } from "../logger";

/** 通过 secret 获取环境信息（认证用），仅返回认证所需字段 */
export async function getEnvironmentBySecret(secret: string): Promise<{ id: string; userId: string | null; agentConfigId: string | null; secret: string } | null> {
  const env = await environmentRepo.getBySecret(secret);
  if (!env) return null;
  return {
    id: env.id,
    userId: env.userId,
    agentConfigId: env.agentConfigId,
    secret: env.secret,
  };
}

/** Bridge 注册请求参数 */
export interface BridgeRegistrationInput {
  authEnvironmentId?: string;
  userId: string;
  machine_name?: string;
  directory?: string;
  branch?: string;
  git_repo_url?: string;
  max_sessions?: number;
  worker_type?: string;
  capabilities?: Record<string, unknown>;
  metadata?: { worker_type?: string };
}

/** Bridge 注册结果 */
export interface BridgeRegistrationResult {
  environment_id: string;
  environment_secret: string;
  status: string;
  session_id?: string;
}

/** 旧式 WS 注册（env_ 前缀 secret），保留向后兼容 */
export async function registerEnvironment(req: RegisterEnvironmentRequest & { metadata?: { worker_type?: string }; username?: string; userId?: string; teamId?: string }) {
  const secret = `env_${randomBytes(24).toString("hex")}`;
  const workerType = req.worker_type ?? req.metadata?.worker_type;
  const record = await environmentRepo.create({
    secret,
    userId: req.userId ?? "system",
    teamId: req.teamId,
    machineName: req.machine_name,
    directory: req.directory,
    branch: req.branch,
    gitRepoUrl: req.git_repo_url,
    maxSessions: req.max_sessions,
    workerType,
    username: req.username,
    capabilities: req.capabilities,
  });

  // Session 由 acp-link 管理，RCS 不再创建
  return { environment_id: record.id, environment_secret: record.secret, status: record.status, session_id: undefined };
}

/** 旧式 WS 注销 */
export async function deregisterEnvironment(envId: string) {
  await environmentRepo.update(envId, { status: "deregistered" });
}

/** 获取单个 Environment 记录 */
export async function getEnvironment(envId: string) {
  return environmentRepo.getById(envId);
}

/** 更新 poll 时间 */
export async function updatePollTime(envId: string) {
  await environmentRepo.update(envId, { lastPollAt: new Date() });
}

/** 获取所有活跃环境 */
export async function listActiveEnvironments() {
  return environmentRepo.listActive();
}

/** 获取所有活跃环境（v1 响应格式） */
export async function listActiveEnvironmentsResponse() {
  const envs = await environmentRepo.listActive();
  return envs.map(toResponse);
}

/** 按用户名获取活跃环境（v1 响应格式） */
export async function listActiveEnvironmentsByUsername(username: string) {
  const envs = await environmentRepo.listActiveByUsername(username);
  return envs.map(toResponse);
}

/** 重连环境 */
export async function reconnectEnvironment(envId: string) {
  await environmentRepo.update(envId, { status: "active" });
}

// ────────────────────────────────────────────
// Transport 层专用接口
// ────────────────────────────────────────────

/** 标记 Environment 为 active 并更新 poll 时间 */
export async function markEnvironmentActive(envId: string): Promise<void> {
  await environmentRepo.update(envId, { status: "active", lastPollAt: new Date() });
}

/** 标记 Environment 为 idle */
export async function markEnvironmentIdle(envId: string): Promise<void> {
  await environmentRepo.update(envId, { status: "idle" });
}

/** 更新 Environment 的 lastPollAt */
export async function touchEnvironmentPoll(envId: string): Promise<void> {
  await environmentRepo.update(envId, { lastPollAt: new Date() });
}

/** 更新 Environment capabilities 和 maxSessions */
export async function updateEnvironmentCapabilities(
  envId: string,
  patch: { capabilities?: Record<string, unknown> | null; maxSessions?: number },
): Promise<void> {
  await environmentRepo.update(envId, {
    capabilities: patch.capabilities ?? undefined,
    maxSessions: patch.maxSessions,
  });
}

/** 创建临时 Environment（非持久化，WS 注册用） */
export async function createTemporaryEnvironment(params: {
  secret: string;
  userId: string;
  machineName: string;
  directory?: string;
  maxSessions?: number;
  capabilities?: Record<string, unknown>;
}): Promise<EnvironmentRecord> {
  return environmentRepo.create({
    secret: params.secret,
    userId: params.userId,
    machineName: params.machineName,
    workerType: "acp",
    directory: params.directory,
    maxSessions: params.maxSessions,
    capabilities: params.capabilities,
  });
}

// ────────────────────────────────────────────
// Bridge 注册编排（v1/environments 路由用）
// ────────────────────────────────────────────

/** Bridge 注册编排：已认证环境更新 + 新环境创建 + 自动会话 */
export async function registerBridge(input: BridgeRegistrationInput): Promise<BridgeRegistrationResult> {
  const {
    authEnvironmentId,
    userId,
    machine_name,
    directory,
    branch,
    git_repo_url,
    max_sessions,
    capabilities,
    metadata,
  } = input;

  // 已认证环境：更新并返回
  if (authEnvironmentId) {
    const existing = await environmentRepo.getById(authEnvironmentId);
    if (existing) {
      if (existing.userId !== userId) {
        throw new AppError("Environment not owned by you", "FORBIDDEN", 403);
      }
      // 并行执行环境更新和 session 查询（两操作无依赖）
      const [, sessions] = await Promise.all([
        environmentRepo.update(authEnvironmentId, {
          status: "active",
          lastPollAt: new Date(),
          capabilities: capabilities ?? undefined,
          maxSessions: max_sessions,
        }),
        sessionRepo.listByEnvironment(authEnvironmentId),
      ]);

      return {
        environment_id: existing.id,
        environment_secret: existing.secret,
        status: "active",
        session_id: sessions.length > 0 ? sessions[0].id : undefined,
      };
    }
    log(`[ACP] authEnvironmentId '${authEnvironmentId}' not found, creating new environment`);
  }

  // 新环境：创建 + 自动会话
  const workerType = input.worker_type ?? metadata?.worker_type ?? "acp";
  const secret = `rest_${randomBytes(24).toString("hex")}`;

  const record = await environmentRepo.create({
    secret,
    userId,
    machineName: machine_name,
    directory,
    branch,
    gitRepoUrl: git_repo_url,
    maxSessions: max_sessions,
    workerType,
    capabilities,
  });

  let sessionId: string | undefined;
  if (workerType === "acp") {
    const sessionResult = await findOrCreateForEnvironment(
      record.id,
      machine_name || "ACP Agent",
      userId,
      "acp",
    );
    sessionId = sessionResult.id;
  }

  return {
    environment_id: record.id,
    environment_secret: record.secret,
    status: record.status,
    session_id: sessionId,
  };
}

/** Bridge 重连编排：校验归属 + 标记 active */
export async function reconnectBridge(envId: string, userId: string): Promise<void> {
  const env = await environmentRepo.getById(envId);
  if (!env || env.userId !== userId) {
    throw new NotFoundError("Environment not found");
  }
  await environmentRepo.update(envId, { status: "active" });
}

/** Bridge 注销编排：校验归属 + 删除 */
export async function deregisterBridge(envId: string, userId: string): Promise<void> {
  const env = await environmentRepo.getById(envId);
  if (!env || env.userId !== userId) {
    throw new NotFoundError("Environment not found");
  }
  await deleteEnvironment(envId);
}

// ────────────────────────────────────────────
// ACP 连接生命周期管理
// ────────────────────────────────────────────

/**
 * ACP 连接建立时激活环境（bound 环境）。
 */
export async function handleAcpConnect(boundEnvId: string | null): Promise<void> {
  if (boundEnvId) {
    await markEnvironmentActive(boundEnvId);
  }
}

/**
 * ACP register 消息处理：bound 环境 → active + 更新 capabilities；unbound → 创建临时环境
 */
export async function handleAcpRegister(params: {
  wsId: string;
  userId: string;
  agentName: string;
  capabilities?: Record<string, unknown>;
  maxSessions?: number;
  directory?: string;
  boundEnvId: string | null;
}): Promise<{ envId: string; isNew: boolean }> {
  if (params.boundEnvId) {
    // 合并 markEnvironmentActive + updateEnvironmentCapabilities 为单次 UPDATE
    await environmentRepo.update(params.boundEnvId, {
      status: "active",
      lastPollAt: new Date(),
      capabilities: params.capabilities ?? undefined,
      maxSessions: params.maxSessions,
    });
    return { envId: params.boundEnvId, isNew: false };
  }

  const record = await createTemporaryEnvironment({
    secret: `ws_${params.wsId}`,
    userId: params.userId,
    machineName: params.agentName,
    directory: params.directory,
    maxSessions: params.maxSessions,
    capabilities: params.capabilities,
  });

  return { envId: record.id, isNew: true };
}

/**
 * ACP identify 消息处理：bound → active；unbound → 验证 + active
 */
export async function handleAcpIdentify(params: {
  agentId: string;
  userId: string;
  boundEnvId: string | null;
}): Promise<{ envId: string; capabilities: Record<string, unknown> | null }> {
  if (params.boundEnvId) {
    // markActive 更新 status/poll，getEnvironment 读取 capabilities，两操作无依赖
    const [, env] = await Promise.all([
      markEnvironmentActive(params.boundEnvId),
      getEnvironment(params.boundEnvId),
    ]);
    return { envId: params.boundEnvId, capabilities: env?.capabilities ?? null };
  }

  const record = await getEnvironment(params.agentId);
  if (!record || record.workerType !== "acp") {
    throw new NotFoundError("Agent not found");
  }
  if (record.userId && record.userId !== params.userId) {
    throw new AppError("Agent not owned by you", "FORBIDDEN", 403);
  }

  await markEnvironmentActive(params.agentId);
  return { envId: record.id, capabilities: record.capabilities ?? null };
}

/**
 * ACP 断连处理：bound → idle；unbound → 删除
 */
export async function handleAcpDisconnect(agentId: string, isBound: boolean): Promise<void> {
  if (isBound) {
    await markEnvironmentIdle(agentId);
  } else {
    await deleteEnvironment(agentId);
  }
}
