import type { ActorContext, IdentityDirectory } from "@fenix/platform-sdk";
import { ApiErrorResponseSchema, AppError, toResourceAccessView } from "@fenix/platform-sdk";
import Elysia from "elysia";
import type { AuthorizedMcpServer } from "../../facades/mcp-server-facade";
import { getMcpServerModule } from "../../runtime";
import {
  type ApiMcpCreateBody,
  ApiMcpCreateBodySchema,
  ApiMcpDeleteResponseSchema,
  ApiMcpDetailSchema,
  ApiMcpIdParamsSchema,
  type ApiMcpListQuery,
  ApiMcpListQuerySchema,
  ApiMcpListResponseSchema,
  type ApiMcpUpdateBody,
  ApiMcpUpdateBodySchema,
} from "../../schemas/api-mcp.schema";
import { type McpServerConfig, parseMcpConfigValue, readMcpServerType } from "../../services/config/mcp-config";
import type { McpRouteDependencies } from "../dependencies";

/**
 * `/api/mcp` 协议层（对外已发布合同）。
 *
 * 分页与计数下推到数据库的授权查询（决策 D3）：`total` 是当前主体可见资源的真实总数，列表只取
 * 当前页，不再"全量读出后内存切片"。
 *
 * `resourceAccess` 是**唯一**保留旧字段形状的位置（决策 D2）：它由 `toResourceAccessView` 从
 * `scope + access.actions` 派生，资源包不再各自解释权限。
 *
 * 导出的是**路由工厂**而非构造好的实例：`sessionAuth` 宏与 `store.actor` 由宿主守卫写入，Elysia
 * 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例回填，因此守卫由宿主注入
 * （`McpRouteDependencies`）。
 */

/**
 * 将业务异常映射到对外 API 的稳定错误结构。
 */
