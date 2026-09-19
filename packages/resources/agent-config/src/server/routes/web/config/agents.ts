import type { ActorContext } from "@fenix/platform-sdk";
import { WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import { authGuardPlugin } from "@server/plugins/auth";
import Elysia from "elysia";
import * as z from "zod/v4";
import { AgentNameQuerySchema } from "../../../schemas/config.schema";
import {
  agentRouteModels,
  buildWebErrorBody,
  handleCreate,
  handleDelete,
  handleGet,
  handleList,
  handleRestart,
  handleSet,
  handleSetDefault,
  handleTemplates,
  runWebHandler,
} from "./agent-route-support";

/**
 * `/web/config/agents` 协议层。
 *
 * 只做协议接入：请求体校验、把请求映射为应用调用、把结果映射为 `/web` 视图。授权、可见性、名称与
 * 资源键解析全部在 Facade 内完成，本文件不判断组织、角色或 `visibility`。
 *
 * 视图变化（决策 D2）：列表与详情不再返回旧栈的 `resourceAccess`，改为返回资源归属 `scope` 与当前
 * 主体有效动作 `access.actions`；`organizationName` 是展示字段，由身份目录批量解析。
 */

const app = new Elysia({ name: "web-config-agents" }).use(authGuardPlugin).model(agentRouteModels);

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * 成功响应 schema。
 *
 * 宽松对象而不是逐字段声明：`scope` / `access` 的形状由授权栈决定，本包不再重复声明一份字段清单，
 * 与 mcp / skill 的同名路由保持一致。
 */
const looseOkSchema = WebOkSchema(z.union([z.looseObject({}), z.null()]));

// biome-ignore lint/suspicious/noExplicitAny: Elysia 在自定义 response schema 下类型推断不稳定
function nameQuery(query: any): string | undefined {
  const name = query?.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

const nameQuerySchema = z.object({
  name: AgentNameQuerySchema.shape.name.describe("Agent 名称或共享资源键；不传则为列表模式。"),
});

/**
 * OpenAPI 的 `name` 查询参数描述。
 *
 * 用工厂函数而不是共享常量：常量在第一次使用处被上下文定型后，`schema.type` 会被拓宽成 `string`，
 * 后续使用点反而报类型错误；这里每次返回一个新的字面量对象。
 */
function nameParamDetail() {
  return {
    name: "name",
    in: "query" as const,
    required: true,
    description: "Agent 名称或共享资源键。",
    schema: { type: "string" as const },
  };
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
  // biome-ignore lint/suspicious/noExplicitAny: Elysia status 函数在自定义 response schema 下类型不稳定
  ({ store, query, status }: any) => {
    const name = nameQuery(query);
    return runWebHandler(status, store, (actor: ActorContext) => (name ? handleGet(actor, name) : handleList(actor)));
  },
  {
    sessionAuth: true,
    query: nameQuerySchema,
    response: {
      200: looseOkSchema,
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
  // biome-ignore lint/suspicious/noExplicitAny: Elysia status 函数在自定义 response schema 下类型不稳定
  ({ store, body, status }: any) => {
    const name = typeof body?.name === "string" ? body.name : undefined;
    if (!name) return status(400, buildWebErrorBody("VALIDATION_ERROR", "Missing 'name' field"));
    return runWebHandler(status, store, (actor: ActorContext) => handleCreate(actor, name, toRecord(body?.data)));
  },
  {
    sessionAuth: true,
    body: "agent-mutation-body",
    response: {
      200: looseOkSchema,
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
  // biome-ignore lint/suspicious/noExplicitAny: Elysia status 函数在自定义 response schema 下类型不稳定
  ({ store, query, body, status }: any) => {
    const name = nameQuery(query);
    if (!name) return status(400, buildWebErrorBody("VALIDATION_ERROR", "Missing 'name' field"));
    return runWebHandler(status, store, (actor: ActorContext) => handleSet(actor, name, toRecord(body?.data)));
  },
  {
    sessionAuth: true,
    query: nameQuerySchema,
    body: "agent-update-body",
    response: {
      200: looseOkSchema,
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
      parameters: [nameParamDetail()],
    },
  },
);

app.post(
  "/config/agents/restart",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia status 函数在自定义 response schema 下类型不稳定
  ({ store, query, status }: any) => {
    const name = nameQuery(query);
    if (!name) return status(400, buildWebErrorBody("VALIDATION_ERROR", "Missing 'name' field"));
    return runWebHandler(status, store, (actor: ActorContext) => handleRestart(actor, name));
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
      parameters: [nameParamDetail()],
    },
  },
);

app.delete(
  "/config/agents",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia status 函数在自定义 response schema 下类型不稳定
  ({ store, query, status }: any) => {
    const name = nameQuery(query);
    if (!name) return status(400, buildWebErrorBody("VALIDATION_ERROR", "Missing 'name' field"));
    return runWebHandler(status, store, (actor: ActorContext) => handleDelete(actor, name));
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
      description: "删除指定 Agent 配置。内置 Agent 不允许删除，只读的共享 Agent 也不允许删除。",
      parameters: [nameParamDetail()],
    },
  },
);

app.post(
  "/config/agents/default",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia status 函数在自定义 response schema 下类型不稳定
  ({ store, body, status }: any) => {
    const name = typeof body?.name === "string" ? body.name : undefined;
    if (!name) return status(400, buildWebErrorBody("VALIDATION_ERROR", "Missing 'name' field"));
    return runWebHandler(status, store, (actor: ActorContext) => handleSetDefault(actor, name));
  },
  {
    sessionAuth: true,
    body: "agent-set-default-body",
    response: {
      200: looseOkSchema,
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
