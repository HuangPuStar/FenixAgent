import { describe, expect, test } from "bun:test";
import { CommandCoordinator } from "./command-coordinator";
import type { ActionAck, ActionError, Command } from "./types";

function command(id: string, type = "list_sessions", rcsSessionId = "rcs-retention"): Command {
  return { commandId: id, type, rcsSessionId, sessionId: "ses-confirmed", payload: {} };
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

const UNKNOWN_WINDOW_MS = 24 * 60 * 60_000;

/** 经真实断线与执行退场生成未知结果，不直接构造内部去重表。 */
function unknownHarness() {
  let now = 0;
  let entered = () => {};
  const coordinator = new CommandCoordinator({
    now: () => now,
    executeCommand: async (input, signal) => {
      if (!input.payload.uncertain) return {};
      entered();
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("connection closed")), { once: true });
      });
    },
  });
  return {
    coordinator,
    setNow: (time: number) => {
      now = time;
    },
    async retain(id: string, rcsSessionId = "rcs-retention") {
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = coordinator.submit(
        { ...command(id, "send_prompt", rcsSessionId), payload: { uncertain: true } },
        sinks(),
      );
      await started;
      coordinator.disposeRcsSession(rcsSessionId);
      await pending;
    },
  };
}

describe("命令去重逐条保留与取消额度", () => {
  // 活跃会话持续发送超过窗口时，过期结果逐条回收，不能被最近命令续期锁死。
  test("600 条分散完成命令跨十分钟持续可用", async () => {
    let now = 0;
    let executed = 0;
    const coordinator = new CommandCoordinator({
      now: () => now,
      executeCommand: async () => {
        executed++;
        return {};
      },
    });
    for (let index = 0; index < 600; index++) {
      now = index * 2_000;
      const sink = sinks();
      await coordinator.submit(command(`command-${index}`), sink);
      expect(sink.errors).toEqual([]);
      expect(sink.acks.at(-1)?.status).toBe("committed");
    }
    const duplicate = sinks();
    await coordinator.submit(command("command-599"), duplicate);
    expect(duplicate.acks.at(-1)?.status).toBe("duplicate");
    expect(executed).toBe(600);
    const expired = sinks();
    await coordinator.submit(command("command-0"), expired);
    expect(expired.acks.at(-1)?.status).toBe("committed");
    expect(executed).toBe(601);
  });

  // 未知结果在完整保留窗口内不能因普通命令回收而丢失，否则会重复外部副作用。
  test("未知结果跨窗口与正常命令回收后仍禁止重放", async () => {
    let now = 0;
    let reject!: (error: Error) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let uncertainExecutions = 0;
    const coordinator = new CommandCoordinator({
      now: () => now,
      executeCommand: async (input) => {
        if (input.commandId === "uncertain") {
          uncertainExecutions++;
          started();
          return new Promise((_, fail) => {
            reject = fail;
          });
        }
        return {};
      },
    });
    const pending = coordinator.submit(command("uncertain"), sinks());
    await entered;
    coordinator.disposeRcsSession("rcs-retention");
    reject(new Error("connection closed"));
    await pending;
    for (let index = 0; index < 600; index++) {
      now += 2_000;
      await coordinator.submit(command(`fresh-${index}`), sinks());
    }
    now = 24 * 60 * 60_000 - 1;
    const replay = sinks();
    await coordinator.submit(command("uncertain"), replay);
    expect(replay.errors[0]?.error.type).toBe("ACTION.OUTCOME_UNKNOWN");
    expect(uncertainExecutions).toBe(1);
  });

  // 满去重表、满普通队列时取消仍可入队；额度用尽后必须明确背压且优先执行取消。
  test("同会话去重与队列同时饱和保留两条取消", async () => {
    let release!: () => void;
    let start!: () => void;
    const entered = new Promise<void>((resolve) => {
      start = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const coordinator = new CommandCoordinator({
      now: () => 0,
      maxPendingPerSession: 1,
      executeCommand: async (input) => {
        order.push(input.commandId);
        if (input.commandId === "active") {
          start();
          await gate;
        }
        return {};
      },
    });
    for (let index = 0; index < 510; index++) await coordinator.submit(command(`retained-${index}`), sinks());
    const active = coordinator.submit(command("active"), sinks());
    await entered;
    const ordinary = coordinator.submit(command("queued"), sinks());
    await Promise.resolve();
    const full = sinks();
    await coordinator.submit(command("ordinary-overflow"), full);
    expect(full.errors[0]?.error.type).toBe("ACTION.RATE_LIMITED");
    const firstSink = sinks();
    const secondSink = sinks();
    const first = coordinator.submit(command("cancel-one", "cancel"), firstSink);
    const second = coordinator.submit(command("cancel-two", "cancel"), secondSink);
    const overflow = sinks();
    await coordinator.submit(command("cancel-three", "cancel"), overflow);
    expect(overflow.errors[0]?.error.type).toBe("ACTION.RATE_LIMITED");
    release();
    await Promise.all([active, ordinary, first, second]);
    expect(firstSink.errors).toEqual([]);
    expect(secondSink.errors).toEqual([]);
    expect(order.slice(-4)).toEqual(["active", "cancel-two", "cancel-one", "queued"]);
  });

  // 全局会话去重预算也必须为控制命令留槽，避免入口预留被下一层吞掉。
  test("全局去重会话预算保留两条取消且保持有界", async () => {
    const coordinator = new CommandCoordinator({ now: () => 0, executeCommand: async () => ({}) });
    for (let index = 0; index < 256; index++)
      await coordinator.submit(command("first", "list_sessions", `rcs-${index}`), sinks());
    const ordinary = sinks();
    await coordinator.submit(command("blocked", "list_sessions", "rcs-new"), ordinary);
    expect(ordinary.errors[0]?.error.type).toBe("ACTION.RATE_LIMITED");
    for (let index = 0; index < 2; index++) {
      const cancel = sinks();
      await coordinator.submit(command("cancel", "cancel", `rcs-control-${index}`), cancel);
      expect(cancel.acks.at(-1)?.status).toBe("committed");
    }
    const full = sinks();
    await coordinator.submit(command("cancel", "cancel", "rcs-control-overflow"), full);
    expect(full.errors[0]?.error.type).toBe("ACTION.RATE_LIMITED");
  });

  // 未知结果必须逐条到期，旧命令重试不能延长保护窗口，也不能提前删除较新记录。
  test("未知结果截止时间独立且重试不续期", async () => {
    const h = unknownHarness();
    await h.retain("older");
    h.setNow(60 * 60_000);
    await h.retain("newer");
    h.setNow(UNKNOWN_WINDOW_MS - 1);
    const within = sinks();
    await h.coordinator.submit(command("older"), within);
    expect(within.errors[0]?.error.type).toBe("ACTION.OUTCOME_UNKNOWN");
    h.setNow(UNKNOWN_WINDOW_MS);
    const expired = sinks();
    await h.coordinator.submit(command("older"), expired);
    expect(expired.acks.at(-1)?.status).toBe("committed");
    const retained = sinks();
    await h.coordinator.submit(command("newer"), retained);
    expect(retained.errors[0]?.error.type).toBe("ACTION.OUTCOME_UNKNOWN");
  });

  // 全局与单会话预算都必须随已结束未知记录到期恢复，不能要求重启进程才能继续聊天。
  test.each(["global", "session"] as const)("%s 未知结果满额时限流，到期后恢复容量", async (scope) => {
    const h = unknownHarness();
    const limit = scope === "global" ? 256 : 512;
    for (let index = 0; index < limit; index++) {
      await h.retain(`uncertain-${index}`, scope === "global" ? `rcs-${index}` : "rcs-retention");
    }
    h.setNow(UNKNOWN_WINDOW_MS - 1);
    const blocked = sinks();
    const target = scope === "global" ? "rcs-new" : "rcs-retention";
    await h.coordinator.submit(command("fresh", "list_sessions", target), blocked);
    expect(blocked.errors[0]?.error.type).toBe("ACTION.RATE_LIMITED");
    h.setNow(UNKNOWN_WINDOW_MS);
    const recovered = sinks();
    await h.coordinator.submit(command("fresh", "list_sessions", target), recovered);
    expect(recovered.errors).toEqual([]);
    expect(recovered.acks.at(-1)?.status).toBe("committed");
  });

  // 超长旧执行可能已离开当前队列索引；直到其退场前都不能按截止时间放行同一命令。
  test("在途跨窗口及重连换队列后仍保护，退场不续期未知结果", async () => {
    let now = 0;
    let entered!: () => void;
    let reject!: (error: Error) => void;
    let executions = 0;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const coordinator = new CommandCoordinator({
      now: () => now,
      executeCommand: async (input) => {
        if (input.commandId !== "slow" || !input.payload.uncertain) return {};
        executions++;
        entered();
        return new Promise((_, fail) => {
          reject = fail;
        });
      },
    });
    const original = coordinator.submit({ ...command("slow"), payload: { uncertain: true } }, sinks());
    await started;
    now = 2 * UNKNOWN_WINDOW_MS;
    const inFlight = sinks();
    await coordinator.submit(command("slow"), inFlight);
    expect(inFlight.acks.at(-1)?.status).toBe("accepted");
    expect(executions).toBe(1);
    coordinator.disposeRcsSession("rcs-retention");
    now += UNKNOWN_WINDOW_MS - 1;
    coordinator.disposeRcsSession("rcs-retention");
    const successor = coordinator.submit(command("next"), sinks());
    now++;
    const protectedReplay = sinks();
    await coordinator.submit(command("slow"), protectedReplay);
    expect(protectedReplay.errors[0]?.error.type).toBe("ACTION.OUTCOME_UNKNOWN");
    expect(executions).toBe(1);
    reject(new Error("old executor stopped"));
    await Promise.all([original, successor]);
    const released = sinks();
    await coordinator.submit(command("slow"), released);
    expect(released.errors).toEqual([]);
    expect(released.acks.at(-1)?.status).toBe("committed");
  });
});
