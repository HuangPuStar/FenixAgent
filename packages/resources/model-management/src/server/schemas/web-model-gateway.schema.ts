import * as z from "zod/v4";
import { ModelGatewayUsageResponseSchema } from "./api-model-gateway.schema";

export const WebModelGatewayUsageQuerySchema = z.object({
  startAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("统计开始日期，YYYY-MM-DD 格式，包含当日。"),
  endAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .describe("统计结束日期，YYYY-MM-DD 格式，包含当日。"),
  organizationId: z.string().optional().describe("可选组织筛选；必须属于当前用户。"),
  agentConfigId: z.string().optional().describe("可选 Agent 筛选；必须属于当前用户可访问范围。"),
  modelId: z.string().optional().describe("可选模型筛选。"),
});

export const WebModelGatewayUsageParamsSchema = z.object({
  providerId: z.string().describe("Gateway Provider ID。"),
});

export const WebModelGatewayUsageResponseSchema = ModelGatewayUsageResponseSchema.extend({
  gatewayProvider: z
    .object({
      id: z.string(),
      name: z.string(),
      displayName: z.string(),
    })
    .describe("请求路径指定的 Gateway Provider 标识与名称。"),
  budget: z
    .object({
      maxBudgetUsd: z.number().nullable(),
      duration: z.string().nullable(),
      spendUsd: z.number(),
      resetAt: z.string().nullable(),
    })
    .nullable()
    .describe("当前用户在系统 Gateway Provider 的预算；尚未创建网关账户时为空。"),
});

export const WebModelGatewayErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
});
