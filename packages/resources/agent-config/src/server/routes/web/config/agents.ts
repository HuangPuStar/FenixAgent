import { WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import * as z from "zod/v4";
import type { WebConfigAgentsRouteDependencies } from "../../dependencies";
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
  runWebHandler,
} from "./agent-route-support";

const response = {
  200: WebOkSchema(z.union([z.looseObject({}), z.null()])),
  400: WebErrSchema,
  401: WebErrSchema,
  403: WebErrSchema,
  404: WebErrSchema,
  409: WebErrSchema,
};
const params = z.object({ id: z.string().min(1).describe("Agent 数据库资源 ID。") });
const detail = (summary: string) => ({ tags: ["AgentConfig"], summary });

/** Agent 控制台 REST 接口；所有已有资源通过 ID 路径访问，偏好接口保留原契约。 */
export function createWebConfigAgentsRoutes(deps: WebConfigAgentsRouteDependencies) {
  const app = new Elysia({ name: "web-config-agents" }).use(deps.authGuardPlugin).model(agentRouteModels);
  app.get("/config/agents/templates", () => handleTemplates(), {
    sessionAuth: true,
    response,
    detail: detail("获取 Agent 模板列表"),
  });
  app.get(
    "/config/agents",
    ({ store, status }) => runWebHandler(status, store, (actor) => handleList(actor, deps.userAgentPreferences)),
    {
      sessionAuth: true,
      query: z.strictObject({}),
      response,
      detail: detail("获取 Agent 列表"),
    },
  );
  app.post(
    "/config/agents",
    ({ store, status, body }) =>
      runWebHandler(status, store, (actor) => handleCreate(actor, body.name, body.data ?? {})),
    {
      sessionAuth: true,
      body: "agent-mutation-body",
      response,
      detail: detail("创建 Agent 配置"),
    },
  );
  app.post(
    "/config/agents/default",
    ({ store, status, body }) =>
      runWebHandler(status, store, (actor) => handleSetDefault(actor, body.name, deps.userAgentPreferences)),
    {
      sessionAuth: true,
      body: "agent-set-default-body",
      response,
      detail: detail("设置默认 Agent"),
    },
  );
  app.get(
    "/config/agents/:id",
    ({ store, status, params }) => runWebHandler(status, store, (actor) => handleGet(actor, params.id)),
    {
      sessionAuth: true,
      params,
      response,
      detail: detail("按 ID 获取 Agent 详情"),
    },
  );
  app.patch(
    "/config/agents/:id",
    ({ store, status, params, body }) =>
      runWebHandler(status, store, (actor) => handleSet(actor, params.id, body.data)),
    {
      sessionAuth: true,
      params,
      body: "agent-update-body",
      response,
      detail: detail("按 ID 修改 Agent 配置"),
    },
  );
  app.delete(
    "/config/agents/:id",
    ({ store, status, params }) => runWebHandler(status, store, (actor) => handleDelete(actor, params.id)),
    {
      sessionAuth: true,
      params,
      response,
      detail: detail("按 ID 删除 Agent 配置"),
    },
  );
  app.post(
    "/config/agents/:id/restart",
    ({ store, status, params }) => runWebHandler(status, store, (actor) => handleRestart(actor, params.id)),
    {
      sessionAuth: true,
      params,
      response,
      detail: detail("按 ID 重启 Agent 实例"),
    },
  );
  return app;
}
