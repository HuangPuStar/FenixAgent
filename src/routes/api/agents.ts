import Elysia from "elysia";
import * as z from "zod/v4";
import { AppError } from "../../errors";
import { type AuthContext, authGuardPlugin } from "../../plugins/auth";
import {
  ApiAgentDeleteResponseSchema,
  ApiAgentDetailSchema,
  ApiAgentIdParamsSchema,
  type ApiAgentListQuery,
  ApiAgentListQuerySchema,
  ApiAgentListResponseSchema,
  type ApiAgentUpdateBody,
  ApiAgentUpdateBodySchema,
  type ApiAgentUpsertBody,
  ApiAgentUpsertBodySchema,
} from "../../schemas/api-agent.schema";
import {
  type AgentKnowledgeConfig,
  getAgentKnowledgeConfigById,
  InvalidKnowledgeBindingError,
  syncAgentKnowledgeBindingsById,
} from "../../services/agent-knowledge";
import {
  createAgentConfig,
  deleteAgentConfig,
  getAgentConfigById,
  getReadableAgentConfigById,
  listAgentConfigs,
  listAgentMcpIds,
  listAgentSkillIds,
  listSkills,
  syncAgentMcps,
  syncAgentSkills,
  updateAgentConfig,
} from "../../services/config";
import {
  AGENT_SETTABLE_FIELDS,
  isBuiltInAgent,
  normalizeKnowledgeConfig,
  validateAgentData,
} from "../../services/config/agent-config";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ApiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().describe("错误码。"),
    message: z.string().describe("错误描述。"),
  }),
});

/**
 * 过滤对外可写字段，避免把 web 侧历史兼容字段直接暴露给公共 API。
 */
function toAgentData(body: ApiAgentUpsertBody | ApiAgentUpdateBody): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "skillIds" || key === "mcpIds" || key === "publicReadable") continue;
    if (AGENT_SETTABLE_FIELDS.includes(key as (typeof AGENT_SETTABLE_FIELDS)[number])) {
      data[key] = key === "knowledge" ? normalizeKnowledgeConfig(value) : value;
    }
    if (key === "name") {
      data.name = value;
    }
  }
  return data;
}

/**
 * 解析 Skill 标识符，兼容外部系统传 UUID 或名称两种形式。
 */
async function resolveSkillIds(ctx: AuthContext, identifiers: string[]): Promise<string[]> {
  if (identifiers.length === 0) return [];
  if (identifiers.every((id) => UUID_RE.test(id))) return identifiers;

  const skills = await listSkills(ctx);
  const nameToId = new Map(skills.map((skill) => [skill.name.toLowerCase(), skill.id]));

  return identifiers
    .map((id) => {
      if (UUID_RE.test(id)) return id;
      return nameToId.get(id.toLowerCase()) ?? null;
    })
    .filter((id): id is string => Boolean(id));
}

/**
 * 组装对外 Agent 列表项。
 */
async function toAgentListItem(ctx: AuthContext, agent: Awaited<ReturnType<typeof listAgentConfigs>>[number]) {
  return {
    id: agent.id,
    name: agent.name,
    builtIn: isBuiltInAgent(agent.name),
    model: agent.model ?? null,
    modelId: agent.modelId ?? null,
    description: agent.description ?? null,
    machineId: agent.machineId ?? null,
    knowledgeBaseCount: (await getAgentKnowledgeConfigById(agent.id))?.knowledgeBaseIds.length ?? 0,
    resourceAccess:
      agent.resourceAccess ??
      (agent.organizationId === ctx.organizationId
        ? {
            ownership: "internal",
            sourceOrganizationId: agent.organizationId,
            resourceUid: agent.id,
            resourceKey: `${agent.organizationId}/${agent.id}`,
            manageable: true,
            writable: true,
            publicReadable: false,
          }
        : undefined),
  };
}

/**
 * 组装对外 Agent 详情。
 */
