import { afterEach, expect, spyOn, test } from "bun:test";
import { AcpDispatcher, createAcpSessionState } from "acp-link/acp-dispatcher";
import { createAgentSession, createPromptTurn } from "../services/agent-chat-service";
import { releaseAgentSessionTurns } from "../services/agent-session-admission";
import { createInMemoryAgentRelay, deferred } from "./fixtures/in-memory-agent-relay";

afterEach(() => releaseAgentSessionTurns("relay-boundary"));

// 真实 turn、core 租约和 Dispatcher 串联后，重复取消只触达目标 SDK 一次，ack 不释放执行或影响邻居。
test("PromptTurn cancel crosses real leases and Dispatcher without mistaking its acknowledgement for termination", async () => {
  const resultA = deferred<{ stopReason: string }>();
  const resultB = deferred<{ stopReason: string }>();
  const cancelAck = deferred<void>();
  const finished = [0, 0];
  const calls: string[] = [];
  const state = createAcpSessionState();
  state.connection = {
    prompt: ({ sessionId }: { sessionId: string }) => (sessionId === "ses-a" ? resultA.promise : resultB.promise),
    async cancel({ sessionId }: { sessionId: string }) {
      calls.push(sessionId);
    },
  } as unknown as NonNullable<typeof state.connection>;
  // Explicit session IDs must work even when no connection-wide current session was assigned.
  const relay = await createInMemoryAgentRelay((message) => {
    void dispatcher.handleMessage(message);
  });
  const dispatcher = new AcpDispatcher(state, {
    send(message) {
      relay.emit(message);
      if ((message as { result?: { cancelled?: boolean } }).result?.cancelled) cancelAck.resolve();
    },
  });
  const turnA = createPromptTurn(
    createAgentSession({ instanceId: "relay-boundary", relayHandle: await relay.connect() }),
    "ses-a",
    undefined,
    () => {
      finished[0]++;
    },
  );
  const turnB = createPromptTurn(
    createAgentSession({ instanceId: "relay-boundary", relayHandle: await relay.connect() }),
    "ses-b",
    undefined,
    () => {
      finished[1]++;
    },
  );
  turnA.prompt([{ type: "text", text: "A" }]);
  turnB.prompt([{ type: "text", text: "B" }]);
  await Promise.all([turnA.cancel(), turnA.cancel()]);
  await cancelAck.promise;
  expect(calls).toEqual(["ses-a"]);
  expect(finished).toEqual([0, 0]);
  expect(relay.listeners.size).toBe(1);
  const requests = relay.sent as unknown as Array<{ id: number; method: string }>;
  expect(requests[2]!.id).not.toBe(requests[0]!.id);
  relay.emit({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: "ses-b",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "still running" } },
    },
  });
  expect(await turnB.events()[Symbol.asyncIterator]().next()).toMatchObject({ done: false });
  resultA.resolve({ stopReason: "cancelled" });
  await resultA.promise;
  await Promise.resolve();
  await Promise.resolve();
  expect(finished).toEqual([1, 0]);
  expect(relay.listeners.size).toBe(1);
  expect(relay.physical.state).toBe("open");
  resultB.resolve({ stopReason: "end_turn" });
  await resultB.promise;
  await Promise.resolve();
  await Promise.resolve();
  expect(finished).toEqual([1, 1]);
  await turnB.dispose();
  await relay.core.stopInstance("relay-boundary");
});

// 标准无 id 取消通知必须到达 SDK 而非回显；同 prompt 内的重复取消保持幂等。
test("Dispatcher consumes standard cancellation notifications without an echoed notification or fake prompt terminal", async () => {
  const result = deferred<{ stopReason: string }>();
  const state = createAcpSessionState();
  let cancels = 0;
  state.connection = {
    prompt: () => result.promise,
    async cancel() {
      cancels++;
    },
  } as unknown as NonNullable<typeof state.connection>;
  const responses: unknown[] = [];
  const dispatcher = new AcpDispatcher(state, {
    send: (message) => {
      responses.push(message);
    },
  });
  const prompt = dispatcher.handleMessage({
    jsonrpc: "2.0",
    id: 10,
    method: "session/prompt",
    params: { sessionId: "ses-notify", content: [] },
  });
  await Promise.all([
    dispatcher.handleMessage({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "ses-notify" } }),
    dispatcher.handleMessage({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "ses-notify" } }),
  ]);
  expect(cancels).toBe(1);
  expect(responses).toEqual([]);
  result.resolve({ stopReason: "cancelled" });
  await prompt;
  expect(responses).toEqual([{ jsonrpc: "2.0", id: 10, result: { stopReason: "cancelled" } }]);
});

