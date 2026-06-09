import { and, eq, inArray } from "drizzle-orm";
import Elysia from "elysia";
import { db } from "../../../db";
import { knowledgeBase, machine, mcpServer, model, provider, skill } from "../../../db/schema";
import { AppError } from "../../../errors";
import { type AuthContext, authGuardPlugin } from "../../../plugins/auth";
import {
  type AgentKnowledgeConfig,
  getAgentKnowledgeConfigById,
  InvalidKnowledgeBindingError,
  listAgentKnowledgeBindingsById,
  syncAgentKnowledgeBindingsById,
} from "../../../services/agent-knowledge";
import {
  AGENT_SETTABLE_FIELDS,
  isBuiltInAgent,
  normalizeKnowledgeConfig,
  toolsToPermission,
  validateAgentData,
} from "../../../services/config/agent-config";
import * as configPg from "../../../services/config/index";
import {
  configError,
  configNotFound,
  configSuccess,
  configValidationError,
  isValidResourceName,
} from "../../../services/config-utils";
import { ensureHindsightMcpServer } from "../../../services/hindsight";

interface AgentRelatedResourceView {
  modelLabel: string | null;
  machineLabel: string | null;
  skills: Array<{ id: string; label: string }>;
  mcps: Array<{ id: string; label: string }>;
  knowledgeBases: Array<{ id: string; label: string; slug?: string | null }>;
}

interface AgentResourceDisplayInput {
  id: string;
  organizationId: string;
  modelId: string | null;
  machineId: string | null;
  resourceAccess?: {
    sourceOrganizationId: string;
  };
}

