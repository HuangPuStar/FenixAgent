import {
  type AgentKnowledgeConfig,
  getAgentKnowledgeConfigById,
  listAgentKnowledgeBindingsById,
  syncAgentKnowledgeBindingsById,
} from "@fenix/resource-knowledge/server";
import { listAgentMcpIds, syncAgentMcps } from "@fenix/resource-mcp/server";
import * as agentMemoryConfigRepo from "@fenix/resource-memory/server";
import { isAgentMemoryEnabled } from "@fenix/resource-memory/server";
import { listAgentSkillIds, listSkills, syncAgentSkills } from "@fenix/resource-skill/server";
import { db } from "@server/db";
import { agentSiteApp, knowledgeBase, machine, mcpServer, model, provider, skill } from "@server/db/schema";
import { AppError } from "@server/errors";
import type { AuthContext } from "@server/plugins/auth";
import { getUserConfig, setUserConfig } from "@server/services/config/user-config";
import {
  configError,
  configNotFound,
  configSuccess,
  configValidationError,
  isValidResourceName,
} from "@server/services/config-utils";
import { and, eq, inArray } from "drizzle-orm";
import {
  AgentMutationBodySchema,
  AgentNameQuerySchema,
  AgentTemplatesResponseSchema,
  CreateAgentResponseSchema,
  DeleteAgentResponseSchema,
  GetAgentResponseSchema,
  RestartAgentResponseSchema,
  SetDefaultAgentRequestSchema,
  SetDefaultAgentResponseSchema,
  UpdateAgentRequestSchema,
  UpdateAgentResponseSchema,
} from "../../../schemas/config.schema";
import { loadAgentTemplates } from "../../../services/agent-templates";
import {
  AGENT_SETTABLE_FIELDS,
  isBuiltInAgent,
  normalizeKnowledgeConfig,
  resolveAgentNode,
  validateAgentData,
} from "../../../services/config/agent-config";
import type { AgentNode } from "../../../services/config/types";
import { routeConfigDeps as configPg } from "../../config-route-deps";

interface AgentRelatedResourceView {
  modelLabel: string | null;
  machineLabel: string | null;
  skills: Array<{ id: string; label: string }>;
  mcps: Array<{ id: string; label: string }>;
  knowledgeBases: Array<{ id: string; label: string; slug?: string | null }>;
  siteApps: Array<{ id: string; label: string; remoteAppId: string | null }>;
}

interface AgentResourceDisplayInput {
  id: string;
  organizationId: string;
  modelId: string | null;
  agentNode: AgentNode;
  resourceAccess?: {
    sourceOrganizationId: string;
  };
}

