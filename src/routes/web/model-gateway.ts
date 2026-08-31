import Elysia from "elysia";
import { type AuthContext, authGuardPlugin } from "../../plugins/auth";
import {
  WebModelGatewayErrorResponseSchema,
  WebModelGatewayUsageParamsSchema,
  WebModelGatewayUsageQuerySchema,
  WebModelGatewayUsageResponseSchema,
} from "../../schemas/web-model-gateway.schema";
import { getModelGatewayServices } from "../../services/model-gateway";

const app = new Elysia({ name: "web-model-gateway", prefix: "/model-gateway" }).use(authGuardPlugin).model({
  "web-model-gateway-usage": WebModelGatewayUsageResponseSchema,
  "web-model-gateway-error": WebModelGatewayErrorResponseSchema,
});

/** 个人用量必须明确指定 Gateway Provider，用户身份始终来自当前会话。 */
app.get(
  "/:providerId/usage",
  async ({ store, params, query, status }) => {
    const context = store.authContext as AuthContext;
    try {
      const services = getModelGatewayServices();
      const provider = await services.provider.getProviderForUsage(context, params.providerId);
      const [usage, budget] = await Promise.all([
        services.usage.queryUsage({
          gatewayProviderId: provider.id,
          userId: context.userId,
          includeBreakdowns: true,
          ...query,
        }),
        services.budget.getUserBudget(provider.id, context.userId),
      ]);
      return {
        ...usage,
        gatewayProvider: provider,
        budget,
      };
    } catch (_cause) {
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
    },
    detail: {
      tags: ["Model Gateway"],
      summary: "查询我的模型网关用量",
      description: "查询当前登录用户通过系统 Gateway Provider 的用量，不包含普通 Provider。",
    },
  },
);

export default app;
