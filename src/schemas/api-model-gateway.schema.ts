import * as z from "zod/v4";
import { ApiSystemErrorResponseSchema, ApiSystemUserListResponseSchema } from "./api-system.schema";

const UsageDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期必须为 YYYY-MM-DD 格式。");

export const ModelGatewayBudgetBodySchema = z.object({
  maxBudgetUsd: z.number().nonnegative().nullable().describe("预算金额；为空表示不限制。"),
  duration: z.string().nullable().describe("预算周期；为空表示一次性预算。"),
});

export const ModelGatewayBulkBudgetBodySchema = ModelGatewayBudgetBodySchema.extend({
  userIds: z.array(z.string().min(1)).max(100),
});

export const ModelGatewayBulkBudgetResetBodySchema = z.object({
  userIds: z.array(z.string().min(1)).min(1).max(100),
});

export const ModelGatewayUsageQuerySchema = z.object({
  startAt: UsageDateSchema.describe("统计开始日期，YYYY-MM-DD 格式，包含当日。"),
  endAt: UsageDateSchema.describe("统计结束日期，YYYY-MM-DD 格式，包含当日。"),
  userId: z.string().optional(),
  organizationId: z.string().optional(),
  agentConfigId: z.string().optional(),
  modelId: z.string().optional(),
  includeBreakdowns: z.stringbool().optional().describe("是否返回按模型、组织、用户和 Agent 的聚合明细；默认不返回。"),
});

export const ModelGatewaySubjectQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  keyword: z.string().optional(),
  organizationId: z.string().optional(),
  userId: z.string().optional(),
  budgetStatus: z.enum(["pending", "active", "exhausted"]).optional(),
});

export const ModelGatewayBudgetListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  organizationId: z.string().optional(),
  userId: z.string().optional(),
  budgetStatus: z.enum(["pending", "active", "exhausted"]).optional(),
});

export const ModelGatewayProviderQuerySchema = z.object({
  providerId: z.string().min(1).optional().describe("Gateway Provider ID；不传时使用系统 Gateway Provider。"),
});

const ModelGatewayProviderSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  gatewayType: z.string(),
  baseUrl: z.string().nullable(),
  modelCount: z.number().int().nonnegative(),
  owner: z.object({ email: z.string(), organizationSlug: z.string() }),
});

export const ModelGatewayConfigurationSchema = z.object({
  provider: ModelGatewayProviderSummarySchema.nullable(),
  adminUiUrl: z.string().url().nullable(),
  defaultBudget: z.object({
    maxBudgetUsd: z.number().nonnegative().nullable(),
    duration: z.string().nullable(),
  }),
});

export const ModelGatewayUserIdParamsSchema = z.object({
  userId: z.string().min(1).describe("Fenix 用户 ID。"),
});

const ModelGatewaySyncChangeSchema = z.object({
  modelId: z.string().describe("模型 ID。"),
  kind: z.enum(["added", "updated", "removed"]).describe("模型变化类型。"),
  displayName: z.string().optional().describe("模型显示名称。"),
});

export const ModelGatewayModelSyncStatusSchema = z.object({
  status: z.enum(["synced", "pending", "unknown"]).describe("模型投影同步状态。"),
  changes: ModelGatewaySyncChangeSchema.array().describe("模型差异列表。"),
  models: z
    .object({
      id: z.string(),
      displayName: z.string().optional(),
      provider: z.string().optional(),
    })
    .array()
    .optional()
    .describe("网关当前模型目录；检查失败时不返回。"),
  providerBaseUrlChanged: z.boolean().optional().describe("Gateway Provider 公开地址是否待同步。"),
  error: z.string().optional().describe("检查失败时的错误说明。"),
});

export const ModelGatewayModelSyncResultSchema = z.object({
  added: z.number().int().nonnegative().describe("新增模型数量。"),
  updated: z.number().int().nonnegative().describe("更新模型数量。"),
  removed: z.number().int().nonnegative().describe("移除模型数量。"),
});