async function buildAgentRelatedResourceView(
  agent: AgentResourceDisplayInput,
  skillIds: string[],
  mcpIds: string[],
): Promise<AgentRelatedResourceView> {
  const fallback: AgentRelatedResourceView = {
    modelLabel: agent.modelId ?? null,
    machineLabel: agent.machineId ?? null,
    skills: skillIds.map((id) => ({ id, label: id })),
    mcps: mcpIds.map((id) => ({ id, label: id })),
    knowledgeBases: [],
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
    if (agent.machineId) {
      const machineRows = await db
        .select({ id: machine.id, agentName: machine.agentName, machineInfo: machine.machineInfo })
        .from(machine)
        .where(eq(machine.id, agent.machineId))
        .limit(1);
      const machineRow = machineRows[0];
      if (machineRow) {
        const hostname =
          machineRow.machineInfo && typeof machineRow.machineInfo === "object"
            ? ((machineRow.machineInfo as { hostname?: string }).hostname ?? "")
            : "";
        machineLabel = hostname || machineRow.agentName;
      } else {
        machineLabel = agent.machineId;
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

    return {
      modelLabel,
      machineLabel,
      skills: skillIds.map((id) => ({ id, label: skillLabelMap.get(id) ?? id })),
      mcps: mcpIds.map((id) => ({ id, label: mcpLabelMap.get(id) ?? id })),
      knowledgeBases: knowledgeBaseIds.map((id) => {
        const item = knowledgeBaseMap.get(id);
        return { id, label: item?.name ?? id, slug: item?.slug ?? null };
      }),
    };
  } catch {
    return fallback;
  }
}

/** 将 PG 行数据映射为前端兼容的 agent 字段 */
function _pgRowToAgentFields(
  row: typeof configPg extends { listAgentConfigs: (ctx: AuthContext) => Promise<(infer T)[]> } ? T : never,
) {
  const r = row as unknown as Record<string, unknown>;
  // tools → permission 兼容转换：PG 中不再有 tools，但保留接口
  const permission = (r.permission ?? null) as unknown;
  return {
    name: r.name as string,
    model: (r.model as string) ?? null,
    modelId: (r.modelId as string) ?? null,
    mode: (r.mode as string) ?? null,
    description: (r.description as string) ?? null,
    color: (r.color as string) ?? null,
    disable: (r.disable as boolean) ?? false,
    hidden: (r.hidden as boolean) ?? false,
    steps: (r.steps as number) ?? null,
    variant: (r.variant as string) ?? null,
    temperature: (r.temperature as number) ?? null,
    top_p: (r.topP as number) ?? null,
    prompt: (r.prompt as string) ?? null,
    permission,
    knowledge: null,
  };
}

async function handleList(ctx: AuthContext) {
  const agents = await configPg.listAgentConfigs(ctx);
  const uc = await configPg.getUserConfig(ctx);
  const defaultAgent = uc.defaultAgent ?? null;
  const list = await Promise.all(
    agents.map(async (a) => {
      const skillIds = await configPg.listAgentSkillIds(a.id);
      const mcpIds = await configPg.listAgentMcpIds(a.id);
      const relatedResources = await buildAgentRelatedResourceView(
        {
          id: a.id,
          organizationId: a.organizationId,
          modelId: a.modelId ?? null,
          machineId: a.machineId ?? null,
          resourceAccess: a.resourceAccess,
        },
        skillIds,
        mcpIds,
      );
      return {
        id: a.id,
        name: a.name,
        builtIn: isBuiltInAgent(a.name),
        model: a.model ?? null,
        modelId: a.modelId ?? null,
        modelLabel: relatedResources.modelLabel,
        mode: a.mode ?? null,
        description: a.description ?? null,
        color: a.color ?? null,
        machineId: a.machineId ?? null,
        knowledgeBaseCount: (await listAgentKnowledgeBindingsById(a.id)).length,
        skillLabels: relatedResources.skills,
        resourceAccess: a.resourceAccess,
      };
    }),
  );
  return configSuccess({ default_agent: defaultAgent, agents: list });
}

async function handleGet(ctx: AuthContext, name: string) {
  const agent = await configPg.getAgentConfig(ctx, name);
  if (!agent) return configNotFound(`Agent '${name}' not found`);

  let permission = agent.permission ?? null;
  // tools→permission 兼容：旧数据可能只有 tools 没有 permission
  const tools = (agent as unknown as Record<string, unknown>).tools;
  if (permission == null && tools && typeof tools === "object" && !Array.isArray(tools)) {
    permission = toolsToPermission(tools as Record<string, boolean>);
  }

  const skillIds = await configPg.listAgentSkillIds(agent.id);
  const mcpIds = await configPg.listAgentMcpIds(agent.id);
  const relatedResources = await buildAgentRelatedResourceView(agent, skillIds, mcpIds);
  const knowledge = await getAgentKnowledgeConfigById(agent.id);

  return configSuccess({
    id: agent.id,
    name: agent.name,
    builtIn: isBuiltInAgent(agent.name),
    model: agent.model ?? null,
    modelId: agent.modelId ?? null,
    prompt: agent.prompt ?? null,
    steps: agent.steps ?? null,
    mode: agent.mode ?? null,
    permission,
    variant: agent.variant ?? null,
    temperature: agent.temperature ?? null,
    top_p: agent.topP ?? null,
    disable: agent.disable ?? false,
    hidden: agent.hidden ?? false,
    color: agent.color ?? null,
    description: agent.description ?? null,
    knowledge: normalizeKnowledgeConfig(knowledge ?? null),
    machineId: agent.machineId ?? null,
    skillIds,
    mcpIds,
    relatedResources,
    resourceAccess: agent.resourceAccess,
  });
}

async function handleSet(ctx: AuthContext, name: string, data: Record<string, unknown>) {
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
    if (key === "permission" && value == null) {
      updateData[key] = null;
    } else if (key === "knowledge" && value == null) {
      updateData[key] = null;
    } else if (key === "top_p") {
      updateData.topP = value;
    } else {
      updateData[key] = value;
    }
  }

  await configPg.updateAgentConfig(ctx, name, updateData, { publicReadable });
  const updatedAgent = await configPg.getAgentConfig(ctx, name);
  if (updatedAgent) {
    await syncAgentKnowledgeBindingsById(
      ctx.organizationId,
      updatedAgent.id,
      filtered.knowledge as AgentKnowledgeConfig | null | undefined,
    );
    if (data.skillIds !== undefined) {
      await configPg.syncAgentSkills(updatedAgent.id, Array.isArray(data.skillIds) ? (data.skillIds as string[]) : []);
    }
    if (data.mcpIds !== undefined) {
      await configPg.syncAgentMcps(updatedAgent.id, Array.isArray(data.mcpIds) ? (data.mcpIds as string[]) : []);
    }
  }

  // 记忆 MCP 开关：勾选创建 mcpServer 记录 + 确保 bank，取消则删除 mcpServer 记录
  if (data.enableMemory === true) {
    const result = await ensureHindsightMcpServer(ctx);
    if (!result.ok) {
      console.warn(`[hindsight] Failed for agent '${name}': ${result.error}`);
    }
  }

  return configSuccess({ name, ...filtered, resourceAccess: updatedAgent?.resourceAccess });
}

async function handleCreate(ctx: AuthContext, name: string, data: Record<string, unknown>) {
  if (!isValidResourceName(name)) {
    return configValidationError("Invalid agent name: must be 1-64 characters (letters, numbers, single hyphens)");
  }
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
  if (filtered.permission == null) delete filtered.permission;

  // 映射 snake_case → camelCase for PG storage
  const pgData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filtered)) {
    if (key === "top_p") {
      pgData.topP = value;
    } else {
      pgData[key] = value;
    }
  }

  // 检查是否已存在
  const existing = await configPg.getAgentConfig(ctx, name);
  if (existing) return configError("ALREADY_EXISTS", `Agent '${name}' already exists`);

  await configPg.createAgentConfig(ctx, name, pgData, { publicReadable });
  const createdAgent = await configPg.getAgentConfig(ctx, name);
  if (createdAgent) {
    await syncAgentKnowledgeBindingsById(
      ctx.organizationId,
      createdAgent.id,
      filtered.knowledge as AgentKnowledgeConfig | null | undefined,
    );
    if (data.skillIds !== undefined) {
      await configPg.syncAgentSkills(createdAgent.id, Array.isArray(data.skillIds) ? (data.skillIds as string[]) : []);
    }
    if (data.mcpIds !== undefined) {
      await configPg.syncAgentMcps(createdAgent.id, Array.isArray(data.mcpIds) ? (data.mcpIds as string[]) : []);
    }
  }

  // 勾选记忆 MCP 时，创建 mcpServer 表记录 + 确保 bank 存在
  if (data.enableMemory === true) {
    const result = await ensureHindsightMcpServer(ctx);
    if (!result.ok) {
      console.warn(`[hindsight] Failed for agent '${name}': ${result.error}`);
    }
  }

  return configSuccess({ name, resourceAccess: createdAgent?.resourceAccess });
}

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

