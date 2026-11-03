import * as z from "zod/v4";
export const RunWorkflowParamsSchema = z.object({ id: z.string().uuid().describe("控制台里的工作流主键（UUID）。") });

export const RunWorkflowBodySchema = z
  .object({
    parameters: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .optional()
      .describe("工作流入参：可直接给 JSON 对象，或给它的 JSON 字符串（按原样透传给上游）。"),
    isAsync: z
      .boolean()
      .optional()
      .default(false)
      .describe("true 立即返回 executeId（异步运行，结果从上游调试页查看）；false 等待本次运行结束后返回 data。"),
    ext: z
      .object({ user_id: z.string().min(1).optional() })
      .optional()
      .describe("受控透传字段：user_id 作为上游的运行时用户标识，缺省时以上游平台账号身份运行。"),
  })
  .describe("触发工作流运行请求体。");

export const RunWorkflowResponseSchema = z
  .object({
    executeId: z.string().nullable().describe("执行 ID（同步与异步都返回）。"),
    data: z.string().nullable().describe("同步执行的输出（上游原样的 JSON 字符串）；异步或未命中时为 null。"),
    token: z.number().int().nullable().describe("本次消耗的 token 数。"),
    cost: z.string().nullable().describe("本次消耗（字符串形态）。"),
    debugUrl: z.string().nullable().describe("上游调试页地址。"),
  })
  .describe("工作流运行结果；字段缺失为 null，不省略键。");

/** 供 OpenAPI 展示认证方式；鉴权本身由注入的宿主守卫完成（声明为可选，未认证仍是 401）。 */
export const RunWorkflowHeadersSchema = z.object({
  authorization: z.string().optional().describe("Bearer 凭据：控制台 API Key（`rcs_*`），`Bearer <api_key>`。"),
});
