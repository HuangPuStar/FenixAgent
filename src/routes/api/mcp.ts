import Elysia from "elysia";
import { AppError } from "../../errors";
import { type AuthContext, authGuardPlugin } from "../../plugins/auth";
import { ApiErrorResponseSchema } from "../../schemas/api-common.schema";
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
import * as configPg from "../../services/config/index";
import { countToolsByServer } from "../../services/config/mcp-server";

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
function toMcpConfig(body: ApiMcpCreateBody | ApiMcpUpdateBody) {
  const config: Record<string, unknown> = {
    type: body.type ?? (body.url ? "remote" : "local"),
  };
  if (body.command !== undefined) config.command = body.command;
  if (body.url !== undefined) config.url = body.url;
  if (body.headers !== undefined) config.headers = body.headers;
  if (body.timeout !== undefined) config.timeout = body.timeout;
  if (body.oauth !== undefined) config.oauth = body.oauth ?? false;
  return config;
}

/**
 * 组装对外 MCP 列表项。
 */
async function toMcpListItem(server: Awaited<ReturnType<typeof configPg.listMcpServers>>[number]) {
  const type =
    server.config && typeof server.config === "object" && "type" in server.config
      ? ((server.config.type as string | undefined) ?? server.type)
      : server.type;

  try {
    const toolsCount = await countToolsByServer(server.organizationId, server.name);
    return {
      id: server.id,
      name: server.name,
      type: (type === "streamable-http" ? "streamable-http" : type === "remote" ? "remote" : "local") as
        | "local"
        | "remote"
        | "streamable-http",
      enabled: server.enabled ?? true,
      summary: String(
        (server.config as Record<string, unknown> | null)?.url ??
          ((server.config as Record<string, unknown> | null)?.command as string[] | undefined)?.[0] ??
          "",
      ),
      toolsCount,
      resourceAccess: server.resourceAccess,
    };
  } catch {
    return {
      id: server.id,
      name: server.name,
      type: (type === "streamable-http" ? "streamable-http" : type === "remote" ? "remote" : "local") as
        | "local"
        | "remote"
        | "streamable-http",
      enabled: server.enabled ?? true,
      summary: "",
      toolsCount: 0,
      resourceAccess: server.resourceAccess,
    };
  }
}

/**
 * 组装对外 MCP 详情。
 */
function toMcpDetail(server: NonNullable<Awaited<ReturnType<typeof configPg.getMcpServer>>>) {
  const config = (server.config as Record<string, unknown> | null) ?? {};
  const type =
    typeof config.type === "string"
      ? config.type
      : server.type === "streamable-http"
        ? "streamable-http"
        : server.type === "remote"
          ? "remote"
          : "local";

  return {
    id: server.id,
    name: server.name,
    type: (type === "streamable-http" ? "streamable-http" : type === "remote" ? "remote" : "local") as
      | "local"
      | "remote"
      | "streamable-http",
    enabled: server.enabled ?? true,
    summary: String(config.url ?? (Array.isArray(config.command) ? (config.command[0] ?? "") : "")),
    config: server.config,
    resourceAccess: server.resourceAccess,
  };
}

const app = new Elysia({ name: "api-mcp", prefix: "/api/mcp" }).use(authGuardPlugin).model({
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
    const authCtx = store.authContext as AuthContext;
    const { page, pageSize } = query as ApiMcpListQuery;

    try {
      const servers = await configPg.listMcpServers(authCtx);
      const total = servers.length;
      const start = (page - 1) * pageSize;
      const items = await Promise.all(servers.slice(start, start + pageSize).map((server) => toMcpListItem(server)));
      return { items, total, page, pageSize };
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
      description: "返回当前组织可见的 MCP Server 列表，采用稳定分页结构。",
    },
  },
);

app.get(
  "/:id",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext as AuthContext;
    const { id } = params as { id: string };

    try {
      const server = await configPg.getMcpServerById(authCtx, id);
      if (!server) {
        return error(404, { error: { code: "NOT_FOUND", message: `MCP server '${id}' not found` } });
      }
      return toMcpDetail(server);
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
    const authCtx = store.authContext as AuthContext;
    const payload = body as ApiMcpCreateBody;

    try {
      const existing = await configPg.getMcpServer(authCtx, payload.name);
      if (existing) {
        return error(409, { error: { code: "CONFLICT", message: `MCP server '${payload.name}' already exists` } });
      }

      const config = toMcpConfig(payload);
      await configPg.createMcpServer(authCtx, payload.name, String(config.type ?? "local"), config as never, {
        publicReadable: payload.publicReadable,
      });

      const detail = await configPg.getMcpServer(authCtx, payload.name);
      if (!detail) {
        return error(500, { error: { code: "INTERNAL_ERROR", message: "MCP server could not be reloaded" } });
      }
      return toMcpDetail(detail);
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
    const authCtx = store.authContext as AuthContext;
    const { id } = params as { id: string };
    const payload = body as ApiMcpUpdateBody;

    try {
      const updated = await configPg.updateMcpServerById(authCtx, id, toMcpConfig(payload) as never, {
        publicReadable: payload.publicReadable,
      });
      if (!updated) {
        return error(404, { error: { code: "NOT_FOUND", message: `MCP server '${id}' not found` } });
      }

      const detail = await configPg.getMcpServerById(authCtx, id);
      if (!detail) {
        return error(500, { error: { code: "INTERNAL_ERROR", message: "MCP server could not be reloaded" } });
      }
      return toMcpDetail(detail);
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
    const authCtx = store.authContext as AuthContext;
    const { id } = params as { id: string };

    try {
      const deleted = await configPg.deleteMcpServerById(authCtx, id);
      if (!deleted) {
        return error(404, { error: { code: "NOT_FOUND", message: `MCP server '${id}' not found` } });
      }
      return { id, deleted: true as const };
    } catch (err) {
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

export default app;