import { loadAgentTemplates } from "../../../services/agent-templates";

function handleTemplates() {
  return configSuccess({ templates: loadAgentTemplates() });
}

async function handleSetDefault(ctx: AuthContext, name: string) {
  const agent = await configPg.getAgentConfig(ctx, name);
  if (!agent) return configNotFound(`Agent '${name}' not found`);
  await configPg.setUserConfig(ctx, { defaultAgent: name });
  return configSuccess({ default_agent: name, resourceAccess: agent.resourceAccess });
}

import { type ConfigBody, ConfigBodySchema } from "../../../schemas/config.schema";

const app = new Elysia({ name: "web-config-agents" }).use(authGuardPlugin).model({
  "config-body": ConfigBodySchema,
});

app.post(
  "/config/agents",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth + body model
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const b = (body as ConfigBody) ?? {};
    const { action, name, data } = {
      action: b.action ?? "",
      name: b.name,
      data: b.data as Record<string, unknown> | undefined,
    };
    // get/set/create/delete/set_default 都需要 name
    if (action !== "list" && action !== "templates" && !name) {
      return error(400, configValidationError("Missing 'name' field"));
    }
    try {
      switch (action) {
        case "templates":
          return handleTemplates();
        case "list":
          return await handleList(authCtx);
        case "get":
          return await handleGet(authCtx, name!);
        case "set":
          return await handleSet(authCtx, name!, data!);
        case "create":
          return await handleCreate(authCtx, name!, data!);
        case "delete":
          return await handleDelete(authCtx, name!);
        case "set_default":
          return await handleSetDefault(authCtx, name!);
        default:
          return error(400, configValidationError(`Unknown action '${action}'`));
      }
    } catch (error_) {
      if (
        error_ instanceof InvalidKnowledgeBindingError ||
        (typeof error_ === "object" &&
          error_ !== null &&
          "code" in error_ &&
          (error_ as { code?: string }).code === "INVALID_KNOWLEDGE_BINDINGS")
      ) {
        const message = error_ instanceof Error ? error_.message : "知识库绑定无效";
        return error(400, configError("INVALID_KNOWLEDGE_BINDINGS", message));
      }
      if (error_ instanceof AppError && error_.code === "VALIDATION_ERROR") {
        return error(400, configValidationError(error_.message));
      }
      throw error_;
    }
  },
  { sessionAuth: true, body: "config-body", detail: { tags: ["Config"], summary: "Agent 配置管理" } },
);

export default app;