async function buildAgentDetail(ctx: AuthContext, agentId: string) {
  const agent = await getReadableAgentConfigById(ctx, agentId);
  if (!agent) return null;

  const [knowledge, skillIds, mcpIds] = await Promise.all([
    getAgentKnowledgeConfigById(agent.id),
    listAgentSkillIds(agent.id),
    listAgentMcpIds(agent.id),
  ]);

  return {
    id: agent.id,
    name: agent.name,
    builtIn: isBuiltInAgent(agent.name),
    model: agent.model ?? null,
    modelId: agent.modelId ?? null,
    prompt: agent.prompt ?? null,
    description: agent.description ?? null,
    extra: agent.extra ?? null,
    knowledge: normalizeKnowledgeConfig(knowledge ?? null),
    skillIds,
    mcpIds,
    machineId: agent.machineId ?? null,
    resourceAccess: agent.resourceAccess,
  };
}

/**
 * 创建/更新类写接口仍只针对当前组织内部 Agent 做重名检查。
 */
async function listWritableAgents(ctx: AuthContext) {
  const rows = await listAgentConfigs(ctx);
  return rows.filter((row) => row.organizationId === ctx.organizationId);
}

/**
 * 将业务异常映射到对外 API 的稳定错误结构。
 */
function mapApiError(error: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (error instanceof InvalidKnowledgeBindingError) {
    return {
      status: 400,
      body: { error: { code: "INVALID_KNOWLEDGE_BINDINGS", message: error.message } },
    };
  }
  if (error instanceof AppError) {
    return {
      status: error.statusCode,
      body: { error: { code: error.code, message: error.message } },
    };
  }
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Unknown error" } },
  };
}

const app = new Elysia({ name: "api-agents", prefix: "/api/agents" }).use(authGuardPlugin).model({
  "api-agent-list-query": ApiAgentListQuerySchema,
  "api-agent-id-params": ApiAgentIdParamsSchema,
  "api-agent-create-body": ApiAgentUpsertBodySchema,
  "api-agent-update-body": ApiAgentUpdateBodySchema,
  "api-agent-list-response": ApiAgentListResponseSchema,
  "api-agent-detail": ApiAgentDetailSchema,
  "api-agent-delete-response": ApiAgentDeleteResponseSchema,
});

app.get(
  "",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, query, error }: any) => {
    const authCtx = store.authContext as AuthContext;
    const { page, pageSize } = query as ApiAgentListQuery;

    try {
      const agents = await listAgentConfigs(authCtx);
      const total = agents.length;
      const start = (page - 1) * pageSize;
      const items = await Promise.all(
        agents.slice(start, start + pageSize).map((agent) => toAgentListItem(authCtx, agent)),
      );
      return { items, total, page, pageSize };
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    query: "api-agent-list-query",
    response: {
      200: "api-agent-list-response",
      400: ApiErrorResponseSchema,
      401: ApiErrorResponseSchema,
      403: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External AgentConfig"],
      summary: "获取 Agent 配置列表",
      description: "返回当前调用方可读的 Agent 配置列表，包含当前组织内部资源与外部共享资源。",
    },
  },
);

app.get(
  "/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext as AuthContext;

    try {
      const detail = await buildAgentDetail(authCtx, params.id);
      if (!detail) {
        return error(404, { error: { code: "NOT_FOUND", message: `Agent '${params.id}' not found` } });
      }
      return detail;
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-agent-id-params",
    response: {
      200: "api-agent-detail",
      401: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External AgentConfig"],
      summary: "获取 Agent 配置详情",
      description: "按 Agent 配置 ID 返回详情，支持读取当前组织内部资源与外部共享资源。",
    },
  },
);

