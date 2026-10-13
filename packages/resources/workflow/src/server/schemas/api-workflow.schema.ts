import * as z from "zod/v4";

// ── 鉴权头 ──

/**
 * 外部 Workflow API 的 Bearer 鉴权请求头。
 *
 * 该 schema 仅用于 OpenAPI 展示与基础校验，实际鉴权逻辑仍由 authGuardPlugin 统一处理。
 */
export const ApiWorkflowAuthorizationHeadersSchema = z
  .object({
    authorization: z.string().min(1).describe("Bearer token，请使用 `Authorization: Bearer <api_key>`。"),
  })
  .describe("外部 Workflow API 鉴权请求头。");

export type ApiWorkflowAuthorizationHeaders = z.infer<typeof ApiWorkflowAuthorizationHeadersSchema>;

// ── 执行模式 ──

/** 执行模式 */
export const ApiWorkflowExecuteModeSchema = z
  .enum(["sync", "async"])
  .describe("执行模式：sync 等待完成返回结果，async 立即返回 runId。")
  .default("sync");

// ── 请求体 ──

/** 执行工作流请求体 */
export const ApiWorkflowExecuteRequestBodySchema = z
  .object({
    inputs: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("工作流 params 的实际值，key 对应 YAML 中 params 定义的字段。"),
    mode: ApiWorkflowExecuteModeSchema,
    version: z.number().int().positive().optional().describe("指定执行的工作流版本号，不传则使用 latestVersion。"),
    timeout: z
      .number()
      .int()
      .positive()
      .max(3600)
      .optional()
      .default(300)
      .describe("同步模式最大等待秒数，超限后返回 TIMEOUT 状态，工作流继续后台运行。"),
  })
  .describe("执行工作流请求体。");

export type ApiWorkflowExecuteRequestBody = z.infer<typeof ApiWorkflowExecuteRequestBodySchema>;

// ── 路径参数 ──

export const ApiWorkflowIdParamsSchema = z
  .object({
    workflowId: z.string().describe("工作流标识，UUID 格式。"),
  })
  .describe("工作流执行路径参数。");

// ── 同步模式成功响应（有 end 节点） ──

export const ApiWorkflowExecuteSuccessWithOutputSchema = z
  .object({
    runId: z.string().describe("运行记录唯一标识。"),
    status: z.literal("SUCCESS"),
    version: z.number().int().describe("本次实际执行的工作流版本号。"),
    output: z.record(z.string(), z.unknown()).describe("end 节点收集的最终输出数据。"),
    duration: z.number().describe("执行耗时，单位秒。"),
  })
  .describe("同步执行成功（含 output 字段）。");

// ── 同步模式成功响应（无 end 节点） ──

export const ApiWorkflowExecuteSuccessNoOutputSchema = z
  .object({
    runId: z.string().describe("运行记录唯一标识。"),
    status: z.literal("SUCCESS"),
    version: z.number().int().describe("本次实际执行的工作流版本号。"),
    duration: z.number().describe("执行耗时，单位秒。"),
  })
  .describe("同步执行成功（无 end 节点，不返回 output）。");

// ── 同步模式失败响应 ──

export const ApiWorkflowExecuteFailedSchema = z
  .object({
    runId: z.string().describe("运行记录唯一标识。"),
    status: z.literal("FAILED"),
    version: z.number().int().describe("本次实际执行的工作流版本号。"),
    error: z.object({
      nodeId: z.string().optional().describe("失败节点 ID。"),
      message: z.string().describe("失败原因描述。"),
    }),
    duration: z.number().describe("执行耗时，单位秒。"),
  })
  .describe("同步执行失败。");

// ── 同步模式超时响应 ──

export const ApiWorkflowExecuteTimeoutSchema = z
  .object({
    runId: z.string().describe("运行记录唯一标识。"),
    status: z.literal("TIMEOUT"),
    version: z.number().int().describe("本次实际执行的工作流版本号。"),
    duration: z.number().describe("已等待时长，单位秒。"),
  })
  .describe("同步等待超时，工作流继续后台运行。");

// ── 异步模式响应 ──

export const ApiWorkflowExecuteAsyncSchema = z
  .object({
    runId: z.string().describe("运行记录唯一标识。"),
    version: z.number().int().describe("本次实际执行的工作流版本号。"),
  })
  .describe("异步模式响应，返回 runId 和实际执行版本号。");