async function buildAgentRelatedResourceView(
  agent: AgentResourceDisplayInput,
  skillIds: string[],
  mcpIds: string[],
  siteAppIds: string[],
): Promise<AgentRelatedResourceView> {
  const fallback: AgentRelatedResourceView = {
    modelLabel: agent.modelId ?? null,
    machineLabel: agent.agentNode.kind === "machine" ? agent.agentNode.machineId : null,
    skills: skillIds.map((id) => ({ id, label: id })),
    mcps: mcpIds.map((id) => ({ id, label: id })),
    knowledgeBases: [],
    siteApps: siteAppIds.map((id) => ({ id, label: id, remoteAppId: null })),
  };

  try {
    const sourceOrganizationId = agent.resourceAccess?.sourceOrganizationId ?? agent.organizationId;
    let modelLabel: string | null = null;

    if (agent.modelId) {
      const modelRows = await db
        .select({
          id: model.id,
          modelName: model.modelId,
          displayName: model.displayName,
          providerId: model.providerId,
          providerOrganizationId: model.organizationId,
        })
        .from(model)
        .where(eq(model.id, agent.modelId))
        .limit(1);
      const modelRow = modelRows[0];
      if (modelRow) {
        const providerRows = await db
          .select({ id: provider.id, name: provider.name, displayName: provider.displayName })
          .from(provider)
          .where(
            and(eq(provider.id, modelRow.providerId), eq(provider.organizationId, modelRow.providerOrganizationId)),
          )
          .limit(1);
        const providerRow = providerRows[0];
        if (providerRow) {
          const providerName = providerRow.displayName ?? providerRow.name;
          const modelName = modelRow.displayName ?? modelRow.modelName;
          modelLabel = `${providerName}/${modelName}`;
        }
      }

      if (!modelLabel) modelLabel = agent.modelId;
    }

    let machineLabel: string | null = null;
    if (agent.agentNode.kind === "machine") {
      const machineRows = await db
        .select({ id: machine.id, agentName: machine.agentName, name: machine.name, machineInfo: machine.machineInfo })
        .from(machine)
        .where(eq(machine.id, agent.agentNode.machineId))
        .limit(1);
      const machineRow = machineRows[0];
      if (machineRow) {
        const hostname =
          machineRow.machineInfo && typeof machineRow.machineInfo === "object"
            ? ((machineRow.machineInfo as { hostname?: string }).hostname ?? "")
            : "";
        machineLabel = machineRow.name || hostname || machineRow.agentName;
      } else {
        machineLabel = agent.agentNode.machineId;
      }
    }

    const skillLabels =
      skillIds.length > 0
        ? await db.select({ id: skill.id, label: skill.name }).from(skill).where(inArray(skill.id, skillIds))
        : [];
    const skillLabelMap = new Map(skillLabels.map((item) => [item.id, item.label]));
    const mcpLabels =
      mcpIds.length > 0
        ? await db
            .select({ id: mcpServer.id, label: mcpServer.name })
            .from(mcpServer)
            .where(inArray(mcpServer.id, mcpIds))
        : [];
    const mcpLabelMap = new Map(mcpLabels.map((item) => [item.id, item.label]));

    const knowledgeBindings = await listAgentKnowledgeBindingsById(agent.id);
    const knowledgeBaseIds = knowledgeBindings.map((binding) => binding.knowledgeBaseId);
    const knowledgeBaseRows =
      knowledgeBaseIds.length > 0
        ? await db
            .select({ id: knowledgeBase.id, name: knowledgeBase.name, slug: knowledgeBase.slug })
            .from(knowledgeBase)
            .where(
              and(inArray(knowledgeBase.id, knowledgeBaseIds), eq(knowledgeBase.organizationId, sourceOrganizationId)),
            )
        : [];
    const knowledgeBaseMap = new Map(knowledgeBaseRows.map((item) => [item.id, item]));

    const siteAppRows =
      siteAppIds.length > 0
        ? await db
            .select({ id: agentSiteApp.id, name: agentSiteApp.name, remoteAppId: agentSiteApp.remoteAppId })
            .from(agentSiteApp)
            .where(and(inArray(agentSiteApp.id, siteAppIds), eq(agentSiteApp.organizationId, sourceOrganizationId)))
        : [];
    const siteAppMap = new Map(siteAppRows.map((item) => [item.id, item]));

    return {
      modelLabel,
      machineLabel,
      skills: skillIds.map((id) => ({ id, label: skillLabelMap.get(id) ?? id })),
      mcps: mcpIds.map((id) => ({ id, label: mcpLabelMap.get(id) ?? id })),
      knowledgeBases: knowledgeBaseIds.map((id) => {
        const item = knowledgeBaseMap.get(id);
        return { id, label: item?.name ?? id, slug: item?.slug ?? null };
      }),
      siteApps: siteAppIds.map((id) => {
        const item = siteAppMap.get(id);
        return {
          id,
          label: item?.name ?? id,
          remoteAppId: item?.remoteAppId ?? null,
        };
      }),
    };
  } catch {
    return fallback;
  }
}

