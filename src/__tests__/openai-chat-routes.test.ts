import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";

const openaiChatRoute = (await import("../routes/api/openai-chat")).default;

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
    resetTestAuth();
    setTestOrgContext(null);
  });

  // 缺少 user 消息时返回 400
  test("缺少 user 消息时返回 400 错误", async () => {
    const res = await request("/v1/agents/agc-test/chat/completions", {
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
});