const ModelGatewayBudgetSchema = z.object({
  maxBudgetUsd: z.number().nullable().describe("预算金额；为空表示不限制。"),
  duration: z.string().nullable().describe("预算周期；为空表示一次性预算。"),
  spendUsd: z.number().describe("已消耗金额。"),
  resetAt: z.string().nullable().describe("下次重置时间。"),
});

const ModelGatewayBudgetItemSchema = z.object({
  id: z.string().describe("Fenix 用户 ID。"),
  name: z.string().describe("用户名称。"),
  email: z.string().describe("用户邮箱。"),
  budget: ModelGatewayBudgetSchema.describe("用户在当前 Gateway Provider 下的全局预算。"),
  source: z.enum(["litellm", "default"]).describe("预算来源。"),
  isActivated: z.boolean().describe("是否已在 LiteLLM 创建 Internal User 并生效预算。"),
});

export const ModelGatewayBudgetListResponseSchema = z.object({
  items: ModelGatewayBudgetItemSchema.array().describe("用户预算列表。"),
  total: z.number().int().nonnegative().describe("用户总数。"),
  page: z.number().int().positive().describe("当前页码。"),
  pageSize: z.number().int().positive().describe("当前分页大小。"),
});

export const ModelGatewayUserListResponseSchema = ApiSystemUserListResponseSchema;

export const ModelGatewayBudgetUpdateResponseSchema = z.object({
  userId: z.string().describe("Fenix 用户 ID。"),
  status: z.enum(["updated", "failed"]).describe("预算更新状态。"),
  budget: ModelGatewayBudgetSchema.optional().describe("更新后的预算。"),
});

export const ModelGatewayBulkBudgetResponseSchema = z.object({
  succeeded: z
    .object({
      userId: z.string().describe("Fenix 用户 ID。"),
      status: z.literal("updated"),
    })
    .array()
    .describe("更新成功的用户。"),
  failed: z
    .object({
      userId: z.string().describe("Fenix 用户 ID。"),
      status: z.literal("failed"),
      error: z.string().optional(),
    })
    .array()
    .describe("更新失败的用户及原因。"),
});

export const ModelGatewayAgentSubjectSchema = z.object({
  id: z.string().describe("Agent 配置 ID。"),
  name: z.string().describe("Agent 名称。"),
  organizationId: z.string().describe("所属组织 ID。"),
  userId: z.string().describe("Agent 属主用户 ID。"),
});

const ModelGatewayUsageModelSchema = z.object({
  modelId: z.string().describe("模型 ID。"),
  spendUsd: z.number().describe("消耗金额。"),
  requests: z.number().describe("请求数。"),
  promptTokens: z.number().describe("输入 Token 数。"),
  completionTokens: z.number().describe("输出 Token 数。"),
});

export const ModelGatewayUsageResponseSchema = z.object({
  totalSpendUsd: z.number().describe("总消耗金额。"),
  records: z.array(z.unknown()).describe("网关原始聚合记录。"),
  activeUserCount: z.number().int().nonnegative().describe("查询范围内有用量的 Fenix 用户数。"),
  byModel: ModelGatewayUsageModelSchema.array().optional().describe("按模型聚合；仅 includeBreakdowns=true 时返回。"),
  byOrganization: z
    .object({
      organizationId: z.string(),
      organizationName: z.string().nullable(),
      spendUsd: z.number(),
      requests: z.number(),
    })
    .array()
    .optional()
    .describe("按组织聚合；仅 includeBreakdowns=true 时返回。"),
  byUser: z
    .object({
      userId: z.string(),
      userName: z.string().nullable(),
      userEmail: z.string().nullable(),
      spendUsd: z.number(),
      requests: z.number(),
    })
    .array()
    .optional()
    .describe("按用户聚合；仅 includeBreakdowns=true 时返回。"),
  byAgent: z
    .object({
      agentConfigId: z.string(),
      organizationName: z.string().nullable(),
      agentName: z.string().nullable(),
      spendUsd: z.number(),
      requests: z.number(),
    })
    .array()
    .optional()
    .describe("按 Agent 聚合；仅 includeBreakdowns=true 时返回。"),
});

export const ModelGatewayApiErrorResponseSchema = ApiSystemErrorResponseSchema;
