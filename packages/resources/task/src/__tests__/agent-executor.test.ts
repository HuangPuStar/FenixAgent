import { afterEach, describe, expect, test } from "bun:test";
import type { OpenAgentSessionResult } from "@fenix/agent-runtime/runtime";
import { agentExecutor, setAgentExecutorDeps } from "../server/services/scheduler/agent-executor";
import type { TaskExecInput } from "../server/services/scheduler/types";

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

function terminalInput(timeoutSeconds = 1): TaskExecInput {
  return {
    triggeredBy: "cron",
    task: {
      id: "task-terminal",
      agentId: "agent",
      userId: "user",
      organizationId: "org",
      definition: { prompt: "hello" },
      timeoutSeconds,
    } as never,
  };
}

// 错误、取消、断连、未知终态和未确认EOF均不能写成功任务历史。
test.each([
  { jsonrpc: "2.0", result: { stopReason: "error" } },
  { type: "event", payload: { jsonrpc: "2.0", result: { stopReason: "cancelled" } } },
  { jsonrpc: "2.0", error: { code: -1, message: "failed" } },
  { type: "event", payload: { jsonrpc: "2.0", error: { code: -1, message: "failed" } } },
  { type: "relay_closed" },
  { type: "error" },
  { jsonrpc: "2.0", result: { stopReason: "unexpected" } },
  null,
])("任务失败终态不记成功 %j", async (terminal) => {
  let disposed = 0;
  setAgentExecutorDeps({
    openAgentSession: async () => ({
      instanceId: "instance",
      turn: {
        prompt() {},
        events: async function* () {
          if (terminal) yield terminal;
        },
        dispose: async () => {
          disposed++;
        },
      } as never,
    }),
  });
  try {
    const result = await agentExecutor.execute(terminalInput());
    expect(result.status).toBe("failed");
    expect(disposed).toBe(1);
  } finally {
    setAgentExecutorDeps(null);
  }
});

// deadline从连接前计时，握手静默时也必须结算任务并阻止后续prompt。
test("连接静默时按deadline退出且释放迟到会话", async () => {
  let prompted = 0;
  let disposed = 0;
  let finish!: (result: OpenAgentSessionResult) => void;
  setAgentExecutorDeps({
    openAgentSession: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  try {
    const result = await agentExecutor.execute(terminalInput(0.01));
    expect(result.status).toBe("timeout");
    finish({
      instanceId: "late",
      turn: {
        prompt() {
          prompted++;
        },
        dispose: async () => {
          disposed++;
        },
      } as never,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prompted).toBe(0);
    expect(disposed).toBe(1);
  } finally {
    setAgentExecutorDeps(null);
  }
});

// 已发prompt后无任何后续输出也须在deadline内失败并请求本turn取消。
test("无输出执行超时会释放本turn", async () => {
  let disposed = 0;
  setAgentExecutorDeps({
    openAgentSession: async () => ({
      instanceId: "silent",
      turn: {
        prompt() {},
        events: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }),
        dispose: async () => {
          disposed++;
        },
      } as never,
    }),
  });
  try {
    const result = await agentExecutor.execute(terminalInput(0.01));
    expect(result.status).toBe("timeout");
    expect(disposed).toBe(1);
  } finally {
    setAgentExecutorDeps(null);
  }
});
