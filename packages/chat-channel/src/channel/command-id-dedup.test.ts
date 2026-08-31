// packages/chat-channel/src/channel/command-id-dedup.test.ts
// CommandCoordinator 幂等与串行化测试（Q12 协议层测试 seam）：
// commandId 去重表覆盖重试窗口、重复 Action 不重复调用 executeCommand、
// 每 rcsSessionId 命令串行化、有界队列、失败重试与生命周期清理。

import { describe, expect, test } from "bun:test";
import {
  CommandCoordinator,
  type CommandCoordinatorDependencies,
  CommandExecutionError,
  type CommandOutcome,
} from "./index";
import type { ActionAck, ActionError, Command } from "./types";

interface SinkLog {
  acks: ActionAck[];
  errors: ActionError[];
}

function createSinks(): SinkLog & { sendAck: (ack: ActionAck) => void; sendError: (err: ActionError) => void } {
  const log: SinkLog = { acks: [], errors: [] };
  return {
    ...log,
    sendAck: (ack) => log.acks.push(ack),
    sendError: (err) => log.errors.push(err),
  };
}

function command(overrides: Partial<Command> = {}): Command {
  return {
    rcsSessionId: "rcs-1",
    commandId: "cmd-1",
    type: "send_prompt",
    sessionId: "ses-1",
    payload: { content: [{ type: "text", text: "hi" }] },
    ...overrides,
  };
}

