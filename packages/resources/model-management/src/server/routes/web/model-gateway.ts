import { error as logError } from "@fenix/logger";
import type { ActorContext } from "@fenix/platform-sdk";
import Elysia from "elysia";
import { getModelGatewayServices } from "../../model-gateway";
import { ModelGatewayProviderNotVisibleError } from "../../model-gateway/provider-service";
import {
  WebModelGatewayErrorResponseSchema,
  WebModelGatewayUsageParamsSchema,
  WebModelGatewayUsageQuerySchema,
  WebModelGatewayUsageResponseSchema,
} from "../../schemas/web-model-gateway.schema";
import type { WebModelManagementRouteDependencies } from "../dependencies";

/**
 * 构造 `/web/model-gateway` 路由。
 *
 * 会话守卫由宿主注入：Elysia 的 `macro` / `state` 是实例作用域的，包内自建守卫会让同一进程出现两套
 * 互不可见的认证状态，见 `../dependencies`。
 */
export function createWebModelGatewayRoutes(deps: WebModelManagementRouteDependencies) {
  const app = new Elysia({ name: "web-model-gateway", prefix: "/model-gateway" }).use(deps.authGuardPlugin).model({
    "web-model-gateway-usage": WebModelGatewayUsageResponseSchema,
    "web-model-gateway-error": WebModelGatewayErrorResponseSchema,
  });

  /** 个人用量必须明确指定 Gateway Provider，用户身份始终来自当前会话。 */
  app.get(
    "/:providerId/usage",
    async ({ store, params, query, status }) => {
      // `sessionAuth: true` 已由 authGuardPlugin 拒绝未认证请求，因此 actor 必然存在。
      const actor = store.actor as ActorContext;
      try {
        const services = getModelGatewayServices();
        const provider = await services.provider.getProviderForUsage(actor, params.providerId);
        const [usage, budget] = await Promise.all([
          services.usage.queryUsage({
            gatewayProviderId: provider.id,
            userId: actor.userId,
            includeBreakdowns: true,
            ...query,
          }),
          services.budget.getUserBudget(provider.id, actor.userId),
        ]);
        return {
          ...usage,
          gatewayProvider: provider,
          budget,
        };
      } catch (cause) {
        // 不可见的 Provider 是确定性权限失败：映射 403，让用量页走 forbidden 分支（不给重试入口）。
        // `code` 必须写成 `UNAUTHORIZED`——前端 `request` 层的 `normalizeErrorCode` 只放行这个已知码，
        // 自定义码会原样透传，页面的 forbidden 分支就再也匹配不上，重试按钮会重新出现。
        if (cause instanceof ModelGatewayProviderNotVisibleError) {
          return status(403, {
            success: false,
            error: {
              code: "UNAUTHORIZED",
              message: "Model gateway provider is not visible to the current user",
            },
          });
        }
        // 其余是上游/网关类失败（含 Provider 不是本网关类型）：可能自愈，保持 400 让页面给出重试入口。
        logError("[Model-Management] query model gateway usage failed", cause);
        return status(400, {
          success: false,
          error: {
            code: "MODEL_GATEWAY_ERROR",
            message: "Unable to query usage",
          },
        });
      }
    },
    {
      sessionAuth: true,
      params: WebModelGatewayUsageParamsSchema,
      query: WebModelGatewayUsageQuerySchema,
      response: {
        200: "web-model-gateway-usage",
        400: "web-model-gateway-error",
        401: "web-model-gateway-error",
        403: "web-model-gateway-error",
      },
      detail: {
        tags: ["Model Gateway"],
        summary: "查询我的模型网关用量",
        description: "查询当前登录用户通过系统 Gateway Provider 的用量，不包含普通 Provider。",
      },
    },
  );

  return app;
}
