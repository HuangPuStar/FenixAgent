import { afterEach, expect, test } from "bun:test";
import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";
import { createAgentSession, createPromptTurn, startPromptTurn } from "../services/agent-chat-service";
import { releaseAgentSessionTurns } from "../services/agent-session-admission";
import { classifyAgentTurnEvent } from "../services/agent-turn-events";
import { mapToNonStreamingResponse, mapToSSEChunks, type RelayEvent } from "../services/openai-response-mapper";

afterEach(() => releaseAgentSessionTurns("instance"));

function relay() {
  const listeners = new Set<(message: EngineRelayMessage) => void>();
  const requests: Array<Record<string, unknown>> = [];
  const handle: EngineRelayHandle = {
    state: "open",
    send(message) {
      requests.push(message as unknown as Record<string, unknown>);
    },
    close() {},
    onMessage(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    handle,
    requests,
    listeners,
    emit(message: unknown) {
      for (const listener of listeners) listener(message as EngineRelayMessage);
    },
  };
}
async function collect(stream: AsyncIterable<string>) {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

// 只有收到明确成功终态才能成功，未知原因与传输失败在原始、包装消息中均保持失败语义。
test("terminal classification distinguishes explicit success, failure, cancellation and disconnect", () => {
  for (const wrapped of [false, true]) {
    for (const [reason, outcome] of [
      ["end_turn", "succeeded"],
      ["error", "failed"],
      ["cancelled", "cancelled"],
      ["novel", "unknown"],
    ] as const) {
      const rpc = { jsonrpc: "2.0", id: 3, result: { stopReason: reason } };
      expect(classifyAgentTurnEvent(wrapped ? { type: "event", payload: rpc } : rpc)?.outcome).toBe(outcome);
    }
  }
  expect(classifyAgentTurnEvent({ type: "relay_closed" })?.outcome).toBe("disconnected");
});

// 静默的 next 等待也必须被取消唤醒，不能依赖下一条网络消息到达。
test("SSE deadline wakes a silent pending iterator without emitting success", async () => {
  let returned = false;
  const silent: AsyncIterable<RelayEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<RelayEvent>>(() => {}),
        async return() {
          returned = true;
          return { done: true, value: undefined };
        },
      };
    },
  };
  await expect(collect(mapToSSEChunks(silent, "agent", AbortSignal.timeout(10)))).rejects.toMatchObject({
    name: "TimeoutError",
  });
  expect(returned).toBe(true);
});

// error、断连和缺少终态的 EOF 都不能被 SSE 或普通响应补为 end_turn。
test("API response adapters reject transport failure and unconfirmed EOF", async () => {
  for (const events of [[], [{ type: "error" }], [{ type: "relay_closed" }]]) {
    expect(() => mapToNonStreamingResponse(events, "agent")).toThrow();
    await expect(
      collect(
        mapToSSEChunks(
          {
            async *[Symbol.asyncIterator]() {
              yield* events;
            },
          },
          "agent",
        ),
      ),
    ).rejects.toThrow();
  }
});

// 缺失监听能力必须直接失败，而不是伪造会话并继续发送 prompt。
test("handshake without acknowledgement capability fails before sending session/new", async () => {
  let sent = 0;
  const session = createAgentSession({
    instanceId: "instance",
    relayHandle: {
      state: "open",
      send() {
        sent++;
      },
      close() {},
    },
  });
  await expect(startPromptTurn({ session })).rejects.toThrow("acknowledgements");
  expect(sent).toBe(0);
});

// 无回执和迟到回执均不能产生可发 prompt 的随机会话，超时后监听器必须移除。
test("session handshake timeout rejects and ignores a late acknowledgement", async () => {
  const transport = relay();
  const session = createAgentSession({ instanceId: "instance", relayHandle: transport.handle });
  await expect(startPromptTurn({ session, sessionId: "ses-existing", handshakeTimeoutMs: 10 })).rejects.toThrow(
    "unconfirmed",
  );
  expect(transport.listeners.size).toBe(0);
  transport.emit({ jsonrpc: "2.0", id: transport.requests[0].id, result: { sessionId: "ses-late" } });
  expect(transport.requests).toHaveLength(1);
});

