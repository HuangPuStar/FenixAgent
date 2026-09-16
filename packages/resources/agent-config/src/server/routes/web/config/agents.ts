import { InvalidKnowledgeBindingError } from "@fenix/resource-knowledge/server";
import Elysia from "elysia";
import * as z from "zod/v4";
import { AppError } from "../../../../../../../../apps/server/src/errors";
import { authGuardPlugin } from "../../../../../../../../apps/server/src/plugins/auth";
import { WebErrSchema } from "../../../../../../../../src/schemas/common.schema";
import { AgentNameQuerySchema, GetAgentResponseSchema } from "../../../schemas/config.schema";
import {
  agentRouteModels,
  handleCreate,
  handleDelete,
  handleGet,
  handleList,
  handleRestart,
  handleSet,
  handleSetDefault,
  handleTemplates,
} from "./agent-route-support";

const app = new Elysia({ name: "web-config-agents" }).use(authGuardPlugin).model(agentRouteModels);

type WebErrorBody = z.infer<typeof WebErrSchema>;

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

function buildWebErrorBody(code: string, message: string): WebErrorBody {
  return {
    success: false,
    error: { code, message },
  };
}

function resolveConfigRouteError<TCode extends 400 | 403 | 404 | 409>(
  result: unknown,
): { code: TCode; body: WebErrorBody } | null {
  if (!isConfigErrorResult(result)) return null;

  return {
    code: mapConfigErrorStatus(result.error.code) as TCode,
    body: buildWebErrorBody(result.error.code ?? "UNKNOWN_ERROR", result.error.message ?? "未知错误"),
  };
}

function resolveThrownAgentError(error_: unknown): { code: 400; body: WebErrorBody } | null {
  if (
    error_ instanceof InvalidKnowledgeBindingError ||
    (typeof error_ === "object" &&
      error_ !== null &&
      "code" in error_ &&
      (error_ as { code?: string }).code === "INVALID_KNOWLEDGE_BINDINGS")
  ) {
    const message = error_ instanceof Error ? error_.message : "知识库绑定无效";
    return {
      code: 400,
      body: buildWebErrorBody("INVALID_KNOWLEDGE_BINDINGS", message),
    };
  }

  if (error_ instanceof AppError && error_.code === "VALIDATION_ERROR") {
    return {
      code: 400,
      body: buildWebErrorBody("VALIDATION_ERROR", error_.message),
    };
  }

  return null;
}

app.get("/config/agents/templates", () => handleTemplates(), {
  sessionAuth: true,
  response: {
    200: "agent-templates-response",
    400: WebErrSchema,
    401: WebErrSchema,
    403: WebErrSchema,
    404: WebErrSchema,
  },
  detail: {
    tags: ["AgentConfig"],
    summary: "获取 Agent 模板列表",
    description: "返回系统内置的 Agent 模板列表，供前端创建 Agent 时选择预设 prompt 与默认 skill。",
  },
});

