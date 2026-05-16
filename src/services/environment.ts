import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { mkdirSync, realpathSync } from "node:fs";
import { environmentRepo, sessionRepo } from "../repositories";
import type { RegisterEnvironmentRequest, EnvironmentResponse } from "../types/api";
import type { EnvironmentRecord } from "../repositories";
import { ValidationError, NotFoundError, ConflictError, ConfigWriteError } from "../errors";
import * as configPg from "./config-pg";
import { findOrCreateForEnvironment } from "./session";
import { listInstancesByEnvironment } from "./instance";
import type { BridgeRegistrationRequest } from "../schemas/v1-environment.schema";

const BLOCKED_PATHS = [
  "/", "/etc", "/usr", "/bin", "/sbin", "/var", "/sys", "/proc",
  "/dev", "/boot", "/lib", "/root",
];

/** 校验 workspace 路径是否安全（不在系统目录下） */
export function validateWorkspacePath(p: string): string | null {
  if (!isAbsolute(p)) return "workspace 路径必须是绝对路径";
  const normalized = resolve(p);
  if (BLOCKED_PATHS.includes(normalized))
    return `不允许使用系统目录: ${normalized}`;
  for (const blocked of BLOCKED_PATHS) {
    if (blocked !== "/" && normalized.startsWith(blocked + "/")) {
      return `不允许使用系统目录下的路径: ${normalized}`;
    }
  }
  return null;
}

/** 确保 workspace 目录存在，返回真实路径 */
export function ensureWorkspaceDir(workspacePath: string): string {
  mkdirSync(workspacePath, { recursive: true });
  return realpathSync(workspacePath);
}

const KEBAB_CASE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function generateEnvSecret(): string {
  return `env_secret_${randomBytes(24).toString("hex")}`;
}

export interface CreateWebEnvironmentParams {
  name: string;
  description?: string;
  agentConfigId?: string;
  workspacePath: string;
  autoStart?: boolean;
  userId: string;
}

/** 创建 Web 控制面板 Environment — 包含完整的参数校验、Agent 配置解析、目录初始化 */
export async function createWebEnvironment(params: CreateWebEnvironmentParams) {
  const { name, description, autoStart, userId } = params;
  let { workspacePath } = params;

  // 名称校验
  if (!name || !KEBAB_CASE_RE.test(name)) {
    throw new ValidationError("name 必须为 kebab-case 格式（小写字母、数字、连字符）");
  }

  // 路径校验
  const pathError = validateWorkspacePath(workspacePath);
  if (pathError) throw new ValidationError(pathError);

  // Agent 配置解析：必须提供 agentConfigId
  if (!params.agentConfigId) {
    throw new ValidationError("agentConfigId 为必填字段");
  }
  const agent = await configPg.getAgentConfigById(params.agentConfigId);
  if (!agent) throw new ValidationError(`AgentConfig '${params.agentConfigId}' 不存在`);

  // workspace 目录初始化
  try {
    workspacePath = ensureWorkspaceDir(workspacePath);
  } catch (err: any) {
    throw new ConfigWriteError(`无法创建目录: ${err.message}`);
  }

  // 创建记录
  const secret = generateEnvSecret();
  let record;
  try {
    record = await environmentRepo.create({
      name,
      description,
      workspacePath,
      agentName: agent.name,
      status: "idle",
      secret,
      userId,
      autoStart: autoStart === true,
      agentConfigId: params.agentConfigId,
    });
  } catch (err: any) {
    if (err.message?.includes("unique") || err.message?.includes("duplicate") || err.message?.includes("UNIQUE")) {
      throw new ConflictError(`环境名称 '${name}' 已存在`);
    }
    throw err;
  }

  return record;
}

function toResponse(row: EnvironmentRecord): EnvironmentResponse {
  return {
    id: row.id,
    machine_name: row.machineName,
    directory: row.directory,
    branch: row.branch,
    status: row.status,
    username: row.username,
    last_poll_at: row.lastPollAt ? row.lastPollAt.getTime() / 1000 : null,
    worker_type: row.workerType,
    capabilities: row.capabilities,
  };
}

export async function registerEnvironment(req: RegisterEnvironmentRequest & { metadata?: { worker_type?: string }; username?: string; userId?: string }) {
  const secret = `env_${randomBytes(24).toString("hex")}`;
  const workerType = req.worker_type || req.metadata?.worker_type;
  const record = await environmentRepo.create({
    secret,
    userId: req.userId || "system",
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
  return { environment_id: record.id, environment_secret: record.secret, status: record.status as "active", session_id: undefined };
}

export async function deregisterEnvironment(envId: string) {
  await environmentRepo.update(envId, { status: "deregistered" });
}

export async function getEnvironment(envId: string) {
  return environmentRepo.getById(envId);
}

export async function updatePollTime(envId: string) {
  await environmentRepo.update(envId, { lastPollAt: new Date() });
}

export async function listActiveEnvironments() {
  return environmentRepo.listActive();
}

export async function listActiveEnvironmentsResponse(): Promise<EnvironmentResponse[]> {
  const envs = await environmentRepo.listActive();
  return envs.map(toResponse);
}

export async function listActiveEnvironmentsByUsername(username: string): Promise<EnvironmentResponse[]> {
  const envs = await environmentRepo.listActiveByUsername(username);
  return envs.map(toResponse);
}

export async function reconnectEnvironment(envId: string) {
  await environmentRepo.update(envId, { status: "active" });
}

/** Delete environment */
export async function deleteEnvironment(envId: string): Promise<boolean> {
  return environmentRepo.delete(envId);
}

// ────────────────────────────────────────────
// Web 控制面板专用接口
// ────────────────────────────────────────────

/** 将 EnvironmentRecord 转为 API 响应格式 */
export function sanitizeResponse(row: EnvironmentRecord) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    workspace_path: row.workspacePath,
    agent_name: row.agentName ?? null,
    agent_config_id: row.agentConfigId ?? null,
    status: row.status,
    machine_name: row.machineName ?? null,
    branch: row.branch ?? null,
    auto_start: row.autoStart ?? false,
    last_poll_at: row.lastPollAt
      ? Math.floor(new Date(row.lastPollAt).getTime() / 1000)
      : null,
    created_at: Math.floor(new Date(row.createdAt).getTime() / 1000),
    updated_at: Math.floor(new Date(row.updatedAt).getTime() / 1000),
  };
}

