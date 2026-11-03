import { afterEach, expect, test } from "bun:test";
import Elysia from "elysia";
import { createOpenaiChatRoutes, setOpenAIChatRouteDeps } from "../routes/api/openai-chat";
import type { OpenAgentSessionResult } from "../services/agent-chat-service";
import { apiChatSessions } from "../services/api-chat-session-registry";
import { errorPluginStub } from "./error-plugin-stub";
import { createStubAgentRuntimeAuthGuardPlugin, resetTestAuth, setTestAuth } from "./guard-stubs";

const agent = "123e4567-e89b-12d3-a456-426614174000";
afterEach(() => {
  setOpenAIChatRouteDeps(null);
  resetTestAuth();
  apiChatSessions.invalidateInstance("inst_life");
});
// 下游停止读取后，实例停止仍必须独立于 stream pull 释放本次请求。
test("instance invalidation disposes a backpressured stream without another pull", async () => {
  setTestAuth({ organizationId: "org", userId: "user" });
  let disposed = false;
  setOpenAIChatRouteDeps({
    openAgentSession: async (input) => {
      input.onResolved?.({
        organizationId: "org",
        userId: "user",
        agentConfigId: agent,
        environmentId: "env",
        instanceId: "inst_life",
        runtimeGeneration: 1,
      });
      return {
        instanceId: "inst_life",
        turn: {
          sessionId: "ses_private",
          prompt: () => {},
          events: async function* () {
            while (true)
              yield {
                type: "message",
                payload: {
                  jsonrpc: "2.0",
                  method: "session/update",
                  params: {
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "x".repeat(32768) },
                    },
                  },
                },
              };
          },
          dispose: async () => {
            disposed = true;
          },
        },
      } as unknown as OpenAgentSessionResult;
    },
  });
  const app = new Elysia()
    .use(errorPluginStub)
    .use(createOpenaiChatRoutes({ authGuardPlugin: createStubAgentRuntimeAuthGuardPlugin() }));
  const response = await app.handle(
    new Request("http://localhost/api/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: agent, messages: [{ role: "user", content: "hi" }], stream: true }),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  apiChatSessions.invalidateInstance("inst_life");
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(disposed).toBe(true);
  await response.body?.cancel();
});
