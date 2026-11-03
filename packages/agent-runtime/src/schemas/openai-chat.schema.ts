import * as z from "zod/v4";

/** v1 supports ordered plain-text history; unknown SDK parameters are rejected. */
export const OpenAIChatMessageSchema = z
  .object({ role: z.enum(["system", "developer", "user", "assistant"]), content: z.string() })
  .strict();
/** Frozen request contract, independent of console chat commands. */
export const OpenAIChatCompletionRequestSchema = z
  .object({
    model: z.string().uuid().describe("Agent 配置 ID，不是上游模型代码。"),
    messages: z.array(OpenAIChatMessageSchema).min(1),
    stream: z.boolean().default(false),
    n: z.literal(1).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    let history = false;
    for (const [index, message] of input.messages.entries()) {
      if (message.role === "system" || message.role === "developer") {
        if (history)
          ctx.addIssue({
            code: "custom",
            path: ["messages", index, "role"],
            message: "Instructions must precede conversation history",
          });
      } else history = true;
    }
    const last = input.messages.at(-1)!;
    if (last.role !== "user" || !last.content.trim())
      ctx.addIssue({ code: "custom", path: ["messages"], message: "Last message must be a non-empty user message" });
  });
/** Parsed supported Chat Completions request. */
export type OpenAIChatCompletionRequest = z.infer<typeof OpenAIChatCompletionRequestSchema>;
/** Only public assistant text crosses the OpenAI boundary. */
export const OpenAIChatMessageResponseSchema = z.object({ role: z.literal("assistant"), content: z.string() });
/** Standard finish reasons supported by this adapter. */
export const OpenAIChatChoiceSchema = z.object({
  index: z.number().int(),
  message: OpenAIChatMessageResponseSchema,
  finish_reason: z.enum(["stop", "length"]),
});
/** Native JSON response, without fabricated token usage. */
export const OpenAIChatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion"),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(OpenAIChatChoiceSchema),
});
/** Native JSON response type. */
export type OpenAIChatCompletionResponse = z.infer<typeof OpenAIChatCompletionResponseSchema>;
/** Native stream delta. */
export const OpenAIChatDeltaSchema = z.object({
  role: z.literal("assistant").optional(),
  content: z.string().optional(),
});
/** Native stream chunk. */
export const OpenAIChatStreamChunkSchema = z.object({
  id: z.string(),
  object: z.literal("chat.completion.chunk"),
  created: z.number().int(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number().int(),
      delta: OpenAIChatDeltaSchema,
      finish_reason: z.enum(["stop", "length"]).nullable(),
    }),
  ),
});
/** SDK-native error including a stable platform code. */
export const OpenAIErrorResponseSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    param: z.string().nullable().optional(),
    code: z.string().optional(),
  }),
});
/** Optional platform extensions use headers to keep JSON SDK compatible. */
export const OpenAIChatHeadersSchema = z
  .object({ "x-instance-id": z.string().startsWith("inst_").optional(), "x-session-id": z.string().optional() })
  .loose();
