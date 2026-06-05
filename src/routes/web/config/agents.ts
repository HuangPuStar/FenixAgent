import { and, eq, inArray } from "drizzle-orm";
import Elysia from "elysia";
import { db } from "../../../db";
import { knowledgeBase, machine, model, provider, skill } from "../../../db/schema";
import { AppError } from "../../../errors";
import { type AuthContext, authGuardPlugin } from "../../../plugins/auth";
import {
  type AgentKnowledgeConfig,
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

interface AgentRelatedResourceView {
  modelLabel: string | null;
  machineLabel: string | null;
  skills: Array<{ id: string; label: string }>;
  knowledgeBases: Array<{ id: string; label: string; slug?: string | null }>;
}

interface AgentResourceDisplayInput {
  id: string;
  organizationId: string;
  model: string | null;
  machineId: string | null;
  resourceAccess?: {
    sourceOrganizationId: string;
  };
}

function parseModelRef(modelRef: string) {
  const parts = modelRef.split("/");
  if (parts.length >= 3) {
    return {
      providerOrganizationId: parts[0],
      providerId: parts[1],
      providerName: null,
      modelId: parts.slice(2).join("/"),
    };
  }
  if (parts.length === 2) {
    return {
      providerOrganizationId: null,
      providerId: null,
      providerName: parts[0],
      modelId: parts[1],
    };
  }
  return null;
}

async function buildAgentRelatedResourceView(
  agent: AgentResourceDisplayInput,
  skillIds: string[],
): Promise<AgentRelatedResourceView> {
  const fallback: AgentRelatedResourceView = {
    modelLabel: agent.model ?? null,
    machineLabel: agent.machineId ?? null,
    skills: skillIds.map((id) => ({ id, label: id })),
    knowledgeBases: [],
  };

  try {
    const sourceOrganizationId = agent.resourceAccess?.sourceOrganizationId ?? agent.organizationId;
    let modelLabel: string | null = null;

    if (agent.model) {
      const parsedModel = parseModelRef(agent.model);
      if (parsedModel) {
        let providerRow:
          | {
              id: string;
              name: string;
              displayName: string | null;
            }
          | undefined;

        if (parsedModel.providerId && parsedModel.providerOrganizationId) {
          const rows = await db
            .select({ id: provider.id, name: provider.name, displayName: provider.displayName })
            .from(provider)
            .where(
              and(
                eq(provider.id, parsedModel.providerId),
                eq(provider.organizationId, parsedModel.providerOrganizationId),
              ),
            )
            .limit(1);
          providerRow = rows[0];
        } else if (parsedModel.providerName) {
          const rows = await db
            .select({ id: provider.id, name: provider.name, displayName: provider.displayName })
            .from(provider)
            .where(and(eq(provider.name, parsedModel.providerName), eq(provider.organizationId, sourceOrganizationId)))
            .limit(1);
          providerRow = rows[0];
        }

        if (providerRow) {
          const modelRows = await db
            .select({ modelId: model.modelId, displayName: model.displayName })
            .from(model)
            .where(and(eq(model.providerId, providerRow.id), eq(model.modelId, parsedModel.modelId)))
            .limit(1);
          const modelRow = modelRows[0];
          const providerName = providerRow.displayName ?? providerRow.name;
          const modelName = modelRow?.displayName ?? modelRow?.modelId ?? parsedModel.modelId;
          modelLabel = `${providerName}/${modelName}`;
        }
      }

      if (!modelLabel) {
        modelLabel = agent.model;
      }
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
    knowledge: (r.knowledge as unknown) ?? null,
  };
}

async function handleList(ctx: AuthContext) {
  const agents = await configPg.listAgentConfigs(ctx);
  const uc = await configPg.getUserConfig(ctx);
  const defaultAgent = uc.defaultAgent ?? null;
  const list = await Promise.all(
    agents.map(async (a) => {
      const skillIds = await configPg.listAgentSkillIds(a.id);
      const relatedResources = await buildAgentRelatedResourceView(
        {
          id: a.id,
          organizationId: a.organizationId,
          model: a.model ?? null,
          machineId: a.machineId ?? null,
          resourceAccess: a.resourceAccess,
        },
        skillIds,
      );
      return {
        id: a.id,
        name: a.name,
        builtIn: isBuiltInAgent(a.name),
        model: a.model ?? null,
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
  const relatedResources = await buildAgentRelatedResourceView(agent, skillIds);

  return configSuccess({
    id: agent.id,
    name: agent.name,
    builtIn: isBuiltInAgent(agent.name),
    model: agent.model ?? null,
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
    knowledge: normalizeKnowledgeConfig(agent.knowledge ?? null),
    machineId: agent.machineId ?? null,
    skillIds,
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
  }
  return configSuccess({ name, ...filtered, resourceAccess: updatedAgent?.resourceAccess });
}

async function handleCreate(ctx: AuthContext, name: string, data: Record<string, unknown>) {
  if (!isValidResourceName(name)) {
    return configValidationError("Invalid agent name: must be 1-64 lowercase alphanumeric chars with single hyphens");
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
      throw error_;
    }
  },
  { sessionAuth: true, body: "config-body", detail: { tags: ["Config"], summary: "Agent 配置管理" } },
);

export default app;
