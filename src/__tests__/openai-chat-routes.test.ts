import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentNodeUnavailableError } from "@fenix/orchestration";
import Elysia from "elysia";
import { AppError, NotFoundError } from "../errors";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { errorPlugin } from "../plugins/error-handler";
import type { OpenAgentSessionResult } from "../services/agent-chat-service";
import { setTestOrgContext } from "../services/org-context";

const openaiChatModule = await import("../routes/api/openai-chat");
const openaiChatRoute = openaiChatModule.default;
const { setOpenAIChatRouteDeps } = openaiChatModule;

function request(path: string, init?: RequestInit) {
  return openaiChatRoute.handle(new Request(`http://localhost${path}`, init));
}

// 挂载 errorPlugin 的完整 app：模拟生产装配（src/index.ts 中 errorPlugin 先于
// openaiChatRoutes）。rethrow 的 AppError / OrchestrationError 只有经过 errorPlugin
// 才能映射出 503/409/429 等稳定状态码（本地 handle 无 onError，错误会落成 500）。
const appWithErrorPlugin = new Elysia().use(errorPlugin).use(openaiChatRoute);

function requestWithErrorPlugin(path: string, init?: RequestInit) {
  return appWithErrorPlugin.handle(new Request(`http://localhost${path}`, init));
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

  // stream=true 应返回 text/event-stream，事件流结束（收到 stopReason）后流正常关闭。
  // 历史版本因 Elysia handle() 消费 ReadableStream 导致挂起而跳过，当前事件流立即结束可安全断言。
  test("stream=true 返回 text/event-stream Content-Type", async () => {
    setOpenAIChatRouteDeps({
      openAgentSession: async () => ({
        instanceId: "inst-stream",
        turn: {
          prompt: () => {},
          events: async function* () {
            yield { jsonrpc: "2.0", result: { stopReason: "end_turn" } };
          },
          dispose: async () => {},
        } as never,
      }),
    });

    const res = await request("/api/agents/123e4567-e89b-12d3-a456-426614174000/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data: [DONE]");
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

describe("OpenAI Chat Routes — 错误映射（errorPlugin 装配）", () => {
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

  function post(body: unknown) {
    return requestWithErrorPlugin("/api/agents/123e4567-e89b-12d3-a456-426614174000/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // 断连节点 spawn（A-P1.2 验收点 3）：openAgentSession 抛 AgentNodeUnavailableError
  // 必须返回 503 AGENT_NODE_UNAVAILABLE，而非 500 或泄漏内部 message
  test("openAgentSession 抛 AgentNodeUnavailableError 返回 503", async () => {
    setOpenAIChatRouteDeps({
      openAgentSession: async () => {
        throw new AgentNodeUnavailableError();
      },
    });

    const res = await post({ messages: [{ role: "user", content: "hello" }] });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.type).toBe("AGENT_NODE_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toContain("machineId");
  });

  // 并发超限语义修正：OrchestrationError 由本地 catch 的 500 修正为 409，
  // 且 message 必须脱敏 —— agent-controller 实际抛出时拼接 envId（A-P1.1 泄漏点），
  // 响应体不得出现内部资源标识

  // A-P1.1 收敛后本地嗅探已移除：非 UUID agentConfigId 由 agent-chat-service 抛
  // NotFoundError（稳定 code NOT_FOUND），经 errorPlugin 映射 404，与旧嗅探语义一致
  test("openAgentSession 抛 NotFoundError 返回 404", async () => {
    setOpenAIChatRouteDeps({
      openAgentSession: async () => {
        throw new NotFoundError("Agent config not found: invalid agentConfigId format");
      },
    });

    const res = await post({ messages: [{ role: "user", content: "hello" }] });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.type).toBe("NOT_FOUND");
  });

  // A-P1.1：移除本地嗅探后，普通 Error（非 AppError/OrchestrationError）不再
  // 由路由拼接 500 原文，统一走 errorPlugin 兜底（500 INTERNAL_ERROR + 通用文案），
  // 不得泄漏 machineId 等内部标识
  test("openAgentSession 抛普通 Error 返回 500 且 message 脱敏", async () => {
    setOpenAIChatRouteDeps({
      openAgentSession: async () => {
        throw new Error("Core node is offline: machine-42");
      },
    });

    const res = await post({ messages: [{ role: "user", content: "hello" }] });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.type).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("machine-42");
  });

  // 429 用户并发（AppError 子类）原样透传状态码：用户级并发限制应保持 429 语义
  test("openAgentSession 抛 429 AppError 原样透传", async () => {
    setOpenAIChatRouteDeps({
      openAgentSession: async () => {
        throw new AppError("User agent concurrency limit exceeded", "USER_CONCURRENCY_EXCEEDED", 429);
      },
    });

    const res = await post({ messages: [{ role: "user", content: "hello" }] });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.type).toBe("USER_CONCURRENCY_EXCEEDED");
  });

  // A-P1.1：SSE 流已开始后无法走 errorPlugin，迭代中途抛错时错误 chunk 只输出
  // 通用文案（原始 message 可能携带 envId），完整诊断入服务端日志
  test("SSE 流迭代抛错时输出脱敏 error chunk", async () => {
    setOpenAIChatRouteDeps({
      openAgentSession: async () => ({
        instanceId: "inst-stream-error",
        turn: {
          prompt: () => {},
          events: async function* () {
            // 先 yield 普通 update 事件（stopReason 会让 mapToSSEChunks 提前 break），
            // 再抛错以触发流迭代中断
            yield {
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } },
              },
            };
            throw new Error("session/update boom env_x");
          },
          dispose: async () => {},
        } as never,
      }),
    });

    const res = await requestWithErrorPlugin("/api/agents/123e4567-e89b-12d3-a456-426614174000/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hello" }] }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"message":"Agent execution failed"');
    expect(text).not.toContain("env_x");
    expect(text).not.toContain("boom");
  });
});