app.post(
  "",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext as AuthContext;
    const payload = body as ApiAgentUpsertBody;
    const validationError = validateAgentData(toAgentData(payload));
    if (validationError) {
      return error(400, { error: { code: "VALIDATION_ERROR", message: validationError } });
    }

    try {
      const existing = (await listWritableAgents(authCtx)).find((agent) => agent.name === payload.name);
      if (existing) {
        return error(409, { error: { code: "ALREADY_EXISTS", message: `Agent '${payload.name}' already exists` } });
      }

      const agentId = await createAgentConfig(authCtx, payload.name, toAgentData(payload), {
        publicReadable: payload.publicReadable,
      });

      if (payload.knowledge !== undefined) {
        await syncAgentKnowledgeBindingsById(
          authCtx.organizationId,
          agentId,
          normalizeKnowledgeConfig(payload.knowledge) as AgentKnowledgeConfig | null | undefined,
        );
      }
      if (payload.skillIds !== undefined) {
        await syncAgentSkills(agentId, await resolveSkillIds(authCtx, payload.skillIds));
      }
      if (payload.mcpIds !== undefined) {
        await syncAgentMcps(agentId, payload.mcpIds);
      }

      const detail = await buildAgentDetail(authCtx, agentId);
      if (!detail) {
        return error(500, { error: { code: "INTERNAL_ERROR", message: "Created agent could not be reloaded" } });
      }
      return detail;
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    body: "api-agent-create-body",
    response: {
      200: "api-agent-detail",
      400: ApiErrorResponseSchema,
      401: ApiErrorResponseSchema,
      409: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External AgentConfig"],
      summary: "创建 Agent 配置",
      description: "创建当前组织的 Agent 配置，并按需同步知识库、Skill 与 MCP 关联。",
    },
  },
);

app.put(
  "/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext as AuthContext;
    const payload = body as ApiAgentUpdateBody;
    const validationError = validateAgentData(toAgentData(payload));
    if (validationError) {
      return error(400, { error: { code: "VALIDATION_ERROR", message: validationError } });
    }

    try {
      const existing = await getAgentConfigById(params.id, authCtx.organizationId);
      if (!existing) {
        return error(404, { error: { code: "NOT_FOUND", message: `Agent '${params.id}' not found` } });
      }

      await updateAgentConfig(authCtx, existing.name, toAgentData(payload), {
        publicReadable: payload.publicReadable,
      });

      if (payload.knowledge !== undefined) {
        await syncAgentKnowledgeBindingsById(
          authCtx.organizationId,
          existing.id,
          normalizeKnowledgeConfig(payload.knowledge) as AgentKnowledgeConfig | null | undefined,
        );
      }
      if (payload.skillIds !== undefined) {
        await syncAgentSkills(existing.id, await resolveSkillIds(authCtx, payload.skillIds));
      }
      if (payload.mcpIds !== undefined) {
        await syncAgentMcps(existing.id, payload.mcpIds);
      }

      const detail = await buildAgentDetail(authCtx, existing.id);
      if (!detail) {
        return error(500, { error: { code: "INTERNAL_ERROR", message: "Updated agent could not be reloaded" } });
      }
      return detail;
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-agent-id-params",
    body: "api-agent-update-body",
    response: {
      200: "api-agent-detail",
      400: ApiErrorResponseSchema,
      401: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External AgentConfig"],
      summary: "更新 Agent 配置",
      description: "按 Agent 配置 ID 更新当前组织资源，并在请求包含关联字段时同步知识库、Skill 与 MCP。",
    },
  },
);

app.delete(
  "/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext as AuthContext;

    try {
      const existing = await getAgentConfigById(params.id, authCtx.organizationId);
      if (!existing) {
        return error(404, { error: { code: "NOT_FOUND", message: `Agent '${params.id}' not found` } });
      }
      if (isBuiltInAgent(existing.name)) {
        return error(403, { error: { code: "FORBIDDEN", message: `Cannot delete built-in agent '${existing.name}'` } });
      }

      const deleted = await deleteAgentConfig(authCtx, existing.name);
      if (!deleted) {
        return error(404, { error: { code: "NOT_FOUND", message: `Agent '${params.id}' not found` } });
      }
      return { id: existing.id, deleted: true as const };
    } catch (err) {
      const mapped = mapApiError(err);
      return error(mapped.status, mapped.body);
    }
  },
  {
    sessionAuth: true,
    params: "api-agent-id-params",
    response: {
      200: "api-agent-delete-response",
      401: ApiErrorResponseSchema,
      403: ApiErrorResponseSchema,
      404: ApiErrorResponseSchema,
      500: ApiErrorResponseSchema,
    },
    detail: {
      tags: ["External AgentConfig"],
      summary: "删除 Agent 配置",
      description: "按 Agent 配置 ID 删除当前组织资源；内置 Agent 不允许删除。",
    },
  },
);

export default app;
