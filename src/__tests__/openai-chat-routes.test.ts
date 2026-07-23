import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import type { OpenAgentSessionResult } from "../services/agent-chat-service";
import { setTestOrgContext } from "../services/org-context";

const openaiChatModule = await import("../routes/api/openai-chat");
const openaiChatRoute = openaiChatModule.default;
const { setOpenAIChatRouteDeps } = openaiChatModule;

function request(path: string, init?: RequestInit) {
  return openaiChatRoute.handle(new Request(`http://localhost${path}`, init));
}

describe("OpenAI Chat Routes", () => {
  beforeEach(() => {
    setTestAuth({
      user: { id: "test-user", email: "test@test.com", name: "Test" },
      authContext: { organizationId: "test-org", userId: "test-user", role: "owner" },
    });
    setTestOrgContext({ organizationId: "test-org", userId: "test-user", role: "owner" });
  });

  afterEach(() => {
    setOpenAIChatRouteDeps(null);
    resetTestAuth();
    setTestOrgContext(null);
  });

  // 缺少 user 消息时返回 400
  test("缺少 user 消息时返回 400 错误", async () => {
    const res = await request("/api/agents/agc-test/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "system", content: "You are a helpful assistant." }],
      }),
    });
    expect(res.status).toBe(400);
  });

  // stream=true 返回 text/event-stream（跳过 — Elysia handle() blocks on ReadableStream）
  test.skip("stream=true 返回 text/event-stream Content-Type", async () => {
    // 实际 stream 行为通过 bash test-openai-chat.sh 手动验证
  });

  // OpenAI 兼容入口启动实例时应显式标记为 interactive
  test("转发 interactive startSource 到 openAgentSession", async () => {
    const calls: unknown[] = [];
    setOpenAIChatRouteDeps({
      openAgentSession: async (input) => {
        calls.push(input);
        return {
          instanceId: "inst-1",
          turn: {
            prompt: () => {},
            events: async function* () {
              yield { jsonrpc: "2.0", result: { stopReason: "end_turn" } };
            },
            dispose: async () => {},
          } as never,
        } satisfies OpenAgentSessionResult;
      },
    });

    const res = await request("/api/agents/123e4567-e89b-12d3-a456-426614174000/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ startSource: "interactive" });
  });
});
