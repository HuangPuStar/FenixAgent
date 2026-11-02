import { WebOkSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import * as z from "zod/v4";
import type { WebConfigProvidersRouteDependencies } from "../../dependencies";
import {
  handleAddModel,
  handleFetchModels,
  handleProviderDelete,
  handleProviderGet,
  handleProviderList,
  handleProviderSet,
  handleRemoveModel,
  handleTestModel,
  handleUpdateModel,
} from "./provider-handlers";
import { safeWebHandler } from "./web-envelope";

const probeError = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
  data: z.unknown().optional(),
});
const response = {
  200: WebOkSchema(z.union([z.looseObject({}), z.null()])),
  400: probeError,
  401: probeError,
  403: probeError,
  404: probeError,
  409: probeError,
  500: probeError,
};
const params = z.object({ providerId: z.string().min(1) });
const childParams = z.object({ providerId: z.string().min(1), id: z.string().min(1) });
const body = z.record(z.string(), z.unknown());
const probeBody = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  protocol: z.enum(["openai", "anthropic"]).optional(),
});
const detail = (summary: string) => ({ tags: ["ProviderConfig"], summary });

/** Provider 及 Model 子资源的 REST 接口，平台 ID 与上游模型代码分别传递。 */
export function createWebConfigProvidersRoutes(deps: WebConfigProvidersRouteDependencies) {
  const resolve = deps.resolveSecretReference;
  const app = new Elysia({ name: "web-config-providers" }).use(deps.authGuardPlugin);
  app.get(
    "/config/providers",
    safeWebHandler((_ctx, actor) => handleProviderList(actor, resolve)),
    { sessionAuth: true, query: z.strictObject({}), response, detail: detail("列出 Provider") },
  );
  app.post(
    "/config/providers",
    safeWebHandler((ctx, actor) => {
      const { name, ...data } = ctx.body;
      return handleProviderSet(actor, name, data, resolve, true);
    }),
    { sessionAuth: true, body: z.looseObject({ name: z.string().min(1) }), response, detail: detail("创建 Provider") },
  );
  app.post(
    "/config/providers/probe-models",
    safeWebHandler((ctx, actor) => handleFetchModels(actor, undefined, ctx.body, resolve)),
    { sessionAuth: true, body: probeBody, response, detail: detail("获取未保存 Provider 的上游模型") },
  );
  app.get(
    "/config/providers/:providerId",
    safeWebHandler((ctx, actor) => handleProviderGet(actor, ctx.params.providerId, resolve)),
    { sessionAuth: true, params, response, detail: detail("按 ID 获取 Provider") },
  );
  app.patch(
    "/config/providers/:providerId",
    safeWebHandler((ctx, actor) => handleProviderSet(actor, ctx.params.providerId, ctx.body, resolve)),
    { sessionAuth: true, params, body, response, detail: detail("按 ID 修改 Provider") },
  );
  app.delete(
    "/config/providers/:providerId",
    safeWebHandler((ctx, actor) => handleProviderDelete(actor, ctx.params.providerId)),
    { sessionAuth: true, params, response, detail: detail("按 ID 删除 Provider") },
  );
  app.post(
    "/config/providers/:providerId/fetch-models",
    safeWebHandler((ctx, actor) => handleFetchModels(actor, ctx.params.providerId, ctx.body, resolve)),
    { sessionAuth: true, params, body: probeBody, response, detail: detail("获取已有 Provider 的上游模型") },
  );
  app.post(
    "/config/providers/:providerId/models",
    safeWebHandler((ctx, actor) => handleAddModel(actor, ctx.params.providerId, ctx.body)),
    { sessionAuth: true, params, body, response, detail: detail("添加 Model") },
  );
  app.patch(
    "/config/providers/:providerId/models/:id",
    safeWebHandler((ctx, actor) => handleUpdateModel(actor, ctx.params.providerId, ctx.params.id, ctx.body)),
    { sessionAuth: true, params: childParams, body, response, detail: detail("按 ID 修改 Model") },
  );
  app.delete(
    "/config/providers/:providerId/models/:id",
    safeWebHandler((ctx, actor) => handleRemoveModel(actor, ctx.params.providerId, ctx.params.id)),
    { sessionAuth: true, params: childParams, response, detail: detail("按 ID 删除 Model") },
  );
  app.post(
    "/config/providers/:providerId/models/:id/test",
    safeWebHandler((ctx, actor) => handleTestModel(actor, ctx.params.providerId, ctx.params.id, resolve)),
    { sessionAuth: true, params: childParams, response, detail: detail("按 ID 测试 Model") },
  );
  return app;
}
