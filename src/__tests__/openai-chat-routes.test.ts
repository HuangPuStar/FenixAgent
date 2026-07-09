import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setAgentChatServiceDeps } from "../services/agent-chat-service";
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
    setAgentChatServiceDeps(null);
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

  // Agent 不存在时返回 404
  test("Agent 不存在时返回 404 错误", async () => {
    setAgentChatServiceDeps({
      getReadableAgentConfigById: async () => null,
    } as any);

    const res = await request("/v1/agents/not-exist/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    expect(res.status).toBe(404);
  });

  // stream 请求返回 text/event-stream
  // NOTE: Elysia handle() blocks on ReadableStream, skip in unit test, use bash script for streaming validation.
  test.skip("stream=true 返回 text/event-stream Content-Type", async () => {
    setAgentChatServiceDeps({
      getReadableAgentConfigById: async () => ({ id: "agc-test", name: "test" }),
      createWebEnvironment: async () => ({
        id: "env-test",
        name: "test",
        agentConfigId: "agc-test",
        userId: "test-user",
        organizationId: "test-org",
        secret: "s",
        status: "idle",
        description: null,
        autoStart: true,
        maxSessions: 1,
        workspacePath: "/ws",
        machineName: null,
        workerType: "acp",
        branch: null,
        gitRepoUrl: null,
        capabilities: null,
        lastPollAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      groupActiveInstancesByEnvironment: () => new Map(),
      getRunningInstancesByEnvironment: () => [],
      listEnvironmentsByOrganizationId: async () => [],
      spawnInstanceFromEnvironment: async () => ({
        id: "inst-test",
        userId: "test-user",
        port: 12345,
        pid: null,
        status: "running" as const,
        command: "test",
        error: null,
        apiKey: "k",
        createdAt: new Date(),
        instanceNumber: 1,
      }),
      getCoreRuntime: () =>
        ({
          launchInstance: async () => {},
          connectInstanceRelay: async () =>
            ({
              state: "open" as const,
              send: (_msg: any) => {
                // _msg is raw JSON-RPC
                const method = _msg?.method as string | undefined;
                if (method === "session/new" || method === "session/load") {
                  setTimeout(() => {
                    handler({
                      type: "session_data",
                      payload: { jsonrpc: "2.0", id: -1, result: { id: "ses_test123" } },
                    });
                  }, 5);
                } else if (method === "session/prompt") {
                  setTimeout(() => {
                    handler({ type: "session_data", payload: { jsonrpc: "2.0", result: { stopReason: "end_turn" } } });
                  }, 10);
                }
              },
              close: async () => {},
              onMessage: (h: any) => {
                handler = h;
                return () => {};
              },
              ready: Promise.resolve(),
            }) as any,
          stopInstance: async () => {},
          listInstances: () => [],
          registerPlugin: () => ({}),
          registerNode: () => ({}),
          getInstance: () => null,
          getNode: () => null,
          getPlugin: () => null,
          listNodes: () => [],
          listPlugins: () => [],
          updateNodeStatus: () => ({}),
          deleteInstance: () => false,
          updateInstanceMetadata: () => ({}) as any,
        }) as any,
    } as any);

    let handler: (msg: any) => void = () => {};

    const res = await request("/v1/agents/agc-test/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      }),
    });

    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  });

  // 非流式请求成功
  test("POST /v1/agents/:agentId/chat/completions 非流式成功返回 200", async () => {
    setAgentChatServiceDeps({
      getReadableAgentConfigById: async () => ({ id: "agc-test", name: "test" }),
      createWebEnvironment: async () => ({
        id: "env-test",
        name: "test",
        agentConfigId: "agc-test",
        userId: "test-user",
        organizationId: "test-org",
        secret: "s",
        status: "idle",
        description: null,
        autoStart: true,
        maxSessions: 1,
        workspacePath: "/ws",
        machineName: null,
        workerType: "acp",
        branch: null,
        gitRepoUrl: null,
        capabilities: null,
        lastPollAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      groupActiveInstancesByEnvironment: () => new Map(),
      getRunningInstancesByEnvironment: () => [],
      listEnvironmentsByOrganizationId: async () => [],
      spawnInstanceFromEnvironment: async () => ({
        id: "inst-test",
        userId: "test-user",
        port: 12345,
        pid: null,
        status: "running" as const,
        command: "test",
        error: null,
        apiKey: "k",
        createdAt: new Date(),
        instanceNumber: 1,
      }),
      getCoreRuntime: () =>
        ({
          launchInstance: async () => {},
          connectInstanceRelay: async () =>
            ({
              state: "open" as const,
              send: (_msg: any) => {
                // _msg is raw JSON-RPC (method field is directly on the object)
                const method = _msg?.method as string | undefined;
                if (method === "session/new" || method === "session/load") {
                  setTimeout(() => {
                    handler({
                      type: "session_data",
                      payload: { jsonrpc: "2.0", id: -1, result: { id: "ses_test123" } },
                    });
                  }, 5);
                } else if (method === "session/prompt") {
                  setTimeout(() => {
                    handler({
                      type: "session_data",
                      payload: {
                        jsonrpc: "2.0",
                        method: "session/update",
                        params: {
                          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello!" } },
                        },
                      },
                    });
                    handler({ type: "session_data", payload: { jsonrpc: "2.0", result: { stopReason: "end_turn" } } });
                  }, 10);
                }
              },
              close: async () => {},
              onMessage: (h: any) => {
                handler = h;
                return () => {};
              },
              ready: Promise.resolve(),
            }) as any,
          stopInstance: async () => {},
          listInstances: () => [],
          registerPlugin: () => ({}),
          registerNode: () => ({}),
          getInstance: () => null,
          getNode: () => null,
          getPlugin: () => null,
          listNodes: () => [],
          listPlugins: () => [],
          updateNodeStatus: () => ({}),
          deleteInstance: () => false,
          updateInstanceMetadata: () => ({}) as any,
        }) as any,
    } as any);

    let handler: (msg: any) => void = () => {};

    const res = await request("/v1/agents/agc-test/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.role).toBe("assistant");
  });
});