function createCoordinator(
  executeCommand: (cmd: Command) => Promise<CommandOutcome> = async () => ({}),
  overrides: Partial<CommandCoordinatorDependencies> = {},
): { coordinator: CommandCoordinator; dependencies: CommandCoordinatorDependencies } {
  const dependencies: CommandCoordinatorDependencies = {
    executeCommand,
    ...overrides,
  };
  return { coordinator: new CommandCoordinator(dependencies), dependencies };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("CommandCoordinator dedup", () => {
  // 同一 commandId 重发（已 committed）必须返回 duplicate Ack，且 Agent（executeCommand）只被调用一次。
  test("resubmitting a committed command returns duplicate ack and does not re-execute", async () => {
    let executions = 0;
    const { coordinator } = createCoordinator(async () => {
      executions += 1;
      return { turnId: "turn-1" };
    });
    const first = createSinks();
    const retry = createSinks();

    await coordinator.submit(command(), first);
    await coordinator.submit(command(), retry);

    expect(executions).toBe(1);
    expect(first.acks.map((a) => a.status)).toEqual(["accepted", "committed"]);
    expect(first.acks[1]?.turnId).toBe("turn-1");
    expect(retry.acks).toHaveLength(1);
    expect(retry.acks[0]).toMatchObject({
      type: "action_ack",
      commandId: "cmd-1",
      status: "duplicate",
      turnId: "turn-1",
    });
    expect(retry.errors).toHaveLength(0);
  });

  // 命令仍在执行中（in_flight）时重发：返回原 accepted Ack，不重复入队、不重复执行。
  test("resubmitting an in-flight command returns the original accepted ack", async () => {
    const gate = deferred();
    let executions = 0;
    const { coordinator } = createCoordinator(async () => {
      executions += 1;
      await gate.promise;
      return {};
    });
    const first = createSinks();
    const retry = createSinks();

    const firstRun = coordinator.submit(command(), first);
    await Promise.resolve();
    await coordinator.submit(command(), retry);
    expect(executions).toBe(1);
    expect(retry.acks).toHaveLength(1);
    expect(retry.acks[0]).toMatchObject({ commandId: "cmd-1", status: "accepted" });

    gate.resolve();
    await firstRun;
    expect(executions).toBe(1);
  });

  // 同一 rcsSessionId 的命令必须串行执行：前一个未完成，后一个不得开始。
  test("serializes commands per rcsSessionId", async () => {
    const order: string[] = [];
    const gate = deferred();
    const { coordinator } = createCoordinator(async (cmd) => {
      order.push(cmd.commandId);
      if (cmd.commandId === "cmd-1") await gate.promise;
      return {};
    });

    const run1 = coordinator.submit(command(), createSinks());
    const run2 = coordinator.submit(command({ commandId: "cmd-2" }), createSinks());

    await Promise.resolve();
    expect(order).toEqual(["cmd-1"]);

    gate.resolve();
    await Promise.all([run1, run2]);
    expect(order).toEqual(["cmd-1", "cmd-2"]);
  });

  // 队列有界：超出 maxPendingPerSession 的命令返回 RATE_LIMITED（retryable）且不执行。
  test("rejects commands beyond the bounded queue with RATE_LIMITED", async () => {
    const gate = deferred();
    const executed: string[] = [];
    const { coordinator } = createCoordinator(
      async (cmd) => {
        executed.push(cmd.commandId);
        if (cmd.commandId === "cmd-1") await gate.promise;
        return {};
      },
      { maxPendingPerSession: 2 },
    );
    const run1 = coordinator.submit(command(), createSinks());
    const run2 = coordinator.submit(command({ commandId: "cmd-2" }), createSinks());
    const run3 = coordinator.submit(command({ commandId: "cmd-3" }), createSinks());
    const overflow = createSinks();

    // cmd-4 溢出：同步拒绝，不需要等待队列排空
    await coordinator.submit(command({ commandId: "cmd-4" }), overflow);

    expect(executed).toEqual(["cmd-1"]);
    expect(overflow.acks).toHaveLength(0);
    expect(overflow.errors[0]).toMatchObject({
      type: "action_error",
      commandId: "cmd-4",
      error: { type: "ACTION.RATE_LIMITED" },
    });

    gate.resolve();
    await Promise.all([run1, run2, run3]);
    expect(executed).toEqual(["cmd-1", "cmd-2", "cmd-3"]);
  });

  // 执行失败：返回 action_error、清除去重记录，重发视为新执行（副作用未发生可安全重试）。
  test("clears dedup record on execution failure so retry re-executes", async () => {
    let executions = 0;
    const { coordinator } = createCoordinator(async () => {
      executions += 1;
      if (executions === 1) throw new CommandExecutionError("ACTION.AGENT_UNAVAILABLE");
      return {};
    });
    const first = createSinks();
    const retry = createSinks();

    await coordinator.submit(command(), first);
    expect(first.errors[0]).toMatchObject({ error: { type: "ACTION.AGENT_UNAVAILABLE" } });
    expect(first.acks.map((a) => a.status)).toEqual(["accepted"]);

    await coordinator.submit(command(), retry);
    expect(executions).toBe(2);
    expect(retry.acks.map((a) => a.status)).toEqual(["accepted", "committed"]);
  });

  // disposeRcsSession 释放去重表与队列：同 commandId 重发视为新命令（随实例生命周期清理）。
  test("disposeRcsSession clears dedup table so resubmit re-executes", async () => {
    let executions = 0;
    const { coordinator } = createCoordinator(async () => {
      executions += 1;
      return {};
    });

    await coordinator.submit(command(), createSinks());
    coordinator.disposeRcsSession("rcs-1");
    await coordinator.submit(command(), createSinks());

    expect(executions).toBe(2);
  });

  // 形状校验：缺 commandId 或未知 action type 返回 INVALID_STATE，且不发 accepted。
  test("rejects malformed commands with INVALID_STATE before enqueueing", async () => {
    let executions = 0;
    const diagnostics: string[] = [];
    const { coordinator } = createCoordinator(
      async () => {
        executions += 1;
        return {};
      },
      { reportLog: (message) => diagnostics.push(message) },
    );
    const missingId = createSinks();
    const unknownType = createSinks();

    await coordinator.submit(command({ commandId: "" }), missingId);
    await coordinator.submit(command({ type: "unknown_action" }), unknownType);

    expect(executions).toBe(0);
    expect(missingId.acks).toHaveLength(0);
    expect(missingId.errors[0]).toMatchObject({ error: { type: "ACTION.INVALID_STATE" } });
    expect(unknownType.errors[0]).toMatchObject({ error: { type: "ACTION.INVALID_STATE" } });
    expect(diagnostics).toHaveLength(2);
    expect(JSON.parse(diagnostics[0] ?? "{}")).toMatchObject({
      event: "chat.error",
      errorId: missingId.errors[0]?.error.id,
      errorType: "ACTION.INVALID_STATE",
      stage: "action.command",
    });
  });

  // payload 超过大小上限返回 PAYLOAD_TOO_LARGE（稳定错误码）。
  test("rejects oversized payloads with PAYLOAD_TOO_LARGE", async () => {
    let executions = 0;
    const { coordinator } = createCoordinator(async () => {
      executions += 1;
      return {};
    });
    const sinks = createSinks();
    const oversized = command({
      payload: { content: "x".repeat(1024 * 1024 + 1) },
    });

    await coordinator.submit(oversized, sinks);

    expect(executions).toBe(0);
    expect(sinks.errors[0]).toMatchObject({ error: { type: "ACTION.PAYLOAD_TOO_LARGE" } });
  });

  // expectedProjectionVersion 与当前投影版本不一致返回稳定 VERSION_CONFLICT Type。
  test("rejects version conflicts with VERSION_CONFLICT", async () => {
    let executions = 0;
    const { coordinator } = createCoordinator(
      async () => {
        executions += 1;
        return {};
      },
      { getProjectionVersion: () => 3 },
    );
    const sinks = createSinks();

    await coordinator.submit(command({ expectedProjectionVersion: 2 }), sinks);

    expect(executions).toBe(0);
    expect(sinks.acks).toHaveLength(0);
    expect(sinks.errors[0]).toMatchObject({ error: { type: "ACTION.VERSION_CONFLICT" } });
  });

  // validateAction 拒绝（会话不存在等）时不得发送 accepted，错误码由注入方决定。
  test("validateAction rejection returns error without accepted ack", async () => {
    let executions = 0;
    const { coordinator } = createCoordinator(
      async () => {
        executions += 1;
        return {};
      },
      {
        validateAction: () => {
          throw new CommandExecutionError("ACTION.SESSION_NOT_FOUND");
        },
      },
    );
    const sinks = createSinks();

    await coordinator.submit(command(), sinks);

    expect(executions).toBe(0);
    expect(sinks.acks).toHaveLength(0);
    expect(sinks.errors[0]).toMatchObject({ error: { type: "ACTION.SESSION_NOT_FOUND" } });
  });

  // committed Ack 携带执行后读到的投影版本（getProjectionVersion 注入值）。
  test("committed ack carries the projection version", async () => {
    const { coordinator } = createCoordinator(async () => ({ turnId: "turn-9" }), { getProjectionVersion: () => 7 });
    const sinks = createSinks();

    await coordinator.submit(command(), sinks);

    expect(sinks.acks[1]).toMatchObject({
      status: "committed",
      turnId: "turn-9",
      committedProjectionVersion: 7,
    });
  });
});