/** 构建 agent 列表视图，并补齐前端展示依赖的资源标签。 */
async function handleList(ctx: AuthContext) {
  const agents = await configPg.listAgentConfigs(ctx);
  const uc = await getUserConfig(ctx);
  const defaultAgent = uc.defaultAgent ?? null;
  const list = await Promise.all(
    agents.map(async (a) => {
      const skillIds = await listAgentSkillIds(a.id);
      const mcpIds = await listAgentMcpIds(a.id);
      const siteAppIds = await configPg.listAgentSiteAppIds(a.id);
      const relatedResources = await buildAgentRelatedResourceView(
        {
          id: a.id,
          organizationId: a.organizationId,
          modelId: a.modelId ?? null,
          agentNode: resolveAgentNode(a) ?? {},
          resourceAccess: a.resourceAccess,
        },
        skillIds,
        mcpIds,
        siteAppIds,
      );
      return {
        id: a.id,
        name: a.name,
        builtIn: isBuiltInAgent(a.name),
        model: a.model ?? null,
        modelId: a.modelId ?? null,
        modelLabel: relatedResources.modelLabel,
        description: a.description ?? null,
        agentNode: resolveAgentNode(a) ?? {},
        knowledgeBaseCount: (await listAgentKnowledgeBindingsById(a.id)).length,
        skillLabels: relatedResources.skills,
        resourceAccess: a.resourceAccess,
      };
    }),
  );
  return configSuccess({ default_agent: defaultAgent, agents: list });
}

/** 读取单个 agent 详情，保留原接口返回结构以兼容现有前端状态。 */
async function handleGet(ctx: AuthContext, name: string) {
  const agent = await configPg.getAgentConfig(ctx, name);
  if (!agent) return configNotFound(`Agent '${name}' not found`);

  const skillIds = await listAgentSkillIds(agent.id);
  const mcpIds = await listAgentMcpIds(agent.id);
  const siteAppIds = await configPg.listAgentSiteAppIds(agent.id);
  const relatedResources = await buildAgentRelatedResourceView(
    { ...agent, agentNode: resolveAgentNode(agent) ?? {} },
    skillIds,
    mcpIds,
    siteAppIds,
  );
  const knowledge = await getAgentKnowledgeConfigById(agent.id);

  return configSuccess({
    id: agent.id,
    name: agent.name,
    builtIn: isBuiltInAgent(agent.name),
    model: agent.model ?? null,
    modelId: agent.modelId ?? null,
    prompt: agent.prompt ?? null,
    description: agent.description ?? null,
    extra: agent.extra ?? null,
    knowledge: normalizeKnowledgeConfig(knowledge ?? null),
    agentNode: resolveAgentNode(agent) ?? {},
    enableMemory: await isAgentMemoryEnabled(agent.id),
    skillIds,
    mcpIds,
    siteAppIds,
    relatedResources,
    resourceAccess: agent.resourceAccess,
  });
}

