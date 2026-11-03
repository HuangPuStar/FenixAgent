import { afterEach, expect, test } from "bun:test";
import Elysia from "elysia";
import OpenAI from "openai";
import { createOpenaiChatRoutes, setOpenAIChatRouteDeps } from "../routes/api/openai-chat";
import { OpenAIChatCompletionRequestSchema } from "../schemas/openai-chat.schema";
import { createStubAgentRuntimeAuthGuardPlugin, resetTestAuth, setTestAuth } from "./guard-stubs";

const agentId = "123e4567-e89b-12d3-a456-426614174000";
afterEach(() => {
  setOpenAIChatRouteDeps(null);
  resetTestAuth();
});

// 支持范围之外的输入不能被忽略后照常运行。
test("v1 chat rejects unsupported parameters and invalid history", () => {
  const base = { model: agentId, messages: [{ role: "user", content: "hello" }] };
  for (const bad of [
    { ...base, temperature: 0 },
    { ...base, n: 2 },
    { ...base, tools: [] },
    {
      ...base,
      messages: [
        { role: "user", content: "hi" },
        { role: "system", content: "late" },
        { role: "user", content: "end" },
      ],
    },
    { ...base, messages: [{ role: "assistant", content: "end" }] },
    { ...base, messages: [{ role: "user", content: " " }] },
  ])
    expect(OpenAIChatCompletionRequestSchema.safeParse(bad).success).toBe(false);
});

// 真实 SDK 通过 HTTP 消费 JSON 与 SSE，验证完整历史及公开文本投影。
test("OpenAI SDK consumes v1 JSON and SSE with full history", async () => {
  setTestAuth({ organizationId: "org", userId: "user" });
  const prompts: string[] = [];
  setOpenAIChatRouteDeps({
    openAgentSession: async (input) => {
      input.onResolved?.({
        organizationId: input.organizationId,
        userId: input.userId,
        agentConfigId: input.agentConfigId,
        environmentId: "env-sdk",
        instanceId: "inst_sdk",
        runtimeGeneration: 1,
      });
      return {
        instanceId: "inst_sdk",
        turn: {
          sessionId: crypto.randomUUID(),
          prompt: (content) => {
            prompts.push(content.map((c) => c.text).join(""));
          },
          async *events() {
            for (const [kind, text] of [
              ["agent_thought_chunk", "private-thought"],
              ["tool_call", "tool-secret"],
              ["agent_message_chunk", "public-answer"],
            ])
              yield {
                type: "message",
                payload: {
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: { update: { sessionUpdate: kind, content: { type: "text", text } } },
                },
              };
            yield { type: "message", payload: { jsonrpc: "2.0", result: { stopReason: "end_turn" } } };
          },
          cancel: async () => {},
          release: () => {},
          dispose: async () => {},
        },
      };
    },
  });
  const app = new Elysia()
    .use(createOpenaiChatRoutes({ authGuardPlugin: createStubAgentRuntimeAuthGuardPlugin() }))
    .listen(0);
  try {
    const client = new OpenAI({
      apiKey: "fixture",
      baseURL: `http://localhost:${app.server!.port}/api/v1`,
      maxRetries: 0,
    });
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "developer", content: "instruction" },
      { role: "user", content: "old-question" },
      { role: "assistant", content: "old-answer" },
      { role: "user", content: "new-question" },
    ];
    const result = await client.chat.completions.create({ model: agentId, messages });
    expect(result.choices[0].message).toEqual({ role: "assistant", content: "public-answer" });
    expect(result.choices[0].finish_reason).toBe("stop");
    expect(result.usage).toBeUndefined();
    const chunks = [];
    for await (const chunk of await client.chat.completions.create({ model: agentId, messages, stream: true }))
      chunks.push(chunk);
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks.map((c) => c.choices[0].delta.content ?? "").join("")).toBe("public-answer");
    expect(chunks.at(-1)!.choices[0].finish_reason).toBe("stop");
    for (const prompt of prompts)
      for (const text of ["instruction", "old-question", "old-answer", "new-question"]) expect(prompt).toContain(text);
  } finally {
    await app.stop();
  }
});
