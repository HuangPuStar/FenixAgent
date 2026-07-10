import * as z from "zod/v4";
import { WebOkSchema } from "./common.schema";

// ── Definition 子 schema ──

const HttpDefinitionSchema = z.object({
  url: z.string().min(1),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
});

const AgentDefinitionSchema = z.object({
  prompt: z.string().min(1),
});

const DefinitionSchema = z.union([HttpDefinitionSchema, AgentDefinitionSchema]);

// ── TaskInfo ──

export const TaskV2InfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  cron: z.string(),
  timezone: z.string().nullable(),
  enabled: z.boolean(),
  timeoutSeconds: z.number(),
  type: z.string(),
  agentId: z.string().nullable(),
  definition: z.unknown(),
  lastRunAt: z.number().nullable(),
  nextRunAt: z.number().nullable(),
  lastStatus: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

// ── 创建/更新请求 ──

export const CreateTaskV2RequestSchema = z.object({
  name: z.string().min(1).max(128).describe("任务名称"),
  description: z.string().optional().describe("任务描述"),
  cron: z.string().min(1).describe("cron 表达式"),
  timezone: z.string().nullable().optional().describe("可选时区"),
  timeoutSeconds: z.number().int().min(1).optional().describe("超时秒数，默认 300"),
  type: z.enum(["http", "agent"]).describe("任务类型"),
  agentId: z.string().nullable().optional().describe("Agent ID（仅 agent 类型）"),
  definition: DefinitionSchema.describe("任务定义"),
});

export const UpdateTaskV2RequestSchema = z.object({
  name: z.string().min(1).max(128).optional().describe("任务名称"),
  description: z.string().nullable().optional().describe("任务描述"),
  cron: z.string().min(1).optional().describe("cron 表达式"),
  timezone: z.string().nullable().optional().describe("可选时区"),
  timeoutSeconds: z.number().int().min(1).optional().describe("超时秒数"),
  type: z.enum(["http", "agent"]).optional().describe("任务类型（不可修改）"),
  agentId: z.string().nullable().optional().describe("Agent ID"),
  definition: DefinitionSchema.optional().describe("任务定义"),
  enabled: z.boolean().optional().describe("启用状态"),
});

// ── 执行日志 ──

export const ExecutionLogV2InfoSchema = z.object({
  id: z.string().describe("日志 ID"),
  taskId: z.string().describe("任务 ID"),
  status: z.string().describe("执行状态"),
  error: z.string().nullable().describe("错误信息"),
  duration: z.number().nullable().describe("执行耗时 ms"),
  triggeredBy: z.string().describe("触发来源"),
  skipReason: z.string().nullable().describe("跳过原因"),
  resultSummary: z.string().nullable().describe("结果摘要"),
  createdAt: z.number().describe("创建时间戳"),
});

// ── 响应 ──

export const TaskV2ResponseSchema = WebOkSchema(TaskV2InfoSchema.describe("任务详情"));
export const TaskV2ListResponseSchema = WebOkSchema(TaskV2InfoSchema.array().describe("任务列表"));

export const TriggerV2ResponseSchema = WebOkSchema(
  z.object({
    status: z.string().describe("执行状态"),
    duration: z.number().describe("耗时 ms"),
    error: z.string().optional().describe("错误信息"),
    resultSummary: z.string().optional().describe("结果摘要"),
  }),
);

export const ToggleV2ResponseSchema = WebOkSchema(
  z.object({ id: z.string().describe("任务 ID"), enabled: z.boolean().describe("切换后状态") }),
);

export const DeleteV2ResponseSchema = WebOkSchema(z.null());
export const ClearLogsV2ResponseSchema = WebOkSchema(z.null());

export const TaskV2LogsResponseSchema = WebOkSchema(
  z.object({
    total: z.number().describe("日志总数"),
    items: ExecutionLogV2InfoSchema.array().describe("当前页日志"),
  }),
);

export type TaskV2Info = z.infer<typeof TaskV2InfoSchema>;
export type CreateTaskV2Request = z.infer<typeof CreateTaskV2RequestSchema>;
export type UpdateTaskV2Request = z.infer<typeof UpdateTaskV2RequestSchema>;
