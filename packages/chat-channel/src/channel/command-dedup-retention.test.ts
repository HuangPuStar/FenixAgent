import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CommandCoordinator } from "./command-coordinator";
import type { ActionAck, ActionError, Command } from "./types";

const WINDOW_MS = 10 * 60_000;
function command(coordinator: CommandCoordinator, rcsSessionId = "rcs-retention", type = "list_sessions"): Command {
  return {
    commandId: `${coordinator.getCommandEpoch()}.${randomUUID()}`,
    type,
    rcsSessionId,
    sessionId: "ses-confirmed",
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
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
/** 经真实断线与执行器退场生成 unknown 历史。 */
function unknownHarness() {
  let now = 0;
  let entered = deferred();
  let executions = 0;
  const coordinator = new CommandCoordinator({
    now: () => now,
    executeCommand: async (input, signal) => {
      executions++;
      if (!input.payload.uncertain) return {};
      entered.resolve();
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("connection closed")), { once: true });
      });
    },
  });
  return {
    coordinator,
    executions: () => executions,
    setNow: (time: number) => {
      now = time;
    },
    async retain(rcsSessionId = "rcs-retention") {
      entered = deferred();
      const input = { ...command(coordinator, rcsSessionId, "send_prompt"), payload: { uncertain: true } };
      const pending = coordinator.submitClientCommand(input, sinks());
      await entered.promise;
      coordinator.disposeRcsSession(rcsSessionId);
      await pending;
      return input;
    },
  };
}

