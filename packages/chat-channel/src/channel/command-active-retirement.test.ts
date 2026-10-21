import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CommandCoordinator } from "./command-coordinator";
import { type ActionAck, type ActionError, type Command, CommandExecutionError } from "./types";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function input(coordinator: CommandCoordinator, id: string, rcsSessionId = "rcs-active"): Command {
  return {
    commandId: `${coordinator.getCommandEpoch()}.${randomUUID()}`,
    type: "list_sessions",
    sessionId: id,
    rcsSessionId,
    payload: {},
  };
}
function sinks() {
  const acks: ActionAck[] = [];
  const errors: ActionError[] = [];
  return {
    acks,
    errors,
    sendAck: (ack: ActionAck) => acks.push(ack),
    sendError: (error: ActionError) => errors.push(error),
  };
}

// 已断线的 unknown 执行跨历史窗口仍保留身份，替换队列等待旧执行器，迟到结算只影响旧 full ID。
test("active unknown survives expiry, queue replacement and its late authoritative settlement", async () => {
  let now = 0;
  const started = deferred();
  const oldGate = deferred();
  const order: string[] = [];
  const coordinator = new CommandCoordinator({
    now: () => now,
    executeCommand: async (command) => {
      order.push(command.sessionId);
      if (command.sessionId === "old") {
        started.resolve();
        await oldGate.promise;
      }
      return { sessionId: command.sessionId };
    },
  });
  const old = input(coordinator, "old");
  const first = coordinator.submitClientCommand(old, sinks());
  await started.promise;
  await coordinator.submitClientCommand(input(coordinator, "history", "rcs-history"), sinks());
  coordinator.disposeRcsSession(old.rcsSessionId);
  now = 20 * 60_000;
  const successor = input(coordinator, "new");
  expect(successor.commandId.split(".")[0]).not.toBe(old.commandId.split(".")[0]);
  const next = coordinator.submitClientCommand(successor, sinks());
  const unknown = sinks();
  await coordinator.submitClientCommand(old, unknown);
  expect(unknown.errors[0]?.error.type).toBe("ACTION.OUTCOME_UNKNOWN");
  expect(order).toEqual(["old", "history"]);
  oldGate.resolve();
  await Promise.all([first, next]);
  const oldResult = sinks();
  const newResult = sinks();
  await coordinator.submitClientCommand(old, oldResult);
  await coordinator.submitClientCommand(successor, newResult);
  expect(oldResult.acks[0]).toMatchObject({ commandId: old.commandId, status: "duplicate", sessionId: "old" });
  expect(newResult.acks[0]).toMatchObject({ commandId: successor.commandId, status: "duplicate", sessionId: "new" });
  expect(order).toEqual(["old", "history", "new"]);
});

// 未验证占位不能冒充 accepted；异步验证失败后空队列与活动记录均应退场。
test("validation placeholders never acknowledge acceptance and rejected channels leave no empty queues", async () => {
  const validation = deferred();
  const coordinator = new CommandCoordinator({
    validateAction: async () => {
      await validation.promise;
      throw new CommandExecutionError("ACTION.INVALID_STATE");
    },
    executeCommand: async () => {
      throw new Error("invalid commands must not execute");
    },
  });
  const command = input(coordinator, "invalid");
  const pending = coordinator.submitClientCommand(command, sinks());
  const retry = sinks();
  await coordinator.submitClientCommand(command, retry);
  expect(retry.acks).toEqual([]);
  expect(retry.errors[0]?.error.type).toBe("ACTION.OUTCOME_UNKNOWN");
  validation.resolve();
  await pending;
  for (let index = 0; index < 300; index++) {
    const invalid = input(coordinator, "invalid", `rcs-invalid-${index}`);
    await coordinator.submitClientCommand(invalid, sinks());
    coordinator.disposeRcsSession(invalid.rcsSessionId);
  }
  const queues: unknown = Reflect.get(coordinator, "queues");
  expect(queues instanceof Map && queues.size).toBe(0);
});

// 验证失败清理必须保留前代执行屏障，不能为清空队列而让重连命令越过尚未退场的旧执行。
test("failed validation preserves the predecessor barrier for a reconnect queue", async () => {
  const started = deferred();
  const oldGate = deferred();
  const order: string[] = [];
  const coordinator = new CommandCoordinator({
    validateAction: (command) => {
      if (command.sessionId === "invalid") throw new CommandExecutionError("ACTION.INVALID_STATE");
    },
    executeCommand: async (command) => {
      order.push(command.sessionId);
      if (command.sessionId === "old") {
        started.resolve();
        await oldGate.promise;
      }
      return {};
    },
  });
  const old = input(coordinator, "old");
  const first = coordinator.submitClientCommand(old, sinks());
  await started.promise;
  coordinator.disposeRcsSession(old.rcsSessionId);
  await coordinator.submitClientCommand(input(coordinator, "invalid"), sinks());
  const next = coordinator.submitClientCommand(input(coordinator, "next"), sinks());
  await Promise.resolve();
  expect(order).toEqual(["old"]);
  oldGate.resolve();
  await Promise.all([first, next]);
  expect(order).toEqual(["old", "next"]);
});
