import { environmentRepo } from "../repositories";
import { ValidationError, ConflictError, ConfigWriteError, NotFoundError } from "../errors";
import * as configPg from "./config-pg";
import { groupActiveInstancesByEnvironment } from "./instance";
import {
  validateWorkspacePath,
  ensureWorkspaceDir,
  KEBAB_CASE_RE,
  generateEnvSecret,
  sanitizeResponse,
  getOwnedEnvironment,
  deleteEnvironment,
} from "./environment-core";
import type {
  CreateWebEnvironmentParams,
  UpdateWebEnvironmentParams,
} from "./environment-core";
import type { EnvironmentUpdateParams } from "../repositories";

export type { CreateWebEnvironmentParams, UpdateWebEnvironmentParams };

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

  // Agent 配置解析：可选，提供时需验证存在性
  let agentName: string | undefined = undefined;
  if (params.agentConfigId) {
    const agent = await configPg.getAgentConfigById(params.agentConfigId);
    if (!agent) throw new ValidationError(`AgentConfig '${params.agentConfigId}' 不存在`);
    agentName = agent.name;
  }

  // workspace 目录初始化
  try {
    workspacePath = ensureWorkspaceDir(workspacePath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigWriteError(`无法创建目录: ${msg}`);
  }

  // 符号链接逃逸防御：ensureWorkspaceDir 通过 realpathSync 解析了符号链接，
  // 需对真实路径重新校验（如 /tmp/link_to_etc → /etc 会被拦截）
  const realPathError = validateWorkspacePath(workspacePath);
  if (realPathError) throw new ValidationError(realPathError);

  // 创建记录
  const secret = generateEnvSecret();
  let record;
  try {
    record = await environmentRepo.create({
      name,
      description,
      workspacePath,
      agentName,
      status: "idle",
      secret,
      userId,
      autoStart: autoStart === true,
      agentConfigId: params.agentConfigId ?? null,
    });
  } catch (err: unknown) {
    if (err instanceof Error && (err.message?.includes("unique") || err.message?.includes("duplicate") || err.message?.includes("UNIQUE"))) {
      throw new ConflictError(`环境名称 '${name}' 已存在`);
    }
    throw err;
  }

  return record;
}

/** 更新 Web 控制面板 Environment — 包含参数校验、Agent 配置解析 */
export async function updateWebEnvironment(envId: string, userId: string, params: UpdateWebEnvironmentParams) {
  await getOwnedEnvironment(envId, userId);
  const patch: EnvironmentUpdateParams = {};

  if (params.name !== undefined) {
    if (!KEBAB_CASE_RE.test(params.name)) {
      throw new ValidationError("name 必须为 kebab-case 格式");
    }
    patch.name = params.name;
  }
  if (params.workspacePath !== undefined) {
    const pathError = validateWorkspacePath(params.workspacePath);
    if (pathError) throw new ValidationError(pathError);
    const realPath = ensureWorkspaceDir(params.workspacePath);
    // 符号链接逃逸防御：重新校验 realpathSync 解析后的真实路径
    const realPathError = validateWorkspacePath(realPath);
    if (realPathError) throw new ValidationError(realPathError);
    patch.workspacePath = realPath;
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
  const updated = await environmentRepo.getById(envId);
  if (!updated) throw new NotFoundError("环境不存在（更新后未找到）");
  return updated;
}

/** 获取用户所有环境并组装实例信息（web/environments 路由用） */
export async function listEnvironmentsWithInstances(userId: string) {
  const allEnvs = await environmentRepo.listByUserId(userId);
  // 单次遍历按 environmentId 分组实例，避免 N 次 listInstances 调用
  const instanceMap = groupActiveInstancesByEnvironment();
  const results = [];
  for (const env of allEnvs) {
    const activeInstances = instanceMap.get(env.id) ?? [];
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
