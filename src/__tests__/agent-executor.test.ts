import { afterEach, describe, expect, test } from "bun:test";
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
});
