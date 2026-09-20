import type { ActorContext, IdentityDirectory } from "@fenix/platform-sdk";
import { ApiErrorResponseSchema, AppError, toResourceAccessView } from "@fenix/platform-sdk";
import { InvalidKnowledgeBindingError } from "@fenix/resource-knowledge/server";
import { authGuardPlugin } from "@server/plugins/auth";
import Elysia from "elysia";
import type { AuthorizedAgentConfig } from "../../facades/agent-config-facade";
import { toAgentResourceKey } from "../../facades/agent-config-facade";
import { getAgentConfigModule } from "../../runtime";
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
import { applyAgentBindings, readAgentBindingRequest } from "../../services/agent-bindings";
import {
  isBuiltInAgent,
  resolveAgentNode,
  toAgentConfigWriteData,
  validateAgentData,
} from "../../services/config/agent-config";

/**
 * `/api/agents` 协议层（对外已发布合同）。
 *
 * 分页与计数下推到数据库的授权查询（决策 D3）：`total` 是当前主体可见资源的真实总数，列表只取当前
 * 页，不再"全量读出后内存切片"。
 *
 * `resourceAccess` 是**唯一**保留旧字段形状的位置（决策 D2）：它由 `toResourceAccessView` 从
 * `scope + access.actions` 派生，资源包不再各自解释权限。
 *
 * 写路径按资源键（`<activeOrganizationId>/<resourceId>`）定位资源：已发布合同对跨组织资源返回 404，
 * 而按 ID 直读会命中"其他组织公开可读"的资源。资源键把"同组织可见"这一判定交给授权谓词，语义与
 * 迁移前一致。
 */

/**
 * 将业务异常映射到对外 API 的稳定错误结构。
 */
function mapApiError(err: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (err instanceof InvalidKnowledgeBindingError) {
    return { status: 400, body: { error: { code: "INVALID_KNOWLEDGE_BINDINGS", message: err.message } } };
  }
  if (err instanceof AppError) {
    return { status: err.statusCode, body: { error: { code: err.code, message: err.message } } };
  }
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Unknown error" } },
  };
}

/** 批量解析归属组织名称；名录不可用时字段整体省略。 */
async function resolveOrganizationNames(
  identity: IdentityDirectory,
  organizationIds: readonly (string | undefined)[],
): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(organizationIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return new Map();
  return identity.listOrganizationNames(ids);
}

/** 派生已发布合同的资源访问视图；组织名称由调用方批量解析后传入。 */
function buildResourceAccess(
  agent: AuthorizedAgentConfig,
  activeOrganizationId: string | undefined,
  sourceOrganizationName: string | undefined,
) {
  return toResourceAccessView({
    resource: { id: agent.id, scope: agent.scope, access: agent.access },
    ...(activeOrganizationId === undefined ? {} : { activeOrganizationId }),
    ...(sourceOrganizationName === undefined ? {} : { sourceOrganizationName }),
  });
}

/** 组装对外 Agent 列表项。 */
function toAgentListItem(
  agent: AuthorizedAgentConfig,
  knowledgeBaseCount: number,
  activeOrganizationId: string | undefined,
  sourceOrganizationName: string | undefined,
) {
  return {
    id: agent.id,
    name: agent.name,
    builtIn: isBuiltInAgent(agent.name),
    model: agent.model ?? null,
    modelId: agent.modelId ?? null,
    description: agent.description ?? null,
    agentNode: resolveAgentNode(agent) ?? {},
    knowledgeBaseCount,
    resourceAccess: buildResourceAccess(agent, activeOrganizationId, sourceOrganizationName),
  };
}

