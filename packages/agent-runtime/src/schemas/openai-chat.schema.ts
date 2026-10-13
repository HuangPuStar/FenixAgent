import * as z from "zod/v4";

// ── 请求 ──

export const OpenAIChatMessageSchema = z
  .object({
    role: z.enum(["user", "assistant", "system", "tool"]).describe("消息角色。"),
    content: z.union([z.string(), z.null()]).describe("消息内容。"),
    name: z.string().optional().describe("可选发送者名称。"),
  })
  .describe("OpenAI Chat 消息。");

export const OpenAIChatCompletionRequestSchema = z
  .object({
    messages: z.array(OpenAIChatMessageSchema).describe("对话消息数组。"),
    model: z.string().optional().describe("模型标识符（忽略，Agent 由 URL 指定）。"),
    stream: z.boolean().optional().default(false).describe("是否流式返回。"),
    temperature: z.number().optional().describe("温度参数（忽略）。"),
    max_tokens: z.number().int().optional().describe("最大 token 数（忽略）。"),
    top_p: z.number().optional().describe("top_p 参数（忽略）。"),
    tools: z.array(z.unknown()).optional().describe("工具定义（忽略）。"),
  })
  .describe("OpenAI Chat Completion 请求体。");

export type OpenAIChatCompletionRequest = z.infer<typeof OpenAIChatCompletionRequestSchema>;

// ── 非流式响应 ──

export const OpenAIChatMessageResponseSchema = z
  .object({
    role: z.literal("assistant").describe("消息角色。"),
    content: z.string().describe("最终 AI 回复内容，含简化 tool_call/tool_result XML。"),
    reasoning_content: z.string().optional().describe("DeepSeek 兼容：agent_thought_chunk + plan 中间过程。"),
  })
  .describe("OpenAI Chat 响应消息。");

export const OpenAIChatChoiceSchema = z
  .object({
    index: z.number().int().describe("选项序号。"),
    message: OpenAIChatMessageResponseSchema.describe("助手消息。"),
    finish_reason: z.string().describe("结束原因：end_turn / max_tokens / error 等。"),
  })
  .describe("Chat Completion 选项。");

export const OpenAIChatUsageSchema = z
  .object({
    prompt_tokens: z.number().int().default(0).describe("提示词 token 数。"),
    completion_tokens: z.number().int().default(0).describe("补全 token 数。"),
    total_tokens: z.number().int().default(0).describe("总 token 数。"),
  })
  .describe("Token 用量统计（首版填 0）。");

export const OpenAIChatCompletionResponseSchema = z
  .object({
    id: z.string().describe("响应唯一 ID（chatcmpl-xxx）。"),
    object: z.literal("chat.completion").describe("对象类型。"),
    created: z.number().int().describe("Unix 时间戳。"),
    model: z.string().describe("Agent ID（与 URL 中一致）。"),
    choices: z.array(OpenAIChatChoiceSchema).describe("回复选项列表。"),
    usage: OpenAIChatUsageSchema.optional().describe("Token 用量。"),
  })
  .describe("OpenAI Chat Completion 非流式响应体。");

export type OpenAIChatCompletionResponse = z.infer<typeof OpenAIChatCompletionResponseSchema>;

// ── 流式 SSE chunk ──

export const OpenAIChatDeltaSchema = z
  .object({
    content: z.string().optional().describe("增量内容块。"),
    reasoning_content: z.string().optional().describe("增量推理内容块（DeepSeek 兼容）。"),
  })
  .describe("流式增量。");

export const OpenAIChatStreamChoiceSchema = z
  .object({
    index: z.number().int().describe("选项序号。"),
    delta: OpenAIChatDeltaSchema.describe("增量内容。"),
    finish_reason: z.string().nullable().optional().describe("结束原因，仅最后一个 chunk 携带。"),
  })
  .describe("流式增量选项。");

export const OpenAIChatStreamChunkSchema = z
  .object({
    id: z.string().describe("响应唯一 ID。"),
    object: z.literal("chat.completion.chunk").describe("对象类型。"),
    created: z.number().int().describe("Unix 时间戳。"),
    model: z.string().describe("Agent ID。"),
    choices: z.array(OpenAIChatStreamChoiceSchema).describe("增量选项列表。"),
  })
  .describe("OpenAI Chat Completion 流式 SSE chunk。");

// ── 错误 ──

export const OpenAIErrorResponseSchema = z
  .object({
    error: z.object({
      message: z.string().describe("错误描述。"),
      type: z.string().describe("错误类型：invalid_request_error / authentication_error / server_error / timeout。"),
      code: z.string().optional().describe("可选错误码。"),
    }),
  })
  .describe("OpenAI 兼容的错误响应体。");