// session/new 缺少 ID、RPC error 和 load 指向其他 ID 均要显式拒绝。
test("handshake validates session id and RPC rejection without generating fallback ids", async () => {
  for (const response of [{ result: {} }, { error: { message: "denied" } }, { result: { sessionId: "other" } }]) {
    const transport = relay();
    const session = createAgentSession({ instanceId: "instance", relayHandle: transport.handle });
    const pending = startPromptTurn({
      session,
      sessionId: "result" in response && response.result?.sessionId ? "ses-original" : undefined,
    });
    transport.emit({ jsonrpc: "2.0", id: transport.requests[0].id, ...response });
    await expect(pending).rejects.toThrow();
    expect(transport.listeners.size).toBe(0);
    expect(transport.requests).toHaveLength(1);
  }
});

// load 的明确成功回执允许不重复携带 ID，但仍然必须使用原请求 ID 匹配。
test("acknowledged session/load may reuse the requested session id", async () => {
  const transport = relay();
  const session = createAgentSession({ instanceId: "instance", relayHandle: transport.handle });
  const pending = startPromptTurn({ session, sessionId: "ses-original" });
  transport.emit({ jsonrpc: "2.0", id: transport.requests[0].id, result: {} });
  const { turn } = await pending;
  turn.prompt([{ type: "text", text: "run" }]);
  expect(transport.requests[1].params).toMatchObject({ sessionId: "ses-original" });
  transport.emit({ jsonrpc: "2.0", id: transport.requests[1].id, result: { stopReason: "end_turn" } });
  await turn.dispose();
});

// 已取消的操作不能发送 prompt；执行中取消要通知 Agent，并唤醒等待而不虚构已停止。
test("turn cancellation wakes consumers and retains admission until confirmed terminal", async () => {
  const transport = relay();
  const controller = new AbortController();
  let finished = 0;
  const session = createAgentSession({ instanceId: "instance", relayHandle: transport.handle });
  const turn = createPromptTurn(session, "ses-own", controller.signal, () => {
    finished++;
  });
  turn.prompt([{ type: "text", text: "run" }]);
  const waiting = turn.events()[Symbol.asyncIterator]().next();
  controller.abort();
  expect(await waiting).toMatchObject({ done: true });
  expect(transport.requests.map((request) => request.method)).toEqual(["session/prompt", "session/cancel"]);
  expect(finished).toBe(0);
  expect(transport.listeners.size).toBe(1);
  transport.emit({ jsonrpc: "2.0", id: transport.requests[0].id, result: { stopReason: "cancelled" } });
  expect(finished).toBe(1);
  expect(transport.listeners.size).toBe(0);
  expect(() => turn.prompt([])).toThrow();
});

// 消费迭代器先退出再 dispose 时，仍需向未确认完成的 Agent turn 发送取消。
test("disposing after consumer return still sends the turn cancellation", async () => {
  const transport = relay();
  const session = createAgentSession({ instanceId: "instance", relayHandle: transport.handle });
  const turn = createPromptTurn(session, "ses-own");
  turn.prompt([{ type: "text", text: "run" }]);
  const iterator = turn.events()[Symbol.asyncIterator]();
  await iterator.return?.();
  await turn.dispose();
  expect(transport.requests.map((request) => request.method)).toEqual(["session/prompt", "session/cancel"]);
  transport.emit({ type: "relay_closed" });
  expect(transport.listeners.size).toBe(0);
});

// 握手期间取消要结束等待并注销监听，不能在取消后生成 session 或继续发送 prompt。
test("cancellation during session handshake removes its listener and prevents a prompt", async () => {
  const transport = relay();
  const session = createAgentSession({ instanceId: "instance", relayHandle: transport.handle });
  const controller = new AbortController();
  const pending = startPromptTurn({ session, signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(transport.listeners.size).toBe(0);
  expect(transport.requests.map((request) => request.method)).toEqual(["session/new"]);
});

// 传输失败只说明消费失败，执行配额必须等 Agent 终态或 Coordinator 停止确认后释放。
test("transport error and disconnect never confirm the execution admission release", async () => {
  for (const type of ["error", "relay_closed"]) {
    const transport = relay();
    let finished = 0;
    const session = createAgentSession({ instanceId: "instance", relayHandle: transport.handle });
    const turn = createPromptTurn(session, "ses-own", undefined, () => {
      finished++;
    });
    turn.prompt([{ type: "text", text: "run" }]);
    transport.emit({ type });
    const iterator = turn.events()[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({ value: { type } });
    await turn.dispose();
    expect(finished).toBe(0);
    if (type === "error") {
      expect(transport.listeners.size).toBe(1);
      transport.emit({ jsonrpc: "2.0", id: transport.requests[0].id, result: { stopReason: "cancelled" } });
      expect(finished).toBe(1);
    }
    expect(transport.listeners.size).toBe(0);
  }
});
