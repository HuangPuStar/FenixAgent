import { randomBytes } from "node:crypto";
import { createLogger } from "@fenix/logger";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { agentConfig, environment, machine } from "../db/schema";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import type { EnvironmentRecord, EnvironmentUpdateParams } from "../repositories";
import { environmentRepo } from "../repositories";
import * as configPg from "./config/index";
import type { CreateWebEnvironmentParams, UpdateWebEnvironmentParams } from "./environment-core";
import { generateEnvSecret, getOwnedEnvironment, KEBAB_CASE_RE } from "./environment-core";
import { groupActiveInstancesByEnvironment } from "./instance";
import { resolveWorkspacePath } from "./workspace-resolver";

export type { CreateWebEnvironmentParams, UpdateWebEnvironmentParams };

const logger = createLogger("environment-web");

/**
 * 判断数据库错误是否由唯一索引冲突触发。
 */
function isUniqueConstraintError(err: unknown): boolean {
  const candidate = err as {
    message?: string;
    code?: string;
    cause?: { message?: string; code?: string } | null;
  } | null;
  const message = candidate?.message ?? candidate?.cause?.message ?? "";
  const code = candidate?.code ?? candidate?.cause?.code ?? "";
  return (
    code === "23505" ||
    message.includes("unique") ||
    message.includes("duplicate") ||
    message.includes("UNIQUE") ||
    message.includes("23505")
  );
}

/**
 * 将 environment 表行转换为 service 层统一使用的记录结构。
 */