function mapApiError(err: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (err instanceof AppError) {
    return { status: err.statusCode, body: { error: { code: err.code, message: err.message } } };
  }
  return {
    status: 500,
    body: { error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Unknown error" } },
  };
}

/**
 * 将 MCP 配置请求体映射为服务层使用的配置对象。
 */
function toMcpConfig(body: ApiMcpCreateBody | ApiMcpUpdateBody): McpServerConfig {
  const config: Record<string, unknown> = {
    type: body.type ?? (body.url ? "remote" : "local"),
  };
  if (body.command !== undefined) config.command = body.command;
  if (body.url !== undefined) config.url = body.url;
  if (body.headers !== undefined) config.headers = body.headers;
  if (body.timeout !== undefined) config.timeout = body.timeout;
  if (body.oauth !== undefined) config.oauth = body.oauth ?? false;
  return config as unknown as McpServerConfig;
}

/** 展示用的服务器类型：配置里的 `type` 优先，缺失时回落到存储列。 */
function resolveDisplayType(server: AuthorizedMcpServer): "local" | "remote" | "streamable-http" {
  const config = parseMcpConfigValue(server.config) ?? {};
  const type = typeof config.type === "string" ? config.type : server.type;
  if (type === "streamable-http") return "streamable-http";
  return type === "remote" ? "remote" : "local";
}

function buildSummary(server: AuthorizedMcpServer): string {
  const config = parseMcpConfigValue(server.config) ?? {};
  if (typeof config.url === "string") return config.url;
  return Array.isArray(config.command) ? ((config.command[0] as string | undefined) ?? "") : "";
}

/** 派生已发布合同的资源访问视图；组织名称由调用方批量解析后传入。 */
function buildResourceAccess(
  server: AuthorizedMcpServer,
  activeOrganizationId: string | undefined,
  sourceOrganizationName: string | undefined,
) {
  return toResourceAccessView({
    resource: { id: server.id, scope: server.scope, access: server.access },
    ...(activeOrganizationId === undefined ? {} : { activeOrganizationId }),
    ...(sourceOrganizationName === undefined ? {} : { sourceOrganizationName }),
  });
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

/**
 * 组装对外 MCP 列表项。
 */
function toMcpListItem(
  server: AuthorizedMcpServer,
  toolsCount: number,
  activeOrganizationId: string | undefined,
  sourceOrganizationName: string | undefined,
) {
  return {
    id: server.id,
    name: server.name,
    type: resolveDisplayType(server),
    enabled: server.enabled ?? true,
    summary: buildSummary(server),
    toolsCount,
    resourceAccess: buildResourceAccess(server, activeOrganizationId, sourceOrganizationName),
  };
}

/**
 * 组装对外 MCP 详情。
 */
function toMcpDetail(
  server: AuthorizedMcpServer,
  activeOrganizationId: string | undefined,
  sourceOrganizationName: string | undefined,
) {
  return {
    id: server.id,
    name: server.name,
    type: resolveDisplayType(server),
    enabled: server.enabled ?? true,
    summary: buildSummary(server),
    config: server.config,
    resourceAccess: buildResourceAccess(server, activeOrganizationId, sourceOrganizationName),
  };
}

export function createApiMcpRoutes(deps: McpRouteDependencies) {
  const app = new Elysia({ name: "api-mcp", prefix: "/api/mcp" }).use(deps.authGuardPlugin).model({
    "api-mcp-list-query": ApiMcpListQuerySchema,
    "api-mcp-id-params": ApiMcpIdParamsSchema,
    "api-mcp-create-body": ApiMcpCreateBodySchema,
    "api-mcp-update-body": ApiMcpUpdateBodySchema,
    "api-mcp-list-response": ApiMcpListResponseSchema,
    "api-mcp-detail": ApiMcpDetailSchema,
    "api-mcp-delete-response": ApiMcpDeleteResponseSchema,
  });

  app.get(
    "",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
    async ({ store, query, error }: any) => {
      const actor = store.actor as ActorContext | null;
      if (!actor) {
        return error(401, { error: { code: "UNAUTHORIZED", message: "请求缺少组织上下文" } });
      }
      const { page, pageSize } = query as ApiMcpListQuery;

      try {
        const { facade, identity } = getMcpServerModule();
        const { items, total } = await facade.list(actor, {
          limit: pageSize,
          offset: (page - 1) * pageSize,
        });
        const organizationNames = await resolveOrganizationNames(
          identity,
          items.map((item) => item.scope.organizationId),
        );
        return {
          items: items.map((item) =>
            toMcpListItem(
              item,
              item.toolsCount,
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
      query: "api-mcp-list-query",
      response: {
        200: "api-mcp-list-response",
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        500: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["External MCP"],
        summary: "获取 MCP Server 列表",
        description: "返回当前主体可见的 MCP Server 列表，采用稳定分页结构；分页与计数在数据库内完成。",
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
        const { facade, identity } = getMcpServerModule();
        const server = await facade.getById(actor, id);
        if (!server) {
          return error(404, { error: { code: "NOT_FOUND", message: `MCP server '${id}' not found` } });
        }
        const organizationNames = await resolveOrganizationNames(identity, [server.scope.organizationId]);
        return toMcpDetail(
          server,
          actor.activeOrganizationId,
          organizationNames.get(server.scope.organizationId ?? ""),
        );
      } catch (err) {
        const mapped = mapApiError(err);
        return error(mapped.status, mapped.body);
      }
    },
    {
      sessionAuth: true,
      params: "api-mcp-id-params",
      response: {
        200: "api-mcp-detail",
        401: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        500: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["External MCP"],
        summary: "获取 MCP Server 详情",
        description: "按 MCP Server 唯一 ID 返回配置详情。",
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
      const payload = body as ApiMcpCreateBody;

      try {
        const { facade, identity } = getMcpServerModule();
        const existing = await facade.get(actor, payload.name);
        if (existing) {
          return error(409, { error: { code: "CONFLICT", message: `MCP server '${payload.name}' already exists` } });
        }

        const config = toMcpConfig(payload);
        const resourceId = await facade.create(actor, {
          name: payload.name,
          type: readMcpServerType(config),
          config,
          ...(payload.publicReadable === undefined ? {} : { publicReadable: payload.publicReadable }),
        });

        const detail = await facade.getById(actor, resourceId);
        if (!detail) {
          return error(500, { error: { code: "INTERNAL_ERROR", message: "MCP server could not be reloaded" } });
        }
        const organizationNames = await resolveOrganizationNames(identity, [detail.scope.organizationId]);
        return toMcpDetail(
          detail,
          actor.activeOrganizationId,
          organizationNames.get(detail.scope.organizationId ?? ""),
        );
      } catch (err) {
        const mapped = mapApiError(err);
        return error(mapped.status, mapped.body);
      }
    },
    {
      sessionAuth: true,
      body: "api-mcp-create-body",
      response: {
        200: "api-mcp-detail",
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        409: ApiErrorResponseSchema,
        500: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["External MCP"],
        summary: "创建 MCP Server",
        description: "创建一个新的 MCP Server 配置。名称已存在时返回冲突错误。",
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
      const { id } = params as { id: string };
      const payload = body as ApiMcpUpdateBody;

      try {
        const { facade, identity } = getMcpServerModule();
        // 不可见或无 `update` 动作都会抛出宿主错误类，由 mapApiError 映射为 404 / 403。
        await facade.updateById(actor, id, toMcpConfig(payload), {
          ...(payload.publicReadable === undefined ? {} : { publicReadable: payload.publicReadable }),
        });

        const detail = await facade.getById(actor, id);
        if (!detail) {
          return error(500, { error: { code: "INTERNAL_ERROR", message: "MCP server could not be reloaded" } });
        }
        const organizationNames = await resolveOrganizationNames(identity, [detail.scope.organizationId]);
        return toMcpDetail(
          detail,
          actor.activeOrganizationId,
          organizationNames.get(detail.scope.organizationId ?? ""),
        );
      } catch (err) {
        const mapped = mapApiError(err);
        return error(mapped.status, mapped.body);
      }
    },
    {
      sessionAuth: true,
      params: "api-mcp-id-params",
      body: "api-mcp-update-body",
      response: {
        200: "api-mcp-detail",
        400: ApiErrorResponseSchema,
        401: ApiErrorResponseSchema,
        403: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        500: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["External MCP"],
        summary: "更新 MCP Server",
        description: "按 MCP Server 唯一 ID 更新连接配置与共享访问设置。",
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
      const { id } = params as { id: string };

      try {
        await getMcpServerModule().facade.removeById(actor, id);
        return { id, deleted: true as const };
      } catch (err) {
        // 不可见（404）与可见但无 `delete` 动作（403）都由宿主错误类携带状态码。
        const mapped = mapApiError(err);
        return error(mapped.status, mapped.body);
      }
    },
    {
      sessionAuth: true,
      params: "api-mcp-id-params",
      response: {
        200: "api-mcp-delete-response",
        401: ApiErrorResponseSchema,
        403: ApiErrorResponseSchema,
        404: ApiErrorResponseSchema,
        500: ApiErrorResponseSchema,
      },
      detail: {
        tags: ["External MCP"],
        summary: "删除 MCP Server",
        description: "按 MCP Server 唯一 ID 删除配置。",
      },
    },
  );

  return app;
}