/** 更新 agent 配置，并同步 knowledge / skills / MCP 等关联资源。 */
async function handleSet(ctx: AuthContext, name: string, data: Record<string, unknown>) {
  const validation = validateAgentData(data);
  if (validation) return configValidationError(validation);

  // 提取 enableMemory（非 agent_config 列，不在白名单中处理）
  const enableMemory: boolean | undefined = typeof data.enableMemory === "boolean" ? data.enableMemory : undefined;
  delete data.enableMemory;

  const publicReadable = typeof data.publicReadable === "boolean" ? data.publicReadable : undefined;

  // 白名单过滤
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (AGENT_SETTABLE_FIELDS.includes(key as (typeof AGENT_SETTABLE_FIELDS)[number])) {
      filtered[key] = key === "knowledge" ? normalizeKnowledgeConfig(value) : value;
    }
  }

  // 检查 agent 是否存在且当前组织可写
  let existing: Awaited<ReturnType<typeof configPg.assertAgentConfigInternalWritable>> | null = null;
  try {
    existing = await configPg.assertAgentConfigInternalWritable(ctx, name);
  } catch (error_) {
    if (error_ instanceof AppError && error_.code === "FORBIDDEN") {
      return configError("FORBIDDEN", error_.message);
    }
    throw error_;
  }
  if (!existing) return configNotFound(`Agent '${name}' not found`);
  const updateData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filtered)) {
    if (key === "knowledge" && value == null) {
      updateData[key] = null;
    } else {
      updateData[key] = value;
    }
  }

  await configPg.updateAgentConfig(ctx, name, updateData, { publicReadable });
  if (enableMemory !== undefined) {
    await agentMemoryConfigRepo.setEnabled(existing.id, enableMemory);
  }
  const updatedAgent = await configPg.getAgentConfig(ctx, name);
  if (updatedAgent) {
    await syncAgentKnowledgeBindingsById(
      updatedAgent.id,
      filtered.knowledge as AgentKnowledgeConfig | null | undefined,
    );
    if (data.skillIds !== undefined) {
      const rawIds = Array.isArray(data.skillIds) ? (data.skillIds as string[]) : [];
      const resolvedIds = await resolveSkillIds(ctx, rawIds);
      await syncAgentSkills(updatedAgent.id, resolvedIds);
    }
    if (data.mcpIds !== undefined) {
      await syncAgentMcps(updatedAgent.id, Array.isArray(data.mcpIds) ? (data.mcpIds as string[]) : []);
    }
    if (data.siteAppIds !== undefined) {
      await configPg.syncAgentSiteApps(
        updatedAgent.id,
        Array.isArray(data.siteAppIds) ? (data.siteAppIds as string[]) : [],
      );
    }
  }

  return configSuccess({ name, ...filtered, resourceAccess: updatedAgent?.resourceAccess });
}

/** UUID 格式正则 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 将 skill 标识符数组（可能是 UUID 或名称）统一解析为 UUID。
 * 模板和 AI 生成的流程可能传入 skill 名称而非 UUID，需要在此解析。
 */
async function resolveSkillIds(ctx: AuthContext, identifiers: string[]): Promise<string[]> {
  if (identifiers.length === 0) return [];

  // 已经全部是 UUID 则直接返回
  if (identifiers.every((id) => UUID_RE.test(id))) return identifiers;

  const skills = await listSkills(ctx);
  const nameToId = new Map(skills.map((s) => [s.name.toLowerCase(), s.id]));

  return identifiers
    .map((id) => {
      if (UUID_RE.test(id)) return id;
      return nameToId.get(id.toLowerCase()) ?? null;
    })
    .filter((id): id is string => !!id);
}

/** 创建 agent 配置，并在创建后补齐所有关联资源绑定。 */
async function handleCreate(ctx: AuthContext, name: string, data: Record<string, unknown>) {
  if (!isValidResourceName(name)) {
    return configValidationError(
      "Invalid agent name: must be 1-64 characters (letters, numbers, spaces, single hyphens)",
    );
  }
  // 提取 enableMemory（非 agent_config 列，不在白名单中处理）
  const enableMemory: boolean | undefined = typeof data.enableMemory === "boolean" ? data.enableMemory : undefined;
  delete data.enableMemory;

  const validation = validateAgentData(data);
  if (validation) return configValidationError(validation);
  const publicReadable = typeof data.publicReadable === "boolean" ? data.publicReadable : undefined;

  // 白名单过滤
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (AGENT_SETTABLE_FIELDS.includes(key as (typeof AGENT_SETTABLE_FIELDS)[number])) {
      filtered[key] = key === "knowledge" ? normalizeKnowledgeConfig(value) : value;
    }
  }

  // 检查是否已存在
  const existing = await configPg.getAgentConfig(ctx, name);
  if (existing) return configError("ALREADY_EXISTS", `Agent '${name}' already exists`);

  const createdId = await configPg.createAgentConfig(ctx, name, filtered, { publicReadable });
  if (enableMemory !== undefined) {
    await agentMemoryConfigRepo.setEnabled(createdId, enableMemory);
  }
  const createdAgent = await configPg.getAgentConfig(ctx, name);
  if (createdAgent) {
    await syncAgentKnowledgeBindingsById(
      createdAgent.id,
      filtered.knowledge as AgentKnowledgeConfig | null | undefined,
    );
    if (data.skillIds !== undefined) {
      const rawIds = Array.isArray(data.skillIds) ? (data.skillIds as string[]) : [];
      const resolvedIds = await resolveSkillIds(ctx, rawIds);
      await syncAgentSkills(createdAgent.id, resolvedIds);
    }
    if (data.mcpIds !== undefined) {
      await syncAgentMcps(createdAgent.id, Array.isArray(data.mcpIds) ? (data.mcpIds as string[]) : []);
    }
    if (data.siteAppIds !== undefined) {
      await configPg.syncAgentSiteApps(
        createdAgent.id,
        Array.isArray(data.siteAppIds) ? (data.siteAppIds as string[]) : [],
      );
    }
  }

  return configSuccess({ name, id: createdAgent?.id, resourceAccess: createdAgent?.resourceAccess });
}

