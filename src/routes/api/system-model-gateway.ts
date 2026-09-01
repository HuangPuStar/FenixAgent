import { error as logError } from "@fenix/logger";
import Elysia from "elysia";
import { config } from "../../config";
import { systemApiAuthPlugin } from "../../plugins/system-api-auth";
import {
  ModelGatewayAgentSubjectSchema,
  ModelGatewayApiErrorResponseSchema,
  ModelGatewayBudgetBodySchema,
  ModelGatewayBudgetListQuerySchema,
  ModelGatewayBudgetListResponseSchema,
  ModelGatewayBudgetUpdateResponseSchema,
  ModelGatewayBulkBudgetBodySchema,
  ModelGatewayBulkBudgetResetBodySchema,
  ModelGatewayBulkBudgetResponseSchema,
  ModelGatewayConfigurationSchema,
  ModelGatewayKeyListQuerySchema,
  ModelGatewayKeyListResponseSchema,
  ModelGatewayModelSyncResultSchema,
  ModelGatewayModelSyncStatusSchema,
  ModelGatewayProviderQuerySchema,
  ModelGatewayRemoveKeysBodySchema,
  ModelGatewayRemoveKeysResponseSchema,
  ModelGatewaySubjectQuerySchema,
  ModelGatewayUsageQuerySchema,
  ModelGatewayUsageResponseSchema,
  ModelGatewayUserIdParamsSchema,
  ModelGatewayUserListResponseSchema,
} from "../../schemas/api-model-gateway.schema";
import { getModelGatewayServices } from "../../services/model-gateway";

