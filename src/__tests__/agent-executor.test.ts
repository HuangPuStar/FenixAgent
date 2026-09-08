import { afterEach, describe, expect, test, vi } from "bun:test";
import type { OpenAgentSessionResult } from "../services/agent-chat-service";
import { agentExecutor, setAgentExecutorDeps } from "../services/scheduler/agent-executor";

function makeOpenSessionResult(): OpenAgentSessionResult {
  return {
    instanceId: "inst-1",
    turn: {
      prompt: () => {},
      events: async function* () {
        yield { jsonrpc: "2.0", result: { stopReason: "end_turn" } };
      },
      dispose: async () => {},
    } as never,
  };
}

describe("agent executor", () => {
  afterEach(() => {
    setAgentExecutorDeps(null);
    vi.useRealTimers();
  });

  // cron 触发的任务执行应映射为 scheduled 来源
  test("maps cron trigger to scheduled source", async () => {
    const calls: unknown[] = [];
    setAgentExecutorDeps({
      openAgentSession: async (input) => {
        calls.push(input);
        return makeOpenSessionResult();
      },
    });

    await agentExecutor.execute({
      triggeredBy: "cron",
      task: {
        id: "task-1",
        agentId: "agc-1",
        userId: "user-1",
        organizationId: "org-1",
        definition: { prompt: "hello" },
        timeoutSeconds: 1,
      } as never,
    });

    expect(calls[0]).toMatchObject({ startSource: "scheduled" });
  });

  // 手动触发的任务执行也应映射为 scheduled 来源
  test("maps manual trigger to scheduled source", async () => {
    const calls: unknown[] = [];
    setAgentExecutorDeps({
      openAgentSession: async (input) => {
        calls.push(input);
        return makeOpenSessionResult();
      },
    });

    await agentExecutor.execute({
      triggeredBy: "manual",
      task: {
        id: "task-2",
        agentId: "agc-2",
        userId: "user-1",
        organizationId: "org-1",
        definition: { prompt: "hello again" },
        timeoutSeconds: 1,
      } as never,
    });

    expect(calls[0]).toMatchObject({ startSource: "scheduled" });
  });

  // 超时必须释放单轮实例，并等待竞争失败的事件迭代器完成 finally 清理
  test("timeout disposes one-shot turn and settles event iteration", async () => {
    vi.useFakeTimers();
    let signalStarted: () => void = () => {};
    let releaseIterator: () => void = () => {};
    let signalCompleted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseIterator = resolve;
    });
    const completed = new Promise<void>((resolve) => {
      signalCompleted = resolve;
    });
    let disposeCalls = 0;
    let iteratorCompleted = false;

    setAgentExecutorDeps({
      openAgentSession: async () => ({
        instanceId: "inst-timeout",
        turn: {
          prompt: () => {},
          events: async function* () {
            try {
              signalStarted();
              await release;
              yield { jsonrpc: "2.0", result: { stopReason: "end_turn" } };
            } finally {
              iteratorCompleted = true;
              signalCompleted();
            }
          },
          dispose: async () => {
            disposeCalls++;
            releaseIterator();
          },
        } as never,
      }),
    });

    const execution = agentExecutor.execute({
      triggeredBy: "cron",
      task: {
        id: "task-timeout",
        agentId: "agc-timeout",
        userId: "user-1",
        organizationId: "org-1",
        definition: { prompt: "wait" },
        timeoutSeconds: 1,
      } as never,
    });
    await started;
    vi.advanceTimersByTime(1_000);

    const result = await execution;
    await completed;

    expect(result.status).toBe("timeout");
    expect(result.error).toBe("Agent execution timeout");
    expect(disposeCalls).toBe(1);
    expect(iteratorCompleted).toBe(true);
  });
});
