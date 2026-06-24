import { and, eq, inArray } from "drizzle-orm";
import Elysia from "elysia";
import * as z from "zod/v4";
import { db } from "../../../db";
import { agentSiteApp, knowledgeBase, machine, mcpServer, model, provider, skill } from "../../../db/schema";
import { AppError } from "../../../errors";
import { type AuthContext, authGuardPlugin } from "../../../plugins/auth";
import {
  AgentMutationBodySchema,
  AgentNameQuerySchema,
  AgentTemplatesResponseSchema,
  CreateAgentResponseSchema,
  DeleteAgentResponseSchema,
  GetAgentResponseSchema,
  SetDefaultAgentRequestSchema,
  SetDefaultAgentResponseSchema,
  UpdateAgentRequestSchema,
  UpdateAgentResponseSchema,
} from "../../../schemas/config.schema";
import {
  type AgentKnowledgeConfig,
  getAgentKnowledgeConfigById,
  InvalidKnowledgeBindingError,
  listAgentKnowledgeBindingsById,
  syncAgentKnowledgeBindingsById,
} from "../../../services/agent-knowledge";
import { loadAgentTemplates } from "../../../services/agent-templates";
import {
  AGENT_SETTABLE_FIELDS,
  isBuiltInAgent,
  normalizeKnowledgeConfig,
  validateAgentData,
} from "../../../services/config/agent-config";
import * as configPg from "../../../services/config/index";
import { listSkills } from "../../../services/config/skill";
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
  siteApps: Array<{ id: string; label: string; remoteAppId: string | null }>;
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
  siteAppIds: string[],
): Promise<AgentRelatedResourceView> {
  const fallback: AgentRelatedResourceView = {
    modelLabel: agent.modelId ?? null,
    machineLabel: agent.machineId ?? null,
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
    if (agent.machineId) {
      const machineRows = await db
        .select({ id: machine.id, agentName: machine.agentName, name: machine.name, machineInfo: machine.machineInfo })
        .from(machine)
        .where(eq(machine.id, agent.machineId))
        .limit(1);
      const machineRow = machineRows[0];
      if (machineRow) {
        const hostname =
          machineRow.machineInfo && typeof machineRow.machineInfo === "object"
            ? ((machineRow.machineInfo as { hostname?: string }).hostname ?? "")
            : "";
        machineLabel = machineRow.name || hostname || machineRow.agentName;
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
  const uc = await configPg.getUserConfig(ctx);
  const defaultAgent = uc.defaultAgent ?? null;
  const list = await Promise.all(
    agents.map(async (a) => {
      const skillIds = await configPg.listAgentSkillIds(a.id);
      const mcpIds = await configPg.listAgentMcpIds(a.id);
      const siteAppIds = await configPg.listAgentSiteAppIds(a.id);
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
        machineId: a.machineId ?? null,
        engineType: (a as unknown as Record<string, unknown>).engineType ?? "opencode",
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

  const skillIds = await configPg.listAgentSkillIds(agent.id);
  const mcpIds = await configPg.listAgentMcpIds(agent.id);
  const siteAppIds = await configPg.listAgentSiteAppIds(agent.id);
  const relatedResources = await buildAgentRelatedResourceView(agent, skillIds, mcpIds, siteAppIds);
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
    machineId: agent.machineId ?? null,
    engineType: (agent as unknown as Record<string, unknown>).engineType ?? "opencode",
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
  const updatedAgent = await configPg.getAgentConfig(ctx, name);
  if (updatedAgent) {
    await syncAgentKnowledgeBindingsById(
      ctx.organizationId,
      updatedAgent.id,
      filtered.knowledge as AgentKnowledgeConfig | null | undefined,
    );
    if (data.skillIds !== undefined) {
      const rawIds = Array.isArray(data.skillIds) ? (data.skillIds as string[]) : [];
      const resolvedIds = await resolveSkillIds(ctx, rawIds);
      await configPg.syncAgentSkills(updatedAgent.id, resolvedIds);
    }
    if (data.mcpIds !== undefined) {
      await configPg.syncAgentMcps(updatedAgent.id, Array.isArray(data.mcpIds) ? (data.mcpIds as string[]) : []);
    }
    if (data.siteAppIds !== undefined) {
      await configPg.syncAgentSiteApps(
        updatedAgent.id,
        Array.isArray(data.siteAppIds) ? (data.siteAppIds as string[]) : [],
      );
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

  await configPg.createAgentConfig(ctx, name, filtered, { publicReadable });
  const createdAgent = await configPg.getAgentConfig(ctx, name);
  if (createdAgent) {
    await syncAgentKnowledgeBindingsById(
      ctx.organizationId,
      createdAgent.id,
      filtered.knowledge as AgentKnowledgeConfig | null | undefined,
    );
    if (data.skillIds !== undefined) {
      const rawIds = Array.isArray(data.skillIds) ? (data.skillIds as string[]) : [];
      const resolvedIds = await resolveSkillIds(ctx, rawIds);
      await configPg.syncAgentSkills(createdAgent.id, resolvedIds);
    }
    if (data.mcpIds !== undefined) {
      await configPg.syncAgentMcps(createdAgent.id, Array.isArray(data.mcpIds) ? (data.mcpIds as string[]) : []);
    }
    if (data.siteAppIds !== undefined) {
      await configPg.syncAgentSiteApps(
        createdAgent.id,
        Array.isArray(data.siteAppIds) ? (data.siteAppIds as string[]) : [],
      );
    }
  }

  // 勾选记忆 MCP 时，创建 mcpServer 表记录 + 确保 bank 存在
  if (data.enableMemory === true) {
    const result = await ensureHindsightMcpServer(ctx);
    if (!result.ok) {
      console.warn(`[hindsight] Failed for agent '${name}': ${result.error}`);
    }
  }

  return configSuccess({ name, id: createdAgent?.id, resourceAccess: createdAgent?.resourceAccess });
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
  await configPg.setUserConfig(ctx, { defaultAgent: agent.name });
  return configSuccess({ default_agent: agent.name, resourceAccess: agent.resourceAccess });
}
const AgentErrorResponseSchema = z.unknown();

const app = new Elysia({ name: "web-config-agents" }).use(authGuardPlugin).model({
  "agent-name-query": AgentNameQuerySchema,
  "agent-mutation-body": AgentMutationBodySchema,
  "agent-update-body": UpdateAgentRequestSchema,
  "agent-set-default-body": SetDefaultAgentRequestSchema,
  "agent-templates-response": AgentTemplatesResponseSchema,
  "agent-get-response": GetAgentResponseSchema,
  "agent-create-response": CreateAgentResponseSchema,
  "agent-update-response": UpdateAgentResponseSchema,
  "agent-delete-response": DeleteAgentResponseSchema,
  "agent-set-default-response": SetDefaultAgentResponseSchema,
});

function requireName(
  name: string | undefined,
  errorFn: (status: number, body: unknown) => unknown,
): string | ReturnType<typeof errorFn> {
  if (!name) {
    return errorFn(400, configValidationError("Missing 'name' field"));
  }
  return name;
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function isConfigErrorResult(value: unknown): value is { success: false; error: { code?: string; message?: string } } {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    (value as { success?: unknown }).success === false &&
    "error" in value
  );
}

function mapConfigErrorStatus(code: string | undefined): number {
  switch (code) {
    case "VALIDATION_ERROR":
    case "INVALID_KNOWLEDGE_BINDINGS":
      return 400;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "ALREADY_EXISTS":
      return 409;
    default:
      return 400;
  }
}

/** 统一映射 agent 配置路由的业务异常，避免每个 handler 重复 try/catch。 */
async function runAgentAction<T>(
  fn: () => Promise<T> | T,
  errorFn: (status: number, body: unknown) => unknown,
): Promise<T | ReturnType<typeof errorFn>> {
  try {
    const result = await fn();
    if (isConfigErrorResult(result)) {
      return errorFn(mapConfigErrorStatus(result.error.code), result);
    }
    return result;
  } catch (error_) {
    if (
      error_ instanceof InvalidKnowledgeBindingError ||
      (typeof error_ === "object" &&
        error_ !== null &&
        "code" in error_ &&
        (error_ as { code?: string }).code === "INVALID_KNOWLEDGE_BINDINGS")
    ) {
      const message = error_ instanceof Error ? error_.message : "知识库绑定无效";
      return errorFn(400, configError("INVALID_KNOWLEDGE_BINDINGS", message));
    }
    if (error_ instanceof AppError && error_.code === "VALIDATION_ERROR") {
      return errorFn(400, configValidationError(error_.message));
    }
    throw error_;
  }
}

app.get("/config/agents/templates", () => handleTemplates(), {
  sessionAuth: true,
  response: {
    200: "agent-templates-response",
    400: AgentErrorResponseSchema,
    401: AgentErrorResponseSchema,
    403: AgentErrorResponseSchema,
    404: AgentErrorResponseSchema,
  },
  detail: {
    tags: ["AgentConfig"],
    summary: "获取 Agent 模板列表",
    description: "返回系统内置的 Agent 模板列表，供前端创建 Agent 时选择预设 prompt 与默认 skill。",
  },
});

app.get(
  "/config/agents",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  async ({ store, query, error }: any) => {
    const authCtx = store.authContext!;
    const name = typeof query?.name === "string" ? query.name : undefined;
    if (!name) {
      return await runAgentAction(
        () => handleList(authCtx),
        (status, body) => error(status, body),
      );
    }
    return await runAgentAction(
      () => handleGet(authCtx, name),
      (status, body) => error(status, body),
    );
  },
  {
    sessionAuth: true,
    query: "agent-name-query",
    response: {
      200: "agent-get-response",
      400: AgentErrorResponseSchema,
      401: AgentErrorResponseSchema,
      403: AgentErrorResponseSchema,
      404: AgentErrorResponseSchema,
    },
    detail: {
      tags: ["AgentConfig"],
      summary: "获取 Agent 列表或详情",
      description:
        "不带 `name` 查询参数时返回当前可见的 Agent 列表；带 `name` 时返回指定 Agent 的完整详情，包括 skill、MCP 和知识库关联信息。",
      parameters: [
        {
          name: "name",
          in: "query",
          required: false,
          description: "Agent 名称或共享资源键；传入后接口切换为详情查询模式。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

app.post(
  "/config/agents",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const name = requireName(typeof body?.name === "string" ? body.name : undefined, (status, payload) =>
      error(status, payload),
    );
    if (typeof name !== "string") {
      return name;
    }
    return await runAgentAction(
      () => handleCreate(authCtx, name, toRecord(body?.data)),
      (status, payload) => error(status, payload),
    );
  },
  {
    sessionAuth: true,
    body: "agent-mutation-body",
    response: {
      200: "agent-create-response",
      400: AgentErrorResponseSchema,
      401: AgentErrorResponseSchema,
      403: AgentErrorResponseSchema,
      404: AgentErrorResponseSchema,
      409: AgentErrorResponseSchema,
    },
    detail: {
      tags: ["AgentConfig"],
      summary: "创建 Agent 配置",
      description: "创建新的 Agent 配置，并根据请求内容同步知识库绑定、Skill 绑定和 MCP 绑定。",
    },
  },
);

app.put(
  "/config/agents",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  async ({ store, query, body, error }: any) => {
    const authCtx = store.authContext!;
    const name = requireName(typeof query?.name === "string" ? query.name : undefined, (status, payload) =>
      error(status, payload),
    );
    if (typeof name !== "string") {
      return name;
    }
    return await runAgentAction(
      () => handleSet(authCtx, name, toRecord(body?.data)),
      (status, payload) => error(status, payload),
    );
  },
  {
    sessionAuth: true,
    query: z.object({ name: AgentNameQuerySchema.shape.name }),
    body: "agent-update-body",
    response: {
      200: "agent-update-response",
      400: AgentErrorResponseSchema,
      401: AgentErrorResponseSchema,
      403: AgentErrorResponseSchema,
      404: AgentErrorResponseSchema,
      409: AgentErrorResponseSchema,
    },
    detail: {
      tags: ["AgentConfig"],
      summary: "更新 Agent 配置",
      description:
        "更新指定 Agent 的可变更字段，并在保存后同步知识库、Skill 与 MCP 关联；仅当前组织可写的 Agent 允许修改。",
      parameters: [
        {
          name: "name",
          in: "query",
          required: true,
          description: "待更新的 Agent 名称或共享资源键。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

app.delete(
  "/config/agents",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  async ({ store, query, error }: any) => {
    const authCtx = store.authContext!;
    const name = requireName(typeof query?.name === "string" ? query.name : undefined, (status, payload) =>
      error(status, payload),
    );
    if (typeof name !== "string") {
      return name;
    }
    return await runAgentAction(
      () => handleDelete(authCtx, name),
      (status, payload) => error(status, payload),
    );
  },
  {
    sessionAuth: true,
    query: z.object({ name: AgentNameQuerySchema.shape.name }),
    response: {
      200: "agent-delete-response",
      400: AgentErrorResponseSchema,
      401: AgentErrorResponseSchema,
      403: AgentErrorResponseSchema,
      404: AgentErrorResponseSchema,
    },
    detail: {
      tags: ["AgentConfig"],
      summary: "删除 Agent 配置",
      description: "删除指定 Agent 配置。内置 Agent 不允许删除，共享只读 Agent 也不允许删除。",
      parameters: [
        {
          name: "name",
          in: "query",
          required: true,
          description: "待删除的 Agent 名称或共享资源键。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

app.post(
  "/config/agents/default",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia sessionAuth 注入类型在当前写法下无法稳定推断
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const name = requireName(typeof body?.name === "string" ? body.name : undefined, (status, payload) =>
      error(status, payload),
    );
    if (typeof name !== "string") {
      return name;
    }
    return await runAgentAction(
      () => handleSetDefault(authCtx, name),
      (status, payload) => error(status, payload),
    );
  },
  {
    sessionAuth: true,
    body: "agent-set-default-body",
    response: {
      200: "agent-set-default-response",
      400: AgentErrorResponseSchema,
      401: AgentErrorResponseSchema,
      403: AgentErrorResponseSchema,
      404: AgentErrorResponseSchema,
    },
    detail: {
      tags: ["AgentConfig"],
      summary: "设置默认 Agent",
      description: "将指定 Agent 设置为当前用户的默认 Agent，后续创建会话或打开面板时可作为默认选择。",
    },
  },
);

export default app;
