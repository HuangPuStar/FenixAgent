import { expect, test } from "bun:test";
import { EXTERNAL_V1_OPERATIONS } from "../../apps/server/src/test-utils/external-v1-operations";
import type { AgentTestConfig } from "../lib/external-api-v1/config";
import { ManualRunner, object } from "../lib/external-api-v1/runner";
import { AGENT_OPERATIONS, runAgentScenario, validateAgentConfig } from "../lib/external-api-v1/scenario";

// Agent 独立覆盖资源、运行和三轮对话，不读取或调用两类工作流。
test("Agent 全流程独立运行", async () => {
  const saved = new Map<string, Record<string, unknown>>();
  const requests: { method: string; path: string; body: unknown }[] = [];
  const events: string[] = [];
  let openAiRound = 0;
  let openAiMarker = "";
  let acpRound = 0;
  let acpMarker = "";
  let wrappedPrompt = false;
  let instanceStatus = "running";
  let generation = 1;
  let paused = false;
  let fixtureError: unknown;
  const snapshot = () => ({
    instanceId: "inst_test",
    agentConfigId: "agent-test",
    environmentId: "env-test",
    status: instanceStatus,
    runtimeGeneration: generation,
  });
  const server = Bun.serve({
    port: 0,
    fetch: async (request, server) => {
      try {
        expect(request.headers.get("authorization")).toBe("Bearer test-key");
        const url = new URL(request.url);
        if (url.pathname === "/acp/relay/env-test") {
          expect(url.searchParams.get("instanceId")).toBe("inst_test");
          if (server.upgrade(request)) return;
          throw new Error("WebSocket upgrade failed");
        }
        expect(paused || requests.length === 0).toBe(true);
        paused = false;
        events.push("request");
        const path = url.pathname;
        const method = request.method;
        const multipart = request.headers.get("content-type")?.startsWith("multipart/form-data");
        const body =
          method === "GET" || method === "DELETE"
            ? undefined
            : multipart
              ? await request.formData()
              : await request.json();
        requests.push({ method, path, body });
        const ok = (data: unknown, status = 200) => Response.json({ success: true, data }, { status });
        if (path === "/api/v1/chat/completions") {
          openAiRound++;
          const input = object(body);
          expect(input.model).toBe("agent-test");
          expect(request.headers.get("X-Instance-Id")).toBe("inst_test");
          const messages = input.messages as { role: string; content: string }[];
          expect(messages).toHaveLength(1);
          expect(messages[0].role).toBe("user");
          if (openAiRound === 1) {
            expect(request.headers.get("X-Session-Id")).toBeNull();
            openAiMarker = messages[0].content.match(/OPENAI_[\w-]+/)![0];
          } else {
            expect(request.headers.get("X-Session-Id")).toBe("opaque-session");
            expect(messages[0].content).not.toContain(openAiMarker);
          }
          const headers = {
            "X-Session-Id": "opaque-session",
            "X-Instance-Id": "inst_test",
            "X-Request-Id": `request-${openAiRound}`,
            "X-Session-Expires-At": new Date(Date.now() + 60_000).toISOString(),
          };
          const text = openAiRound === 1 ? "已记住" : openAiMarker;
          if (input.stream)
            return new Response(
              [
                { choices: [{ delta: { role: "assistant" }, finish_reason: null }] },
                { choices: [{ delta: { content: text }, finish_reason: null }] },
                { choices: [{ delta: {}, finish_reason: "stop" }] },
              ]
                .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
                .join("") + "data: [DONE]\n\n",
              { headers: { ...headers, "content-type": "text/event-stream" } },
            );
          return Response.json(
            { choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] },
            { headers },
          );
        }
        if (path.endsWith("/instances/connect"))
          return ok({ ...snapshot(), relay: { wsUrl: "/acp/relay/env-test?instanceId=inst_test" } });
        if (path === "/api/v1/instances/inst_test/restart") {
          generation++;
          instanceStatus = "running";
          return ok(snapshot());
        }
        if (path === "/api/v1/instances/inst_test/stop") {
          instanceStatus = "stopped";
          return ok(null);
        }
        if (path === "/api/v1/instances/inst_test") return ok(snapshot());
        if (path.endsWith("/workspace/files")) {
          const form = body as FormData;
          const names = JSON.parse(String(form.get("relativePaths"))) as string[];
          const files = form.getAll("files") as File[];
          expect(new Uint8Array(await files[1].arrayBuffer())).toEqual(new Uint8Array([0, 128, 255]));
          return ok({
            environmentId: "env-test",
            files: files.map((file, i) => ({
              name: file.name,
              path: `${form.get("path")}/${names[i]}`,
              size: file.size,
            })),
          });
        }
        if (method === "GET" && url.searchParams.has("page")) {
          let items: unknown[];
          if (path.endsWith("/knowledge-bases")) items = [{ id: "existing-kb" }];
          else if (path.endsWith("/instances")) items = [snapshot()];
          else
            items = [...saved.entries()]
              .filter(([key]) => key.slice(0, key.lastIndexOf("/")) === path)
              .map(([, value]) => value);
          return ok({ items, total: items.length, page: 1, pageSize: 100 });
        }
        if (method === "POST") {
          let input: Record<string, unknown>;
          if (path.endsWith("/skills")) {
            const form = body as FormData;
            const files = form.getAll("files") as File[];
            const manifest = JSON.parse(String(form.get("manifest")));
            expect(manifest).toHaveLength(2);
            expect(manifest[1].relativePath).toBe("assets/probe.bin");
            expect(new Uint8Array(await files[1].arrayBuffer())).toEqual(new Uint8Array([0, 1, 128, 255]));
            input = { content: await files[0].text(), metadata: {} };
          } else input = object(body);
          const type = path.endsWith("/models") ? "model" : path.split("/").at(-1)!.replace(/s$/, "");
          const id = `${type}-test`;
          const value = { ...input, id, kind: "direct", apiKey: undefined, enabled: true };
          saved.set(`${path}/${id}`, value);
          return ok(value, 201);
        }
        const previous = saved.get(path);
        expect(previous).toBeDefined();
        if (method === "GET") return ok(previous);
        if (method === "PATCH") {
          const input = object(body);
          const updated = { ...previous, ...input, ...(input.config ? { enabled: object(input.config).enabled } : {}) };
          saved.set(path, updated);
          return ok(updated);
        }
        if (method === "DELETE") {
          saved.delete(path);
          return ok(null);
        }
        throw new Error(`Unhandled ${method} ${path}`);
      } catch (error) {
        fixtureError = error;
        return Response.json({ error: String(error) }, { status: 500 });
      }
    },
    websocket: {
      message: (ws, raw) => {
        try {
          const envelope = JSON.parse(String(raw));
          const rpc = envelope.jsonrpc ? envelope : envelope.payload;
          const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
          if (rpc.method === "session/new") {
            expect(rpc.params.cwd).toBeUndefined();
            reply({ sessionId: "ses_test" });
            return;
          }
          expect(rpc.method).toBe("session/prompt");
          expect(rpc.params.sessionId).toBe("ses_test");
          acpRound++;
          const text = rpc.params.content[0].text;
          if (acpRound === 1) acpMarker = text.match(/ACP_[\w-]+/)[0];
          else expect(text).not.toContain(acpMarker);
          if (envelope.payload) wrappedPrompt = true;
          ws.send(
            JSON.stringify({
              type: "acp",
              payload: {
                jsonrpc: "2.0",
                method: "session/update",
                params: {
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: acpRound === 1 ? "已记住" : acpMarker },
                  },
                },
              },
            }),
          );
          reply({ stopReason: "end_turn" });
        } catch (error) {
          fixtureError = error;
          ws.close();
        }
      },
    },
  });
  const config: AgentTestConfig = {
    baseUrl: server.url.origin,
    apiKey: "test-key",
    timeoutMs: 2000,
    provider: { protocol: "openai", baseUrl: "http://model.local/v1", apiKey: "upstream-key" },
    upstreamModel: "model",
    runtimeModelId: "",
    knowledgeBaseId: "existing-kb",
    mcpConfig: { type: "streamable-http", url: "http://mcp.local/mcp" },
    agentNode: {},
    acpPermission: "deny",
  };
  const output: string[] = [];
  const runner = new ManualRunner(config, {
    write: (line) => output.push(line),
    pause: async () => {
      events.push("pause");
      paused = true;
    },
  });
  try {
    validateAgentConfig(config);
    const resources: Record<string, string> = {};
    await runAgentScenario(config, runner, resources);
    if (fixtureError) throw fixtureError;
    const expected = EXTERNAL_V1_OPERATIONS.filter((operation) => !operation.includes("/workflows/"));
    expect([...runner.operations].sort()).toEqual(expected);
    expect(AGENT_OPERATIONS).toEqual(expected);
    expect(output.some((line) => line.includes("跳过"))).toBe(false);
    expect(openAiRound).toBe(3);
    expect(acpRound).toBe(3);
    expect(wrappedPrompt).toBe(true);
    expect(saved.size).toBe(0);
    expect(resources.uploadPath).toStartWith("user/api-test-");
    const deletions = requests.filter((r) => r.method === "DELETE");
    expect(deletions).toHaveLength(5);
    expect(deletions.every((r) => r.path.endsWith("-test"))).toBe(true);
    expect(events.filter((e) => e === "pause")).toHaveLength(requests.length + 5);
  } finally {
    server.stop(true);
  }
}, 10_000);

// 缺少必填环境信息时，不能先创建资源再半途发现无法覆盖全部接口。
test("缺失配置在发请求前明确报错", () => {
  expect(() => validateAgentConfig({ apiKey: "EDIT_API_KEY" } as AgentTestConfig)).toThrow("AGENT_CONFIG.apiKey");
});