function toEnvironmentRecord(row: typeof environment.$inferSelect): EnvironmentRecord {
  const computedWorkspace = resolveWorkspacePath(row.organizationId ?? row.userId ?? "", row.userId ?? "", row.id);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    workspacePath: computedWorkspace,
    agentConfigId: row.agentConfigId ?? null,
    secret: row.secret,
    machineName: row.machineName,
    directory: computedWorkspace,
    branch: row.branch,
    gitRepoUrl: row.gitRepoUrl,
    maxSessions: row.maxSessions,
    workerType: row.workerType,
    capabilities: (row.capabilities as Record<string, unknown>) ?? null,
    status: row.status,
    username: null,
    userId: row.userId,
    organizationId: row.organizationId ?? null,
    autoStart: row.autoStart ?? false,
    lastPollAt: row.lastPollAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * 为“创建或复用 environment”场景查找现有记录。
 * 优先按 agentConfigId 复用，避免模板创建后立刻点击时重复创建同一智能体的 environment。
 */
async function findReusableEnvironment(params: CreateWebEnvironmentParams): Promise<EnvironmentRecord | null> {
  const organizationId = params.organizationId ?? params.userId;
  const environments = await db.select().from(environment).where(eq(environment.organizationId, organizationId));

  // 绑定 agent 的 runtime environment 需要和访问者一一对应；
  // 否则同组织成员会复用彼此的 workspace，导致环境准备和文件视图都落到错误用户目录。
  const matched =
    environments.find((env) => env.agentConfigId === params.agentConfigId && env.userId === params.userId) ?? null;
  return matched ? toEnvironmentRecord(matched) : null;
}

/**
 * 直接插入 environment 表并返回完整记录。
 * 这里不走 repository.create，避免不同入口在测试桩下出现行为分叉。
 */
async function insertEnvironmentRecord(params: {
  id: string;
  name: string;
  description?: string;
  secret: string;
  userId: string;
  organizationId: string;
  autoStart: boolean;
  agentConfigId: string | null;
  machineName?: string;
}): Promise<EnvironmentRecord> {
  const now = new Date();
  await db.insert(environment).values({
    id: params.id,
    name: params.name,
    description: params.description ?? null,
    workspacePath: "",
    agentConfigId: params.agentConfigId,
    status: "idle",
    secret: params.secret,
    userId: params.userId,
    organizationId: params.organizationId,
    autoStart: params.autoStart,
    machineName: params.machineName ?? null,
    maxSessions: 1,
    workerType: "acp",
    capabilities: null,
    branch: null,
    gitRepoUrl: null,
    lastPollAt: now,
  });

  return toEnvironmentRecord({
    id: params.id,
    name: params.name,
    description: params.description ?? null,
    workspacePath: "",
    agentConfigId: params.agentConfigId,
    status: "idle",
    machineName: params.machineName ?? null,
    branch: null,
    gitRepoUrl: null,
    maxSessions: 1,
    workerType: "acp",
    capabilities: null,
    secret: params.secret,
    userId: params.userId,
    organizationId: params.organizationId,
    autoStart: params.autoStart,
    lastPollAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

/** 创建 Web 控制面板 Environment — workspace 路径运行时实时计算，创建时写空字符串 */
export async function createWebEnvironment(params: CreateWebEnvironmentParams) {
  const { name } = params;
  const { description, autoStart, userId, organizationId } = params;

  // 名称校验
  if (!name || !KEBAB_CASE_RE.test(name)) {
    throw new ValidationError("name 必须为 kebab-case 格式（小写字母、数字、连字符）");
  }
  if (!params.agentConfigId) {
    throw new ValidationError("agentConfigId 必填");
  }

  // Agent 配置校验：环境必须绑定 Agent 配置，并自动填充 machineName
  let machineName: string | undefined;
  const agent = await configPg.getReadableAgentConfigById(
    { organizationId: organizationId ?? userId, userId, role: "owner" },
    params.agentConfigId,
  );
  if (!agent) throw new ValidationError(`AgentConfig '${params.agentConfigId}' 不存在`);
  // 通过 AgentConfig 找到绑定的 machine，取其 agentName 作为 machineName
  if (agent.machineId) {
    const m = await db
      .select({ agentName: machine.agentName })
      .from(machine)
      .where(eq(machine.id, agent.machineId))
      .limit(1);
    machineName = m[0]?.agentName ?? undefined;
  }

  // 先复用已有 environment，避免“模板创建后马上点击”时两个入口为同一 agent 重复建环境。
  const existing = await findReusableEnvironment(params);
  if (existing) {
    logger.info(
      `[createWebEnvironment] reuse existing environment id='${existing.id}', name='${existing.name}', agentConfigId='${existing.agentConfigId ?? ""}'`,
    );
    return existing;
  }

  // 预生成 environment ID（workspace 路径运行时实时计算）
  const envId = `env_${randomBytes(12).toString("hex")}`;

  // 创建记录，workspacePath 写空字符串
  const secret = generateEnvSecret();
  let record: EnvironmentRecord;
  try {
    record = await insertEnvironmentRecord({
      id: envId,
      name,
      description,
      secret,
      userId,
      organizationId: organizationId ?? userId,
      autoStart: autoStart !== false,
      agentConfigId: params.agentConfigId,
      machineName,
    });
  } catch (err: unknown) {
    // 这里保留二次回查，覆盖“两个请求几乎同时都查不到，再由唯一索引挡住第二个插入”的竞态窗口。
    if (isUniqueConstraintError(err)) {
      const existingAfterConflict = await findReusableEnvironment(params);
      if (existingAfterConflict) {
        logger.warn(
          `[createWebEnvironment] detected concurrent create, reuse existing environment id='${existingAfterConflict.id}', name='${existingAfterConflict.name}', agentConfigId='${existingAfterConflict.agentConfigId ?? ""}'`,
        );
        return existingAfterConflict;
      }
      throw new ConflictError("环境创建冲突，请稍后重试");
    }
    throw err;
  }

  return record;
}

/** 更新 Web 控制面板 Environment — 不再允许修改 workspacePath */
export async function updateWebEnvironment(envId: string, organizationId: string, params: UpdateWebEnvironmentParams) {
  const existingEnv = await getOwnedEnvironment(envId, organizationId);
  const patch: EnvironmentUpdateParams = {};

  if (params.name !== undefined) {
    if (!KEBAB_CASE_RE.test(params.name)) {
      throw new ValidationError("name 必须为 kebab-case 格式");
    }
    patch.name = params.name;
  }
  if (params.agentConfigId !== undefined) {
    const agent = await configPg.getReadableAgentConfigById(
      { organizationId, userId: existingEnv.userId ?? organizationId, role: "owner" },
      params.agentConfigId,
    );
    if (!agent) throw new ValidationError(`AgentConfig '${params.agentConfigId}' 不存在`);
    patch.agentConfigId = params.agentConfigId;
    let machineName: string | null = null;
    if (agent.machineId) {
      const m = await db
        .select({ agentName: machine.agentName })
        .from(machine)
        .where(eq(machine.id, agent.machineId))
        .limit(1);
      machineName = m[0]?.agentName ?? null;
    }
    patch.machineName = machineName;
  }
  if (params.description !== undefined) {
    patch.description = params.description;
  }
  if (params.autoStart !== undefined) {
    patch.autoStart = !!params.autoStart;
  }

  await environmentRepo.update(envId, patch);
  const updated = await environmentRepo.getById(envId);
  if (!updated) throw new NotFoundError("环境不存在（更新后未找到）");
  return updated;
}

/** 获取团队所有环境并组装实例信息（web/environments 路由用） */
export async function listEnvironmentsWithInstances(organizationId: string, viewerUserId?: string) {
  // LEFT JOIN agentConfig 一次性拿到 environment + agent_name
  const rows = await db
    .select({
      env: environment,
      agentName: agentConfig.name,
    })
    .from(environment)
    .leftJoin(agentConfig, eq(environment.agentConfigId, agentConfig.id))
    .where(and(eq(environment.organizationId, organizationId), isNotNull(environment.agentConfigId)));

  // 单次遍历按 environmentId 分组实例，避免 N 次 listInstances 调用
  const instanceMap = groupActiveInstancesByEnvironment();
  const results = [];
  for (const { env, agentName } of rows) {
    // agent 绑定的 runtime environment 是按用户隔离的；列表页只暴露当前用户自己的 runtime，
    // 避免前端把其他成员的 env 误挂到自己看到的 agent 上。
    if (viewerUserId && env.agentConfigId && env.userId !== viewerUserId) {
      continue;
    }
    const activeInstances = instanceMap.get(env.id) ?? [];
    const firstInstance = activeInstances[0];
    results.push({
      id: env.id,
      name: env.name,
      description: env.description ?? null,
      workspace_path: env.workspacePath,
      agent_config_id: env.agentConfigId ?? null,
      agent_name: agentName ?? null,
      status: env.status,
      machine_name: env.machineName ?? null,
      branch: env.branch ?? null,
      auto_start: env.autoStart ?? false,
      last_poll_at: env.lastPollAt ? Math.floor(env.lastPollAt.getTime() / 1000) : null,
      created_at: Math.floor(env.createdAt.getTime() / 1000),
      updated_at: Math.floor(env.updatedAt.getTime() / 1000),
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

/** Phase 2: enterEnvironment 不再 spawn 本地实例，直接返回 environment 信息（relay 连接负责启动远端 agent） */
export async function enterEnvironment(_userId: string, envId: string, _instanceNumber?: number) {
  const env = await environmentRepo.getById(envId);
  if (!env) throw new NotFoundError("环境不存在");
  return {
    environment_id: envId,
    instance_id: envId, // 复用 envId 作为 instance_id，兼容前端
    session_id: null,
  };
}