describe("命令代次、历史保留与活动准入", () => {
  // 外部命令必须携带完整服务端代次，不能用 raw ID 或畸形后缀绕过信封校验。
  test("strict ingress rejects malformed IDs and foreign epochs", async () => {
    let executions = 0;
    const coordinator = new CommandCoordinator({ executeCommand: async () => ({ turnId: String(++executions) }) });
    for (const id of ["raw-id", `${coordinator.getCommandEpoch()}.bad`, `${randomUUID()}.${randomUUID()}`]) {
      const sink = sinks();
      await coordinator.submitClientCommand({ ...command(coordinator), commandId: id }, sink);
      expect(sink.errors[0]?.error.type).toBe(
        id === "raw-id" || id.endsWith(".bad") ? "ACTION.INVALID_STATE" : "ACTION.OUTCOME_UNKNOWN",
      );
    }
    expect(executions).toBe(0);
  });

  // 已退场未知结果不再占 256 个活动频道额度，历史到期回收后旧 full ID 仍不可执行。
  test("300 disconnected channels release hot admission while old unknown IDs stay fenced", async () => {
    const h = unknownHarness();
    const old: Command[] = [];
    for (let index = 0; index < 300; index++) old.push(await h.retain(`rcs-${index}`));
    const fresh = sinks();
    await h.coordinator.submitClientCommand(command(h.coordinator, "rcs-new"), fresh);
    expect(fresh.acks.at(-1)?.status).toBe("committed");
    for (const input of old) {
      const replay = sinks();
      await h.coordinator.submitClientCommand(input, replay);
      expect(replay.errors[0]?.error.type).toBe("ACTION.OUTCOME_UNKNOWN");
    }
    expect(h.executions()).toBe(301);
    const oldEpoch = h.coordinator.getCommandEpoch();
    h.setNow(WINDOW_MS + 1);
    expect(h.coordinator.getCommandEpoch()).not.toBe(oldEpoch);
    const current = sinks();
    await h.coordinator.submitClientCommand(command(h.coordinator, "rcs-next"), current);
    expect(current.acks.at(-1)?.status).toBe("committed");
    for (const input of old) await h.coordinator.submitClientCommand(input, sinks());
    expect(h.executions()).toBe(302);
  });

  // 持续命令跨固定窗口仍可用，过期 full ID 必须拒绝，不能依赖 TTL 直接遗忘后再执行。
  test("600 sustained commands stay usable across fixed history windows", async () => {
    let now = 0;
    let executions = 0;
    const coordinator = new CommandCoordinator({
      now: () => now,
      executeCommand: async () => ({ turnId: String(++executions) }),
    });
    const first = command(coordinator);
    let last = first;
    for (let index = 0; index < 600; index++) {
      now = index * 2_000;
      last = index === 0 ? first : command(coordinator);
      const sink = sinks();
      await coordinator.submitClientCommand(last, sink);
      expect(sink.errors).toEqual([]);
      expect(sink.acks.at(-1)?.status).toBe("committed");
    }
    const duplicate = sinks();
    await coordinator.submitClientCommand(last, duplicate);
    expect(duplicate.acks.at(-1)?.status).toBe("duplicate");
    const expired = sinks();
    await coordinator.submitClientCommand(first, expired);
    expect(expired.errors[0]?.error.type).toBe("ACTION.OUTCOME_UNKNOWN");
    expect(executions).toBe(600);
  });

  // 历史容量与活动配额独立，达到有界容量时先广播新 epoch，再淘汰旧证据。
  test("bounded history rotates epoch before capacity eviction", async () => {
    let executions = 0;
    const coordinator = new CommandCoordinator({
      now: () => 0,
      executeCommand: async () => ({ turnId: String(++executions) }),
    });
    const first = command(coordinator);
    const oldEpoch = coordinator.getCommandEpoch();
    const rotations: string[] = [];
    coordinator.onCommandEpochChanged((epoch) => rotations.push(epoch));
    for (let index = 0; index < 16_384; index++) {
      await coordinator.submitClientCommand(index === 0 ? first : command(coordinator), sinks());
    }
    expect(coordinator.getCommandEpoch()).not.toBe(oldEpoch);
    expect(rotations).toHaveLength(1);
    const replay = sinks();
    await coordinator.submitClientCommand(first, replay);
    expect(replay.errors[0]?.error.type).toBe("ACTION.OUTCOME_UNKNOWN");
    await coordinator.submitClientCommand(command(coordinator), sinks());
    expect(executions).toBe(16_385);
  });

  // 旧代在途记录跨轮换保持身份，精确重试返回原 accepted，迟到结果仍结算原 full ID。
  test("rotation preserves active records and their late committed outcomes", async () => {
    let now = 0;
    const started = deferred();
    const gate = deferred();
    const coordinator = new CommandCoordinator({
      now: () => now,
      executeCommand: async (input) => {
        if (input.payload.slow) {
          started.resolve();
          await gate.promise;
        }
        return { sessionId: input.sessionId };
      },
    });
    const slow = { ...command(coordinator, "rcs-slow"), payload: { slow: true } };
    const pending = coordinator.submitClientCommand(slow, sinks());
    await started.promise;
    await coordinator.submitClientCommand(command(coordinator, "rcs-history"), sinks());
    now = WINDOW_MS;
    expect(coordinator.getCommandEpoch()).not.toBe(slow.commandId.split(".")[0]);
    const retry = sinks();
    await coordinator.submitClientCommand(slow, retry);
    expect(retry.acks.at(-1)?.status).toBe("accepted");
    gate.resolve();
    await pending;
    const result = sinks();
    await coordinator.submitClientCommand(slow, result);
    expect(result.acks.at(-1)).toMatchObject({
      commandId: slow.commandId,
      status: "duplicate",
      sessionId: "ses-confirmed",
    });
  });

  // 全局限制只计算真实活动频道，并为取消在 256 个活动频道之外保留两槽。
  test("global hot admission reserves two cancel channels", async () => {
    const gate = deferred();
    const coordinator = new CommandCoordinator({
      executeCommand: async () => {
        await gate.promise;
        return {};
      },
    });
    const pending: Promise<void>[] = [];
    for (let index = 0; index < 256; index++)
      pending.push(coordinator.submitClientCommand(command(coordinator, `rcs-${index}`), sinks()));
    const full = sinks();
    await coordinator.submitClientCommand(command(coordinator, "rcs-overflow"), full);
    expect(full.errors[0]?.error.type).toBe("ACTION.RATE_LIMITED");
    for (let index = 0; index < 2; index++)
      pending.push(coordinator.submitClientCommand(command(coordinator, `rcs-cancel-${index}`, "cancel"), sinks()));
    const cancelFull = sinks();
    await coordinator.submitClientCommand(command(coordinator, "rcs-cancel-overflow", "cancel"), cancelFull);
    expect(cancelFull.errors[0]?.error.type).toBe("ACTION.RATE_LIMITED");
    gate.resolve();
    await Promise.all(pending);
  });

  // 每频道的 512 个活动命令与有界队列均保留两条取消，已完成历史不占这些槽位。
  test("per-channel hot admission and queues reserve two cancels", async () => {
    const gate = deferred();
    const coordinator = new CommandCoordinator({
      maxPendingPerSession: 511,
      executeCommand: async () => {
        await gate.promise;
        return {};
      },
    });
    const pending: Promise<void>[] = [];
    for (let index = 0; index < 512; index++)
      pending.push(coordinator.submitClientCommand(command(coordinator), sinks()));
    const full = sinks();
    await coordinator.submitClientCommand(command(coordinator), full);
    expect(full.errors[0]?.error.type).toBe("ACTION.RATE_LIMITED");
    for (let index = 0; index < 2; index++)
      pending.push(coordinator.submitClientCommand(command(coordinator, "rcs-retention", "cancel"), sinks()));
    const cancelFull = sinks();
    await coordinator.submitClientCommand(command(coordinator, "rcs-retention", "cancel"), cancelFull);
    expect(cancelFull.errors[0]?.error.type).toBe("ACTION.RATE_LIMITED");
    gate.resolve();
    await Promise.all(pending);
  });

  // 已接纳失败保留同一 full ID 的原错误，重连不能用它再次触发外部副作用。
  test("accepted failure retains its original error until epoch retirement", async () => {
    let executions = 0;
    const coordinator = new CommandCoordinator({
      executeCommand: async () => {
        executions++;
        throw new Error("failed");
      },
    });
    const input = command(coordinator);
    const original = sinks();
    await coordinator.submitClientCommand(input, original);
    const retry = sinks();
    await coordinator.submitClientCommand(input, retry);
    expect(retry.errors).toEqual(original.errors);
    expect(executions).toBe(1);
  });

  // 发布新代次期间同步重入仍须先占位；待回收旧 ID 只能返回旧结果，不能再执行。
  test("epoch publication reentrancy preserves atomic admission and old replay fences", async () => {
    let now = 0;
    let executions = 0;
    const coordinator = new CommandCoordinator({
      now: () => now,
      executeCommand: async () => ({ turnId: String(++executions) }),
    });
    const old = command(coordinator);
    await coordinator.submitClientCommand(old, sinks());
    const outer = command(coordinator);
    const nested: Promise<void>[] = [];
    const duringPublication = sinks();
    coordinator.onCommandEpochChanged((epoch) => {
      expect(coordinator.getCommandEpoch()).toBe(epoch);
      nested.push(coordinator.submitClientCommand(command(coordinator), sinks()));
      nested.push(coordinator.submitClientCommand(old, duringPublication));
    });
    now = WINDOW_MS;
    const rejected = sinks();
    await coordinator.submitClientCommand(outer, rejected);
    await Promise.all(nested);
    expect(rejected.errors[0]?.error.type).toBe("ACTION.OUTCOME_UNKNOWN");
    expect(duringPublication.acks[0]?.status).toBe("duplicate");
    const after = sinks();
    await coordinator.submitClientCommand(old, after);
    expect(after.errors[0]?.error.type).toBe("ACTION.OUTCOME_UNKNOWN");
    expect(executions).toBe(2);
  });
});