// SDK 取消失败必须产生诊断及独立 error 回执，活动 prompt 仍等自己的确认终态。
test("SDK cancellation failure is diagnostic and does not fabricate a prompt terminal", async () => {
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = deferred<{ stopReason: string }>();
    const state = createAcpSessionState();
    state.connection = {
      prompt: () => result.promise,
      async cancel() {
        throw new Error("SDK cancel unavailable");
      },
    } as unknown as NonNullable<typeof state.connection>;
    const responses: unknown[] = [];
    const dispatcher = new AcpDispatcher(state, {
      send: (message) => {
        responses.push(message);
      },
    });
    const prompt = dispatcher.handleMessage({
      jsonrpc: "2.0",
      id: 20,
      method: "session/prompt",
      params: { sessionId: "ses-fail", content: [] },
    });
    await dispatcher.handleMessage({
      jsonrpc: "2.0",
      id: 21,
      method: "session/cancel",
      params: { sessionId: "ses-fail" },
    });
    expect(responses).toEqual([{ jsonrpc: "2.0", id: 21, error: { code: -32603, message: "Cancel failed" } }]);
    expect(diagnostic).toHaveBeenCalled();
    result.resolve({ stopReason: "end_turn" });
    await prompt;
    expect(responses).toHaveLength(2);
  } finally {
    diagnostic.mockRestore();
  }
});

// 用户信号和静默期限均必须通过真实 Dispatcher 取消 SDK，确认 prompt 结束前继续持有执行。
test("AbortSignal and deadline cancellation reach the SDK while preserving unknown execution admission", async () => {
  for (const mode of ["signal", "deadline"] as const) {
    const result = deferred<{ stopReason: string }>();
    const cancelled = deferred<void>();
    const acknowledged = deferred<void>();
    const state = createAcpSessionState();
    let calls = 0;
    let finished = 0;
    state.connection = {
      prompt: () => result.promise,
      async cancel() {
        calls++;
        cancelled.resolve();
      },
    } as unknown as NonNullable<typeof state.connection>;
    const relay = await createInMemoryAgentRelay((message) => {
      void dispatcher.handleMessage(message);
    });
    const dispatcher = new AcpDispatcher(state, {
      send(message) {
        relay.emit(message);
        if ((message as { result?: { cancelled?: boolean } }).result?.cancelled) acknowledged.resolve();
      },
    });
    const controller = new AbortController();
    const signal = mode === "signal" ? controller.signal : AbortSignal.timeout(10);
    const turn = createPromptTurn(
      createAgentSession({ instanceId: "relay-boundary", relayHandle: await relay.connect() }),
      `ses-${mode}`,
      signal,
      () => {
        finished++;
      },
    );
    turn.prompt([{ type: "text", text: "long execution" }]);
    const waiting = turn.events()[Symbol.asyncIterator]().next();
    if (mode === "signal") controller.abort();
    await cancelled.promise;
    await acknowledged.promise;
    expect(await waiting).toMatchObject({ done: true });
    await turn.cancel();
    expect(calls).toBe(1);
    expect(finished).toBe(0);
    expect(relay.listeners.size).toBe(1);
    result.resolve({ stopReason: "cancelled" });
    await result.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(1);
    expect(relay.listeners.size).toBe(0);
    await relay.core.stopInstance("relay-boundary");
  }
});

// 真实取消 error 回执只能记录交付失败，不能归还未知执行，也不能阻断其随后到达的 prompt 终态。
test("PromptTurn keeps its terminal observer after Dispatcher rejects the separate cancellation request", async () => {
  const diagnostic = spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = deferred<{ stopReason: string }>();
    const rejected = deferred<void>();
    const state = createAcpSessionState();
    let finished = 0;
    state.connection = {
      prompt: () => result.promise,
      async cancel() {
        throw new Error("SDK cancellation unavailable");
      },
    } as unknown as NonNullable<typeof state.connection>;
    const relay = await createInMemoryAgentRelay((message) => {
      void dispatcher.handleMessage(message);
    });
    const dispatcher = new AcpDispatcher(state, {
      send(message) {
        relay.emit(message);
        if ((message as { error?: unknown }).error) rejected.resolve();
      },
    });
    const turn = createPromptTurn(
      createAgentSession({ instanceId: "relay-boundary", relayHandle: await relay.connect() }),
      "ses-rejected",
      undefined,
      () => {
        finished++;
      },
    );
    turn.prompt([{ type: "text", text: "long task" }]);
    await turn.cancel();
    await rejected.promise;
    expect(finished).toBe(0);
    expect(relay.listeners.size).toBe(1);
    expect(diagnostic).toHaveBeenCalled();
    result.resolve({ stopReason: "end_turn" });
    await result.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(1);
    expect(relay.listeners.size).toBe(0);
    await relay.core.stopInstance("relay-boundary");
  } finally {
    diagnostic.mockRestore();
  }
});
