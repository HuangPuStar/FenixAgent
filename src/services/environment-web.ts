import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentConfig, environment } from "../db/schema";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import type { EnvironmentUpdateParams } from "../repositories";
import { environmentRepo } from "../repositories";
import * as configPg from "./config-pg";
import type { CreateWebEnvironmentParams, UpdateWebEnvironmentParams } from "./environment-core";
import { generateEnvSecret, getOwnedEnvironment, KEBAB_CASE_RE } from "./environment-core";
import { groupActiveInstancesByEnvironment } from "./instance";
import { resolveWorkspacePath } from "./workspace-resolver";

export type { CreateWebEnvironmentParams, UpdateWebEnvironmentParams };

/** 创建 Web 控制面板 Environment — workspace 路径由 orgId + userId 自动计算 */
export async function createWebEnvironment(params: CreateWebEnvironmentParams) {
  const { name, description, autoStart, userId, organizationId } = params;

  // 名称校验
  if (!name || !KEBAB_CASE_RE.test(name)) {
    throw new ValidationError("name 必须为 kebab-case 格式（小写字母、数字、连字符）");
  }

  // Agent 配置校验：可选，提供时需验证存在性
  if (params.agentConfigId) {
    const agent = await configPg.getAgentConfigById(params.agentConfigId, organizationId);
    if (!agent) throw new ValidationError(`AgentConfig '${params.agentConfigId}' 不存在`);
  }

  // workspace 路径由 orgId + userId 自动计算
  const workspacePath = resolveWorkspacePath(organizationId ?? userId, userId);

  // 创建记录
  const secret = generateEnvSecret();
  let record: Awaited<ReturnType<typeof environmentRepo.create>>;
  try {
    record = await environmentRepo.create({
      name,
      description,
      workspacePath,
      status: "idle",
      secret,
      userId,
      organizationId: organizationId ?? userId,
      autoStart: autoStart !== false,
      agentConfigId: params.agentConfigId ?? null,
    });
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (err.message?.includes("unique") || err.message?.includes("duplicate") || err.message?.includes("UNIQUE"))
    ) {
      throw new ConflictError(`环境名称 '${name}' 已存在`);
    }
    throw err;
  }

  return record;
}

/** 更新 Web 控制面板 Environment — 不再允许修改 workspacePath */
export async function updateWebEnvironment(envId: string, organizationId: string, params: UpdateWebEnvironmentParams) {
  await getOwnedEnvironment(envId, organizationId);
  const patch: EnvironmentUpdateParams = {};

  if (params.name !== undefined) {
    if (!KEBAB_CASE_RE.test(params.name)) {
      throw new ValidationError("name 必须为 kebab-case 格式");
    }
    patch.name = params.name;
  }
  if (params.agentConfigId !== undefined) {
    if (params.agentConfigId) {
      const agent = await configPg.getAgentConfigById(params.agentConfigId, organizationId);
      if (!agent) throw new ValidationError(`AgentConfig '${params.agentConfigId}' 不存在`);
      patch.agentConfigId = params.agentConfigId;
    } else {
      patch.agentConfigId = null;
    }
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
export async function listEnvironmentsWithInstances(organizationId: string) {
  // LEFT JOIN agentConfig 一次性拿到 environment + agent_name
  const rows = await db
    .select({
      env: environment,
      agentName: agentConfig.name,
    })
    .from(environment)
    .leftJoin(agentConfig, eq(environment.agentConfigId, agentConfig.id))
    .where(eq(environment.organizationId, organizationId));

  // 单次遍历按 environmentId 分组实例，避免 N 次 listInstances 调用
  const instanceMap = groupActiveInstancesByEnvironment();
  const results = [];
  for (const { env, agentName } of rows) {
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
