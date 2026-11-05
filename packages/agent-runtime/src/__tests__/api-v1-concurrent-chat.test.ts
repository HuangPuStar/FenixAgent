import { afterEach, expect, test } from "bun:test";
import { extractJsonRpc } from "@fenix/chat-channel";
import { createOpenaiChatRoutes, setOpenAIChatRouteDeps } from "../routes/api/openai-chat";
import { createAgentSession, startPromptTurn } from "../services/agent-prompt-turn";
import { releaseAgentSessionTurns } from "../services/agent-session-admission";
import { apiChatSessions } from "../services/api-chat-session-registry";
import { createInMemoryAgentRelay, deferred } from "./fixtures/in-memory-agent-relay";
import { createStubAgentRuntimeAuthGuardPlugin, resetTestAuth, setTestAuth } from "./guard-stubs";

const agent = "123e4567-e89b-12d3-a456-426614174000";
afterEach(() => {
  setOpenAIChatRouteDeps(null);
  resetTestAuth();
  for (const id of ["inst_a", "inst_b"]) {
    apiChatSessions.invalidateInstance(id);
    releaseAgentSessionTurns(id);
  }
});

// 屏障保证四个 turn 已同时进入 prompt，再交错广播回复；不能靠顺序 stub 证明并发。
test("two instances with two sessions each route interleaved JSON/SSE and continuation correctly", async () => {
  setTestAuth({ organizationId: "org", userId: "user" });
  type Pending = { instanceId: string; sessionId: string; id: unknown; label: string };
  const pending: Pending[] = [];
  let gate = deferred<void>();
  let expected = 4;
  const relays = new Map<string, Awaited<ReturnType<typeof createInMemoryAgentRelay>>>();
  for (const instanceId of ["inst_a", "inst_b"]) {
    let sequence = 0;
    const relay = await createInMemoryAgentRelay((message) => {
      const rpc = extractJsonRpc(message);
      if (!rpc) return;
      if (rpc.method === "session/new" || rpc.method === "session/load") {
        const sessionId = (rpc.params as { sessionId?: string })?.sessionId ?? `${instanceId}_session_${++sequence}`;
        relays.get(instanceId)!.emit({ jsonrpc: "2.0", id: rpc.id, result: { sessionId } });
      }
      if (rpc.method === "session/prompt") {
        const params = rpc.params as { sessionId: string; content: Array<{ text: string }> };
        pending.push({ instanceId, sessionId: params.sessionId, id: rpc.id, label: params.content[0].text });
        if (pending.length === expected) gate.resolve();
      }
    });
    relays.set(instanceId, relay);
  }
  setOpenAIChatRouteDeps({
    openAgentSession: async (input) => {
      const instanceId = input.instanceId!;
      input.onResolved?.({
        organizationId: "org",
        userId: "user",
        agentConfigId: agent,
        environmentId: "env",
        instanceId,
        runtimeGeneration: 1,
      });
      const session = createAgentSession({ relayHandle: await relays.get(instanceId)!.connect(), instanceId });
      return {
        instanceId,
        turn: (await startPromptTurn({ session, sessionId: input.sessionId, signal: input.signal })).turn,
      };
    },
  });
  const app = createOpenaiChatRoutes({ authGuardPlugin: createStubAgentRuntimeAuthGuardPlugin() });
  const send = (instanceId: string, label: string, stream: boolean, handle?: string) =>
    app.handle(
      new Request("http://localhost/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-instance-id": instanceId,
          ...(handle ? { "x-session-id": handle } : {}),
        },
        body: JSON.stringify({ model: agent, messages: [{ role: "user", content: label }], stream }),
      }),
    );
  const finish = () => {
    for (const suffix of ["-first", "-last"]) {
      for (const call of [...pending].reverse())
        relays.get(call.instanceId)!.emit({
          type: "message",
          payload: {
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: call.sessionId,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: call.label + suffix } },
            },
          },
        });
    }
    for (const call of pending)
      relays.get(call.instanceId)!.emit({ jsonrpc: "2.0", id: call.id, result: { stopReason: "end_turn" } });
  };
  const requests = [
    send("inst_a", "a1", false),
    send("inst_a", "a2", true),
    send("inst_b", "b1", true),
    send("inst_b", "b2", false),
  ];
  await gate.promise;
  expect(new Set(pending.map((p) => p.sessionId)).size).toBe(4);
  finish();
  const responses = await Promise.all(requests);
  for (const [index, response] of responses.entries()) {
    expect(response.status).toBe(200);
    expect(response.headers.get("x-session-id")).toStartWith("fcs_");
    const text = await response.text();
    const label = ["a1", "a2", "b1", "b2"][index];
    expect(text).toContain(label + "-first");
    expect(text).toContain(label + "-last");
    // 随机 completion ID 可能包含短标签前缀，只检查实际发送的完整输出片段。
    for (const other of ["a1", "a2", "b1", "b2"].filter((s) => s !== label)) {
      expect(text).not.toContain(`${other}-first`);
      expect(text).not.toContain(`${other}-last`);
    }
  }
  pending.length = 0;
  expected = 2;
  gate = deferred<void>();
  const next = [
    send("inst_a", "continued-a1", false, responses[0].headers.get("x-session-id")!),
    send("inst_a", "continued-a2", false, responses[1].headers.get("x-session-id")!),
  ];
  await gate.promise;
  finish();
  for (const response of await Promise.all(next)) expect(response.status).toBe(200);
  for (const relay of relays.values()) await relay.physical.close();
});