app.get(
  "/config/agents",
  async ({ store, query, status }) => {
    const authCtx = store.authContext!;
    const name = typeof query?.name === "string" ? query.name : undefined;
    try {
      const result = (name ? await handleGet(authCtx, name) : await handleList(authCtx)) as
        | z.infer<typeof GetAgentResponseSchema>
        | WebErrorBody;
      const err = resolveConfigRouteError<400 | 403 | 404>(result);
      if (err) return status(err.code, err.body);
      return result as z.infer<typeof GetAgentResponseSchema>;
    } catch (error_) {
      const err = resolveThrownAgentError(error_);
      if (err) return status(err.code, err.body);
      throw error_;
    }
  },
  {
    sessionAuth: true,
    query: "agent-name-query",
    response: {
      200: GetAgentResponseSchema,
      400: WebErrSchema,
      401: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
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
  async ({ store, body, status }) => {
    const authCtx = store.authContext!;
    const name = typeof body?.name === "string" ? body.name : undefined;
    if (!name) {
      return status(400, buildWebErrorBody("VALIDATION_ERROR", "Missing 'name' field"));
    }
    try {
      const result = await handleCreate(authCtx, name, toRecord(body?.data));
      const err = resolveConfigRouteError<400 | 403 | 404 | 409>(result);
      if (err) return status(err.code, err.body);
      return result;
    } catch (error_) {
      const err = resolveThrownAgentError(error_);
      if (err) return status(err.code, err.body);
      throw error_;
    }
  },
  {
    sessionAuth: true,
    body: "agent-mutation-body",
    response: {
      200: "agent-create-response",
      400: WebErrSchema,
      401: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
      409: WebErrSchema,
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
  async ({ store, query, body, status }) => {
    const authCtx = store.authContext!;
    const name = typeof query?.name === "string" ? query.name : undefined;
    if (!name) {
      return status(400, buildWebErrorBody("VALIDATION_ERROR", "Missing 'name' field"));
    }
    try {
      const result = await handleSet(authCtx, name, toRecord(body?.data));
      const err = resolveConfigRouteError<400 | 403 | 404 | 409>(result);
      if (err) return status(err.code, err.body);
      return result;
    } catch (error_) {
      const err = resolveThrownAgentError(error_);
      if (err) return status(err.code, err.body);
      throw error_;
    }
  },
  {
    sessionAuth: true,
    query: z.object({ name: AgentNameQuerySchema.shape.name }),
    body: "agent-update-body",
    response: {
      200: "agent-update-response",
      400: WebErrSchema,
      401: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
      409: WebErrSchema,
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

app.post(
  "/config/agents/restart",
  async ({ store, query, status }) => {
    const authCtx = store.authContext!;
    const name = typeof query?.name === "string" ? query.name : undefined;
    if (!name) {
      return status(400, buildWebErrorBody("VALIDATION_ERROR", "Missing 'name' field"));
    }
    const result = await handleRestart(authCtx, name);
    const err = resolveConfigRouteError<403 | 404>(result);
    if (err) return status(err.code, err.body);
    return result;
  },
  {
    sessionAuth: true,
    query: z.object({ name: AgentNameQuerySchema.shape.name }),
    response: {
      200: "agent-restart-response",
      400: WebErrSchema,
      401: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
    },
    detail: {
      tags: ["AgentConfig"],
      summary: "重启 Agent 运行实例",
      description:
        "重启当前组织内指定 Agent 绑定 Environment 下的活跃 runtime；保留持久 Agent Instance 身份，并使用最新 Agent 配置重新启动。",
      parameters: [
        {
          name: "name",
          in: "query",
          required: true,
          description: "待重启运行实例的 Agent 名称。",
          schema: { type: "string" },
        },
      ],
    },
  },
);

app.delete(
  "/config/agents",
  async ({ store, query, status }) => {
    const authCtx = store.authContext!;
    const name = typeof query?.name === "string" ? query.name : undefined;
    if (!name) {
      return status(400, buildWebErrorBody("VALIDATION_ERROR", "Missing 'name' field"));
    }
    try {
      const result = await handleDelete(authCtx, name);
      const err = resolveConfigRouteError<400 | 403 | 404>(result);
      if (err) return status(err.code, err.body);
      return result;
    } catch (error_) {
      const err = resolveThrownAgentError(error_);
      if (err) return status(err.code, err.body);
      throw error_;
    }
  },
  {
    sessionAuth: true,
    query: z.object({ name: AgentNameQuerySchema.shape.name }),
    response: {
      200: "agent-delete-response",
      400: WebErrSchema,
      401: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
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
  async ({ store, body, status }) => {
    const authCtx = store.authContext!;
    const name = typeof body?.name === "string" ? body.name : undefined;
    if (!name) {
      return status(400, buildWebErrorBody("VALIDATION_ERROR", "Missing 'name' field"));
    }
    try {
      const result = await handleSetDefault(authCtx, name);
      const err = resolveConfigRouteError<400 | 403 | 404>(result);
      if (err) return status(err.code, err.body);
      return result;
    } catch (error_) {
      const err = resolveThrownAgentError(error_);
      if (err) return status(err.code, err.body);
      throw error_;
    }
  },
  {
    sessionAuth: true,
    body: "agent-set-default-body",
    response: {
      200: "agent-set-default-response",
      400: WebErrSchema,
      401: WebErrSchema,
      403: WebErrSchema,
      404: WebErrSchema,
    },
    detail: {
      tags: ["AgentConfig"],
      summary: "设置默认 Agent",
      description: "将指定 Agent 设置为当前用户的默认 Agent，后续创建会话或打开面板时可作为默认选择。",
    },
  },
);

export default app;