/** 获取 Environment 并验证归属，未找到或不属于该用户时抛出 NotFoundError */
export async function getOwnedEnvironment(envId: string, userId: string) {
  const env = await environmentRepo.getById(envId);
  if (!env || env.userId !== userId) {
    throw new NotFoundError("环境不存在");
  }
  return env;
}

export interface UpdateWebEnvironmentParams {
  name?: string;
  description?: string | null;
  workspacePath?: string;
  agentConfigId?: string | null;
  autoStart?: boolean;
}

/** 更新 Web 控制面板 Environment — 包含参数校验、Agent 配置解析 */
export async function updateWebEnvironment(envId: string, userId: string, params: UpdateWebEnvironmentParams) {
  await getOwnedEnvironment(envId, userId);
  const patch: Record<string, unknown> = {};

  if (params.name !== undefined) {
    if (!KEBAB_CASE_RE.test(params.name)) {
      throw new ValidationError("name 必须为 kebab-case 格式");
    }
    patch.name = params.name;
  }
  if (params.workspacePath !== undefined) {
    const pathError = validateWorkspacePath(params.workspacePath);
    if (pathError) throw new ValidationError(pathError);
    patch.workspacePath = ensureWorkspaceDir(params.workspacePath);
  }
  if (params.agentConfigId !== undefined) {
    if (params.agentConfigId) {
      const agent = await configPg.getAgentConfigById(params.agentConfigId);
      if (!agent) throw new ValidationError(`AgentConfig '${params.agentConfigId}' 不存在`);
      patch.agentConfigId = params.agentConfigId;
      patch.agentName = agent.name;
    } else {
      patch.agentConfigId = null;
      patch.agentName = null;
    }
  }
  if (params.description !== undefined) {
    patch.description = params.description;
  }
  if (params.autoStart !== undefined) {
    patch.autoStart = !!params.autoStart;
  }

  await environmentRepo.update(envId, patch);
  return environmentRepo.getById(envId);
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
      await environmentRepo.update(authEnvironmentId, {
        status: "active",
        lastPollAt: new Date(),
        capabilities: capabilities || undefined,
        maxSessions: max_sessions,
      });

      const sessions = await sessionRepo.listByEnvironment(authEnvironmentId);
      return {
        environment_id: existing.id,
        environment_secret: existing.secret,
        status: "active",
        session_id: sessions.length > 0 ? sessions[0].id : undefined,
      };
    }
  }

  // 新环境：创建 + 自动会话
  const workerType = input.worker_type || metadata?.worker_type || "acp";
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
// Web 控制面板列表组装
// ────────────────────────────────────────────

/** 获取用户所有环境并组装实例信息（web/environments 路由用） */
export async function listEnvironmentsWithInstances(userId: string) {
  const allEnvs = await environmentRepo.listByUserId(userId);
  const results = [];
  for (const env of allEnvs) {
    const activeInstances = listInstancesByEnvironment(env.id);
    const firstInstance = activeInstances[0];
    results.push({
      ...sanitizeResponse(env),
      session_id: firstInstance?.sessionId ?? null,
      instance_status: firstInstance ? firstInstance.status : null,
      instance_id: firstInstance ? firstInstance.id : null,
      instances: activeInstances.map((inst) => ({
        id: inst.id,
        instance_number: inst.instanceNumber,
        status: inst.status,
        session_id: inst.sessionId ?? null,
        port: inst.port,
        created_at: Math.floor(inst.createdAt.getTime() / 1000),
      })),
      instances_count: activeInstances.length,
    });
  }
  return results;
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
    await markEnvironmentActive(params.boundEnvId);
    await updateEnvironmentCapabilities(params.boundEnvId, {
      capabilities: params.capabilities || null,
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
    await markEnvironmentActive(params.boundEnvId);
    const env = await getEnvironment(params.boundEnvId);
    return { envId: params.boundEnvId, capabilities: env?.capabilities || null };
  }

  const record = await getEnvironment(params.agentId);
  if (!record || record.workerType !== "acp") {
    throw Object.assign(new Error("Agent not found"), { code: "NOT_FOUND" });
  }
  if (record.userId && record.userId !== params.userId) {
    throw Object.assign(new Error("Agent not owned by you"), { code: "FORBIDDEN" });
  }

  await markEnvironmentActive(params.agentId);
  return { envId: record.id, capabilities: record.capabilities || null };
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