for (const failure of ["cancel", "rpc-error", "stop", "timeout"] as const) {
  // 四路在同一屏障执行，单会话失败或实例停止不能取消另一实例，收口后监听器与会话锁恢复。
  test(`concurrent ${failure} isolates sessions and releases relay consumers`, async () => {
    setTestAuth({ organizationId: "org", userId: "user" });
    const pending: Array<{ instanceId: string; sessionId: string; id: unknown }> = [];
    const gate = deferred<void>();
    const relays = new Map<string, Awaited<ReturnType<typeof createInMemoryAgentRelay>>>();
    const abort = new AbortController();
    const handles: string[] = [];
    for (const instanceId of ["inst_a", "inst_b"]) {
      let sequence = 0;
      relays.set(
        instanceId,
        await createInMemoryAgentRelay((message) => {
          const rpc = extractJsonRpc(message);
          if (!rpc) return;
          const relay = relays.get(instanceId)!;
          if (rpc.method === "session/new" || rpc.method === "session/load") {
            const sessionId = (rpc.params as { sessionId?: string })?.sessionId ?? `${instanceId}_${++sequence}`;
            relay.emit({ jsonrpc: "2.0", id: rpc.id, result: { sessionId } });
          }
          if (rpc.method === "session/prompt") {
            pending.push({ instanceId, sessionId: (rpc.params as { sessionId: string }).sessionId, id: rpc.id });
            if (pending.length === 4) gate.resolve();
          }
          if (rpc.method === "session/cancel") {
            const call = pending.find((entry) => entry.sessionId === (rpc.params as { sessionId: string }).sessionId);
            if (call) relay.emit({ jsonrpc: "2.0", id: call.id, result: { stopReason: "cancelled" } });
          }
        }),
      );
    }
    setOpenAIChatRouteDeps({
      openAgentSession: async (input) => {
        const instanceId = input.instanceId!;
        const lifecycle = input.onResolved?.({
          organizationId: "org",
          userId: "user",
          agentConfigId: agent,
          environmentId: "env",
          instanceId,
          runtimeGeneration: 1,
        });
        const session = createAgentSession({ relayHandle: await relays.get(instanceId)!.connect(), instanceId });
        const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), ...(lifecycle ? [lifecycle] : [])]);
        const { turn } = await startPromptTurn({ session, sessionId: input.sessionId, signal });
        return { instanceId, turn };
      },
    });
    const app = createOpenaiChatRoutes({ authGuardPlugin: createStubAgentRuntimeAuthGuardPlugin() });
    const requests = ["inst_a", "inst_a", "inst_b", "inst_b"].map((instanceId, index) =>
      app.handle(
        new Request("http://localhost/api/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", "x-instance-id": instanceId },
          signal: index === 0 ? abort.signal : undefined,
          body: JSON.stringify({
            model: agent,
            messages: [{ role: "user", content: `request-${index}` }],
            stream: true,
          }),
        }),
      ),
    );
    await gate.promise;
    const responses = await Promise.all(requests);
    const bodies = responses.map((response) => {
      handles.push(response.headers.get("x-session-id")!);
      return response.text();
    });
    const first = pending[0];
    if (failure === "stop") apiChatSessions.invalidateInstance("inst_a");
    else if (failure === "rpc-error")
      relays.get("inst_a")!.emit({ jsonrpc: "2.0", id: first.id, error: { code: -32000, message: "failure" } });
    else abort.abort(new DOMException("request ended", failure === "timeout" ? "TimeoutError" : "AbortError"));
    for (const [index, call] of pending.entries()) {
      if (index === 0 || (failure === "stop" && call.instanceId === "inst_a")) continue;
      const relay = relays.get(call.instanceId)!;
      relay.emit({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: call.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `survivor-${index}` } },
        },
      });
      relay.emit({ jsonrpc: "2.0", id: call.id, result: { stopReason: "end_turn" } });
    }
    const results = await Promise.all(bodies);
    expect(results[2]).toContain("survivor-2");
    expect(results[3]).toContain("survivor-3");
    expect(results[0]).not.toContain("survivor-");
    expect(() =>
      apiChatSessions.acquire(handles[0], { organizationId: "org", userId: "user", agentConfigId: agent }),
    ).toThrow("Session unavailable");
    for (const handle of handles.slice(2)) {
      const lease = apiChatSessions.acquire(handle, { organizationId: "org", userId: "user", agentConfigId: agent });
      apiChatSessions.release(lease, true);
    }
    for (const relay of relays.values()) {
      expect(relay.listeners.size).toBe(0);
      expect(relay.physical.state).toBe("open");
      await relay.physical.close();
    }
  });
}