function toUserResponse(user: {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  phoneNumber: string | null;
  phoneNumberVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...user,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

const app = new Elysia({
  name: "api-system-model-gateway",
  prefix: "/api/system/model-gateway",
})
  .use(systemApiAuthPlugin)
  .model({
    "model-gateway-api-error": ModelGatewayApiErrorResponseSchema,
    "model-gateway-configuration": ModelGatewayConfigurationSchema,
    "model-gateway-model-sync-status": ModelGatewayModelSyncStatusSchema,
    "model-gateway-model-sync-result": ModelGatewayModelSyncResultSchema,
    "model-gateway-budget-list": ModelGatewayBudgetListResponseSchema,
    "model-gateway-budget-update": ModelGatewayBudgetUpdateResponseSchema,
    "model-gateway-bulk-budget-result": ModelGatewayBulkBudgetResponseSchema,
    "model-gateway-user-list": ModelGatewayUserListResponseSchema,
    "model-gateway-agent-subject-list": ModelGatewayAgentSubjectSchema.array(),
    "model-gateway-usage": ModelGatewayUsageResponseSchema,
    "model-gateway-key-list": ModelGatewayKeyListResponseSchema,
    "model-gateway-remove-keys": ModelGatewayRemoveKeysResponseSchema,
  })
  .get(
    "/config",
    async ({ status }) => {
      try {
        const { provider } = await getModelGatewayServices().provider.getConfiguration();
        return {
          provider,
          adminUiUrl: config.modelGatewayAdminUiUrl ?? null,
          defaultBudget: {
            maxBudgetUsd: config.modelGatewayDefaultUserBudgetUsd ?? null,
            duration: config.modelGatewayDefaultBudgetDuration ?? null,
          },
        };
      } catch (err) {
        logError("[Model-Gateway] get model gateway configuration failed", err);
        return status(500, {
          error: {
            code: "MODEL_GATEWAY_ERROR",
            message: "Unable to get model gateway configuration",
          },
        });
      }
    },
    {
      systemApiKeyAuth: true,
      response: {
        200: "model-gateway-configuration",
        401: "model-gateway-api-error",
        500: "model-gateway-api-error",
      },
      detail: { tags: ["System Model Gateway"], summary: "获取模型网关配置" },
    },
  )
  .get(
    "/keys",
    async ({ query, status }) => {
      try {
        const services = getModelGatewayServices();
        const providerId = await services.provider.ensureProvider();
        const result = await services.keyManagement.listKeys({ gatewayProviderId: providerId, ...query });
        return {
          ...result,
          items: result.items.map((item) => ({
            id: item.id,
            externalCredentialId: item.externalCredentialId,
            organizationId: item.organizationId,
            organizationName: item.organizationName ?? null,
            userId: item.userId,
            userName: item.userName ?? null,
            agentConfigId: item.agentConfigId,
            agentName: item.agentName ?? null,
            status: item.status,
            createdAt: item.createdAt.toISOString(),
            updatedAt: item.updatedAt.toISOString(),
            usable: item.usable,
            invalidReason: item.invalidReason,
          })),
        };
      } catch (err) {
        logError("[Model-Gateway] list managed keys failed", err);
        return status(500, { error: { code: "MODEL_GATEWAY_ERROR", message: "Unable to list model gateway keys" } });
      }
    },
    {
      systemApiKeyAuth: true,
      query: ModelGatewayKeyListQuerySchema,
      response: { 200: "model-gateway-key-list", 401: "model-gateway-api-error", 500: "model-gateway-api-error" },
      detail: { tags: ["System Model Gateway"], summary: "查询 Fenix 管理的模型网关 Key" },
    },
  )
  .post(
    "/keys/actions/remove",
    async ({ body, status }) => {
      try {
        return await getModelGatewayServices().keyManagement.removeKeys(body.ids);
      } catch (err) {
        logError("[Model-Gateway] remove unusable keys failed", err);
        return status(500, { error: { code: "MODEL_GATEWAY_ERROR", message: "Unable to remove model gateway keys" } });
      }
    },
    {
      systemApiKeyAuth: true,
      body: ModelGatewayRemoveKeysBodySchema,
      response: { 200: "model-gateway-remove-keys", 401: "model-gateway-api-error", 500: "model-gateway-api-error" },
      detail: { tags: ["System Model Gateway"], summary: "回收所选模型网关 Key" },
    },
  )
  .get(
    "/models/status",
    async ({ query, status }) => {
      try {
        const services = getModelGatewayServices();
        const providerId = query.providerId ?? (await services.provider.getProviderForCheck());
        const result = await services.provider.checkModels(providerId);
        return result.status === "unknown" ? status(503, result) : result;
      } catch (err) {
        logError("[Model-Gateway] check model gateway failed", err);
        return status(500, {
          error: {
            code: "MODEL_GATEWAY_ERROR",
            message: "Unable to check model gateway",
          },
        });
      }
    },
    {
      systemApiKeyAuth: true,
      query: ModelGatewayProviderQuerySchema,
      response: {
        200: "model-gateway-model-sync-status",
        401: "model-gateway-api-error",
        503: "model-gateway-model-sync-status",
        500: "model-gateway-api-error",
      },
      detail: {
        tags: ["System Model Gateway"],
        summary: "检查模型网关同步状态",
        description: "读取 LiteLLM 模型目录并与 Fenix Gateway Provider 投影进行只读对比。",
      },
    },
  )
  .post(
    "/budgets/actions/bulk-reset",
    async ({ body, status }) => {
      try {
        const providerId = await getModelGatewayServices().provider.ensureProvider();
        return await getModelGatewayServices().budget.resetUserBudgets(providerId, body.userIds);
      } catch (err) {
        logError("[Model-Gateway] bulk reset user budgets failed", err);
        return status(400, {
          error: {
            code: "MODEL_GATEWAY_ERROR",
            message: "Unable to reset user budgets",
          },
        });
      }
    },
    {
      systemApiKeyAuth: true,
      body: ModelGatewayBulkBudgetResetBodySchema,
      response: {
        200: "model-gateway-bulk-budget-result",
        400: "model-gateway-api-error",
        401: "model-gateway-api-error",
      },
      detail: {
        tags: ["System Model Gateway"],
        summary: "批量重置模型网关用户预算",
        description: "将最多 100 位用户的已消耗预算清零，不修改预算上限和周期。",
      },
    },
  )
  .post(
    "/models/actions/sync",
    async ({ query, status }) => {
      try {
        const services = getModelGatewayServices();
        const providerId = query.providerId ?? (await services.provider.ensureProvider());
        return await services.provider.syncModels(providerId);
      } catch (err) {
        logError("[Model-Gateway] sync model gateway failed", err);
        return status(500, {
          error: {
            code: "MODEL_GATEWAY_ERROR",
            message: "Unable to sync model gateway",
          },
        });
      }
    },
    {
      systemApiKeyAuth: true,
      query: ModelGatewayProviderQuerySchema,
      response: {
        200: "model-gateway-model-sync-result",
        401: "model-gateway-api-error",
        500: "model-gateway-api-error",
      },
      detail: {
        tags: ["System Model Gateway"],
        summary: "同步模型网关模型",
        description: "将 LiteLLM 当前模型目录手动同步为 Fenix Gateway Provider 的模型投影。",
      },
    },
  )
  .put(
    "/budgets/:userId",
    async ({ params, body, status }) => {
      try {
        const providerId = await getModelGatewayServices().provider.ensureProvider();
        return await getModelGatewayServices().budget.updateUserBudget(providerId, params.userId, body);
      } catch (err) {
        logError("[Model-Gateway] update user budget failed", err);
        return status(502, {
          error: {
            code: "MODEL_GATEWAY_ERROR",
            message: "Unable to update user budget",
          },
        });
      }
    },
    {
      systemApiKeyAuth: true,
      params: ModelGatewayUserIdParamsSchema,
      body: ModelGatewayBudgetBodySchema,
      response: {
        200: "model-gateway-budget-update",
        400: "model-gateway-api-error",
        401: "model-gateway-api-error",
        502: "model-gateway-api-error",
      },
      detail: {
        tags: ["System Model Gateway"],
        summary: "更新用户全局预算",
        description: "更新指定用户在当前系统 Gateway Provider 下的全局预算。",
      },
    },
  )
  .get(
    "/budgets",
    async ({ query, status }) => {
      try {
        const services = getModelGatewayServices();
        const providerId = await services.provider.ensureProvider();
        if (!query.budgetStatus) {
          const users = await services.subject.searchUsers(query);
          return {
            ...users,
            items: await services.budget.listUserBudgets(providerId, users.items),
          };
        }

        const users = await services.subject.findUsers(query);
        const items = await services.budget.listUserBudgets(providerId, users);
        const matchingItems = items.filter((item) => {
          if (query.budgetStatus === "pending") return !item.isActivated;
          if (query.budgetStatus === "active") return item.isActivated;
          return (
            item.isActivated && item.budget.maxBudgetUsd !== null && item.budget.spendUsd >= item.budget.maxBudgetUsd
          );
        });
        return {
          items: matchingItems.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
          total: matchingItems.length,
          page: query.page,
          pageSize: query.pageSize,
        };
      } catch (err) {
        logError("[Model-Gateway] list user budgets failed", err);
        return status(500, {
          error: {
            code: "MODEL_GATEWAY_ERROR",
            message: "Unable to list user budgets",
          },
        });
      }
    },
    {
      systemApiKeyAuth: true,
      query: ModelGatewayBudgetListQuerySchema,
      response: {
        200: "model-gateway-budget-list",
        401: "model-gateway-api-error",
        500: "model-gateway-api-error",
      },
      detail: {
        tags: ["System Model Gateway"],
        summary: "查询模型网关用户预算",
        description: "查询全局用户预算；组织条件只用于筛选用户，不改变预算作用域。",
      },
    },
  )
  .post(
    "/budgets/actions/bulk-update",
    async ({ body, status }) => {
      try {
        const providerId = await getModelGatewayServices().provider.ensureProvider();
        return await getModelGatewayServices().budget.bulkUpdateUserBudgets(providerId, body.userIds, body);
      } catch (err) {
        logError("[Model-Gateway] bulk update user budgets failed", err);
        return status(400, {
          error: {
            code: "MODEL_GATEWAY_ERROR",
            message: "Unable to update user budgets",
          },
        });
      }
    },
    {
      systemApiKeyAuth: true,
      body: ModelGatewayBulkBudgetBodySchema,
      response: {
        200: "model-gateway-bulk-budget-result",
        400: "model-gateway-api-error",
        401: "model-gateway-api-error",
      },
      detail: {
        tags: ["System Model Gateway"],
        summary: "批量更新模型网关用户预算",
        description: "批量更新最多 100 位用户的全局预算，响应分别列出成功和失败用户。",
      },
    },
  )
  .get(
    "/subjects/users",
    async ({ query, status }) => {
      try {
        const result = await getModelGatewayServices().subject.searchUsers(query);
        return { ...result, items: result.items.map(toUserResponse) };
      } catch (err) {
        logError("[Model-Gateway] list users failed", err);
        return status(500, {
          error: {
            code: "MODEL_GATEWAY_ERROR",
            message: "Unable to list users",
          },
        });
      }
    },
    {
      systemApiKeyAuth: true,
      query: ModelGatewaySubjectQuerySchema,
      response: {
        200: "model-gateway-user-list",
        401: "model-gateway-api-error",
        500: "model-gateway-api-error",
      },
      detail: {
        tags: ["System Model Gateway"],
        summary: "查询模型网关用户主体",
        description: "查询可用于预算和用量筛选的全局用户列表。",
      },
    },
  )
  .get(
    "/subjects/agents",
    async ({ query, status }) => {
      try {
        return await getModelGatewayServices().subject.searchAgents(query);
      } catch (err) {
        logError("[Model-Gateway] list agents failed", err);
        return status(500, {
          error: {
            code: "MODEL_GATEWAY_ERROR",
            message: "Unable to list agents",
          },
        });
      }
    },
    {
      systemApiKeyAuth: true,
      query: ModelGatewaySubjectQuerySchema,
      response: {
        200: "model-gateway-agent-subject-list",
        401: "model-gateway-api-error",
        500: "model-gateway-api-error",
      },
      detail: {
        tags: ["System Model Gateway"],
        summary: "查询模型网关 Agent 主体",
        description: "查询可用于模型网关用量筛选的 Agent 配置。",
      },
    },
  )
  .get(
    "/usage",
    async ({ query, status }) => {
      try {
        const providerId = await getModelGatewayServices().provider.ensureProvider();
        return await getModelGatewayServices().usage.queryUsage({
          gatewayProviderId: providerId,
          ...query,
        });
      } catch (err) {
        logError("[Model-Gateway] query usage failed", err);
        return status(400, {
          error: {
            code: "MODEL_GATEWAY_ERROR",
            message: "Unable to query model gateway usage",
          },
        });
      }
    },
    {
      systemApiKeyAuth: true,
      query: ModelGatewayUsageQuerySchema,
      response: {
        200: "model-gateway-usage",
        400: "model-gateway-api-error",
        401: "model-gateway-api-error",
      },
      detail: {
        tags: ["System Model Gateway"],
        summary: "查询模型网关用量",
        description:
          "按时间范围查询当前 Gateway Provider 的消耗，并支持用户、组织、Agent 和模型筛选。默认仅返回原始记录和轻量摘要；传 includeBreakdowns=true 时返回多维聚合。",
      },
    },
  );

export default app;
