import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentConfig, environment, machine } from "../db/schema";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import type { EnvironmentUpdateParams } from "../repositories";
import { environmentRepo } from "../repositories";
import * as configPg from "./config/index";
import type { CreateWebEnvironmentParams, UpdateWebEnvironmentParams } from "./environment-core";
import { generateEnvSecret, getOwnedEnvironment, KEBAB_CASE_RE } from "./environment-core";
import { groupActiveInstancesByEnvironment } from "./instance";

export type { CreateWebEnvironmentParams, UpdateWebEnvironmentParams };

/** 创建 Web 控制面板 Environment — workspace 路径运行时实时计算，创建时写空字符串 */
export async function createWebEnvironment(params: CreateWebEnvironmentParams) {
  const { name, description, autoStart, userId, organizationId } = params;

  // 名称校验
  if (!name || !KEBAB_CASE_RE.test(name)) {
    throw new ValidationError("name 必须为 kebab-case 格式（小写字母、数字、连字符）");
  }

  // Agent 配置校验：可选，提供时需验证存在性，并自动填充 machineName
  let machineName: string | undefined;
  if (params.agentConfigId) {
    const agent = await configPg.getAgentConfigById(params.agentConfigId, organizationId);
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
  }

  // 预生成 environment ID（workspace 路径运行时实时计算）
  const envId = `env_${randomBytes(12).toString("hex")}`;

  // 创建记录，workspacePath 写空字符串
  const secret = generateEnvSecret();
  let record: Awaited<ReturnType<typeof environmentRepo.create>>;
  try {
    record = await environmentRepo.create({
      id: envId,
      name,
      description,
      workspacePath: "",
      status: "idle",
      secret,
      userId,
      organizationId: organizationId ?? userId,
      autoStart: autoStart !== false,
      agentConfigId: params.agentConfigId ?? null,
      machineName,
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