/** 组装对外 Agent 详情。 */
async function buildAgentDetail(
  actor: ActorContext,
  agent: AuthorizedAgentConfig,
  organizationName: string | undefined,
) {
  const { associations } = getAgentConfigModule();
  const [knowledge, skillIds, mcpIds] = await Promise.all([
    associations.getKnowledge(agent.id),
    associations.listSkillIds(agent.id),
    associations.listMcpIds(agent.id),
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
    knowledge,
    skillIds,
    mcpIds,
    agentNode: resolveAgentNode(agent) ?? {},
    resourceAccess: buildResourceAccess(agent, actor.activeOrganizationId, organizationName),
  };
}

/**
 * 取当前主体的组织键前缀。
 *
 * 写路径用它把资源 ID 拼成资源键；没有 active organization 时无法表达"同组织"这一约束，返回 null
 * 由路由转成 401（与列表/详情不需要组织上下文不同，写操作必须知道自己的组织）。
 */
function activeOrganizationKey(actor: ActorContext): string | null {
  return actor.activeOrganizationId ?? null;
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
    const actor = store.actor as ActorContext | null;
    if (!actor) {
      return error(401, { error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
    }
    const { page, pageSize } = query as ApiAgentListQuery;

    try {
      const { facade, identity, associations } = getAgentConfigModule();
      const { items, total } = await facade.list(actor, { limit: pageSize, offset: (page - 1) * pageSize });
      const organizationNames = await resolveOrganizationNames(
        identity,
        items.map((item) => item.scope.organizationId),
      );
      const counts = await Promise.all(items.map((item) => associations.listKnowledgeBindings(item.id)));
      return {
        items: items.map((item, index) =>
          toAgentListItem(
            item,
            counts[index]?.length ?? 0,
            actor.activeOrganizationId,
            organizationNames.get(item.scope.organizationId ?? ""),
          ),
        ),
        total,
        page,
        pageSize,
      };
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
      description:
        "返回当前调用方可读的 Agent 配置列表，包含当前组织内部资源与外部共享资源；分页与计数在数据库内完成。",
    },
  },
);

app.get(
  "/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, params, error }: any) => {
    const actor = store.actor as ActorContext | null;
    if (!actor) {
      return error(401, { error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
    }
    const { id } = params as { id: string };

    try {
      const { facade, identity } = getAgentConfigModule();
      // 详情允许读取其他组织公开的 Agent：按 ID 读即可，写路径才需要限定同组织。
      const agent = await facade.getById(actor, id);
      if (!agent) {
        return error(404, { error: { code: "NOT_FOUND", message: `Agent '${id}' not found` } });
      }
      const organizationNames = await resolveOrganizationNames(identity, [agent.scope.organizationId]);
      return await buildAgentDetail(actor, agent, organizationNames.get(agent.scope.organizationId ?? ""));
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
    const actor = store.actor as ActorContext | null;
    if (!actor) {
      return error(401, { error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
    }
    const payload = body as ApiAgentUpsertBody;
    const validationError = validateAgentData(payload as unknown as Record<string, unknown>);
    if (validationError) {
      return error(400, { error: { code: "VALIDATION_ERROR", message: validationError } });
    }

    try {
      const { facade, identity } = getAgentConfigModule();
      // 同名判定按归属组织：唯一性是 `(organization_id, name)` 约束，其他组织公开的同名 Agent 不构成
      // 本组织的创建冲突（用可见性判定会让这类合法创建返回 409）。
      if (await facade.existsInOrganization(actor, payload.name)) {
        return error(409, { error: { code: "ALREADY_EXISTS", message: `Agent '${payload.name}' already exists` } });
      }

      const agent = await facade.create(actor, {
        name: payload.name,
        data: toAgentConfigWriteData(payload as unknown as Record<string, unknown>),
        ...(payload.publicReadable === undefined ? {} : { publicReadable: payload.publicReadable }),
      });
      await applyAgentBindings({
        agentConfigId: agent.id,
        request: readAgentBindingRequest(payload as unknown as Record<string, unknown>),
        actor,
      });

      const organizationNames = await resolveOrganizationNames(identity, [agent.scope.organizationId]);
      return await buildAgentDetail(actor, agent, organizationNames.get(agent.scope.organizationId ?? ""));
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
      403: ApiErrorResponseSchema,
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
    const actor = store.actor as ActorContext | null;
    if (!actor) {
      return error(401, { error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
    }
    const organizationId = activeOrganizationKey(actor);
    if (!organizationId) {
      return error(401, { error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
    }
    const { id } = params as { id: string };
    const payload = body as ApiAgentUpdateBody;
    const validationError = validateAgentData(payload as unknown as Record<string, unknown>);
    if (validationError) {
      return error(400, { error: { code: "VALIDATION_ERROR", message: validationError } });
    }

    try {
      const { facade, identity } = getAgentConfigModule();
      // 资源键限定"归属当前组织"：跨组织可读资源的写请求在这里变成 404，与迁移前一致。
      const agent = await facade.update(
        actor,
        toAgentResourceKey(organizationId, id),
        toAgentConfigWriteData(payload as unknown as Record<string, unknown>),
        {
          ...(payload.publicReadable === undefined ? {} : { publicReadable: payload.publicReadable }),
        },
      );
      await applyAgentBindings({
        agentConfigId: agent.id,
        request: readAgentBindingRequest(payload as unknown as Record<string, unknown>),
        actor,
      });

      const organizationNames = await resolveOrganizationNames(identity, [agent.scope.organizationId]);
      return await buildAgentDetail(actor, agent, organizationNames.get(agent.scope.organizationId ?? ""));
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
      403: ApiErrorResponseSchema,
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
    const actor = store.actor as ActorContext | null;
    if (!actor) {
      return error(401, { error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
    }
    const organizationId = activeOrganizationKey(actor);
    if (!organizationId) {
      return error(401, { error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
    }
    const { id } = params as { id: string };

    try {
      const { facade } = getAgentConfigModule();
      const resourceKey = toAgentResourceKey(organizationId, id);
      const agent = await facade.get(actor, resourceKey);
      if (!agent) {
        return error(404, { error: { code: "NOT_FOUND", message: `Agent '${id}' not found` } });
      }
      if (isBuiltInAgent(agent.name)) {
        return error(403, { error: { code: "FORBIDDEN", message: `Cannot delete built-in agent '${agent.name}'` } });
      }

      await facade.remove(actor, resourceKey);
      return { id: agent.id, deleted: true as const };
    } catch (err) {
      // 可见但无 `delete` 动作（403）由宿主错误类携带状态码；不可见资源在上面的读取处已经成为 404。
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
