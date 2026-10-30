import { WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import * as z from "zod/v4";
import type { McpRouteDependencies } from "../../dependencies";
import {
  handleCreate,
  handleDelete,
  handleDisable,
  handleEnable,
  handleGet,
  handleInspect,
  handleList,
  handleListTools,
  handleTest,
  handleTestUrl,
  handleUpdate,
  runWebHandler,
} from "./mcp-route-support";

const response = {
  200: WebOkSchema(z.union([z.looseObject({}), z.null()])),
  400: WebErrSchema,
  401: WebErrSchema,
  403: WebErrSchema,
  404: WebErrSchema,
  409: WebErrSchema,
};
const params = z.object({ id: z.string().min(1).describe("MCP 数据库资源 ID。") });
const detail = (summary: string) => ({ tags: ["McpConfig"], summary });

/** MCP 资源 REST 接口；无资源的 URL 探测独立于 ID 路径。 */
export function createWebMcpConfigRoutes(deps: McpRouteDependencies) {
  const app = new Elysia({ name: "web-config-mcp" }).use(deps.authGuardPlugin);
  app.get("/config/mcp", ({ store, status }) => runWebHandler(status, store, handleList), {
    sessionAuth: true,
    query: z.strictObject({}),
    response,
    detail: detail("获取 MCP 列表"),
  });
  app.post(
    "/config/mcp",
    ({ store, status, body }) =>
      runWebHandler(status, store, (actor) => handleCreate(actor, body.name, body.config, body.publicReadable)),
    {
      sessionAuth: true,
      body: z.object({ name: z.string().min(1), config: z.unknown(), publicReadable: z.boolean().optional() }),
      response,
      detail: detail("创建 MCP 配置"),
    },
  );
  app.post(
    "/config/mcp/test-url",
    ({ store, status, body }) =>
      runWebHandler(status, store, () => handleTestUrl(body.url ?? "", body.headers, body.timeout)),
    {
      sessionAuth: true,
      body: z.object({
        url: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        timeout: z.number().optional(),
      }),
      response,
      detail: detail("探测未保存的 MCP URL"),
    },
  );
  app.get(
    "/config/mcp/:id",
    ({ store, status, params }) => runWebHandler(status, store, (actor) => handleGet(actor, params.id)),
    { sessionAuth: true, params, response, detail: detail("按 ID 获取 MCP 详情") },
  );
  app.patch(
    "/config/mcp/:id",
    ({ store, status, params, body }) =>
      runWebHandler(status, store, (actor) =>
        "enabled" in body
          ? body.enabled
            ? handleEnable(actor, params.id)
            : handleDisable(actor, params.id)
          : handleUpdate(actor, params.id, body.config, body.publicReadable),
      ),
    {
      sessionAuth: true,
      params,
      body: z.union([
        z.strictObject({ enabled: z.boolean() }),
        z.strictObject({ config: z.unknown(), publicReadable: z.boolean().optional() }),
      ]),
      response,
      detail: detail("按 ID 修改 MCP 配置或启停状态"),
    },
  );
  app.delete(
    "/config/mcp/:id",
    ({ store, status, params }) => runWebHandler(status, store, (actor) => handleDelete(actor, params.id)),
    { sessionAuth: true, params, response, detail: detail("按 ID 删除 MCP 配置") },
  );
  app.post(
    "/config/mcp/:id/test",
    ({ store, status, params }) => runWebHandler(status, store, (actor) => handleTest(actor, params.id)),
    { sessionAuth: true, params, response, detail: detail("测试已保存的 MCP 连接") },
  );
  app.post(
    "/config/mcp/:id/inspect",
    ({ store, status, params }) => runWebHandler(status, store, (actor) => handleInspect(actor, params.id)),
    { sessionAuth: true, params, response, detail: detail("检测 MCP 并同步工具") },
  );
  app.get(
    "/config/mcp/:id/tools",
    ({ store, status, params }) => runWebHandler(status, store, (actor) => handleListTools(actor, params.id)),
    { sessionAuth: true, params, response, detail: detail("获取 MCP 工具列表") },
  );
  return app;
}