/** 重启该 Agent 绑定 Environment 下的持久 Instance runtime，Instance 记录保持不变。 */
async function handleRestart(ctx: AuthContext, name: string) {
  let result: Awaited<ReturnType<typeof configPg.restartAgentConfigInstances>>;
  try {
    result = await configPg.restartAgentConfigInstances(ctx, name);
  } catch (error_) {
    if (error_ instanceof AppError && error_.code === "FORBIDDEN") {
      return configError("FORBIDDEN", error_.message);
    }
    throw error_;
  }
  if (!result) return configNotFound(`Agent '${name}' not found`);
  return configSuccess(result);
}

/** 删除 agent，内置 agent 永远不可删除。 */
async function handleDelete(ctx: AuthContext, name: string) {
  if (isBuiltInAgent(name)) {
    return configError("FORBIDDEN", `Cannot delete built-in agent '${name}'`);
  }
  let existing: Awaited<ReturnType<typeof configPg.assertAgentConfigInternalWritable>> | null = null;
  try {
    existing = await configPg.assertAgentConfigInternalWritable(ctx, name);
  } catch (error_) {
    if (error_ instanceof AppError && error_.code === "FORBIDDEN") {
      return configError("FORBIDDEN", error_.message);
    }
    throw error_;
  }
  if (!existing) return configNotFound(`Agent '${name}' not found`);
  const deleted = await configPg.deleteAgentConfig(ctx, name);
  if (!deleted) return configNotFound(`Agent '${name}' not found`);
  return configSuccess(null);
}

function handleTemplates() {
  return configSuccess({ templates: loadAgentTemplates() });
}

/** 设置当前用户的默认 agent。 */
async function handleSetDefault(ctx: AuthContext, name: string) {
  const agent = await configPg.getAgentConfig(ctx, name);
  if (!agent) return configNotFound(`Agent '${name}' not found`);
  await setUserConfig(ctx, { defaultAgent: agent.name });
  return configSuccess({ default_agent: agent.name, resourceAccess: agent.resourceAccess });
}

export const agentRouteModels = {
  "agent-name-query": AgentNameQuerySchema,
  "agent-mutation-body": AgentMutationBodySchema,
  "agent-update-body": UpdateAgentRequestSchema,
  "agent-set-default-body": SetDefaultAgentRequestSchema,
  "agent-templates-response": AgentTemplatesResponseSchema,
  "agent-get-response": GetAgentResponseSchema,
  "agent-create-response": CreateAgentResponseSchema,
  "agent-update-response": UpdateAgentResponseSchema,
  "agent-restart-response": RestartAgentResponseSchema,
  "agent-delete-response": DeleteAgentResponseSchema,
  "agent-set-default-response": SetDefaultAgentResponseSchema,
};

export {
  handleCreate,
  handleDelete,
  handleGet,
  handleList,
  handleRestart,
  handleSet,
  handleSetDefault,
  handleTemplates,
};
