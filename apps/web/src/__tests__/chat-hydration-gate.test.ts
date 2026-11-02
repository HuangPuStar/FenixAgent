// apps/web/src/__tests__/chat-hydration-gate.test.ts
// 初次加载/会话切换的展示门控回归：回放完成前不提交、完成后一次提交、无回放/超时只作兜底。
// 定时器注入为确定性调度器，不依赖真实时间。

import { describe, expect, test } from "bun:test";
import { type SessionStateSnapshot, type StructuredMessage } from "@fenix/chat-channel";
import {
  createHydrationGate,
  type HydrationCommitReason,
  type HydrationGate,
} from "../../../../packages/agent-runtime/web/hooks/chat-hydration-gate";
import { createSyncMessageMerger } from "../../../../packages/agent-runtime/web/hooks/sync-chat-messages";
import { applyChatHydration } from "../../../../packages/agent-runtime/web/hooks/use-chat-hydration";

interface ScheduledTask {
  at: number;
  task: () => void;
  cancelled: boolean;
}

function createScheduler(): {
  schedule: (task: () => void, delayMs: number) => () => void;
  advance: (ms: number) => void;
} {
  let now = 0;
  const tasks: ScheduledTask[] = [];
  return {
    schedule(task, delayMs) {
      const item: ScheduledTask = { at: now + delayMs, task, cancelled: false };
      tasks.push(item);
      return () => {
        item.cancelled = true;
      };
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = tasks
          .filter((task) => !task.cancelled && task.at <= target)
          .sort((left, right) => left.at - right.at)[0];
        if (next === undefined) break;
        tasks.splice(tasks.indexOf(next), 1);
        now = next.at;
        next.task();
      }
      now = target;
    },
  };
}

function createGate(options: { onCommit: (reason: HydrationCommitReason) => void }): {
  gate: HydrationGate;
  scheduler: ReturnType<typeof createScheduler>;
} {
  const scheduler = createScheduler();
  const gate = createHydrationGate({
    settleMs: 250,
    noActivityMs: 1500,
    maxWaitMs: 12000,
    commitGapMs: 16,
    schedule: scheduler.schedule,
    onCommit: options.onCommit,
  });
  return { gate, scheduler };
}

function assistant(id: string, text: string, ts = 0): StructuredMessage {
  return { type: "assistant_message", id, chunks: [{ type: "message", text }], seq: 0, ts };
}

describe("聊天 hydrate 门控", () => {
  // 刷新恢复的实时输出每毫秒到达也不能推迟首次展示，之后仍按帧合并。
  test("实时回复不等待输出静默", () => {
    const commits: HydrationCommitReason[] = [];
    const { gate, scheduler } = createGate({ onCommit: (reason) => commits.push(reason) });
    gate.reset(true);
    gate.markLive();
    for (let index = 0; index < 15; index += 1) {
      scheduler.advance(1);
      gate.notify();
    }
    expect(commits).toEqual([]);
    scheduler.advance(1);
    expect(gate.phase()).toBe("live");
    expect(commits).toEqual(["live"]);
    gate.notify();
    scheduler.advance(16);
    expect(commits).toEqual(["live", "live"]);
  });

  // 初始基线未齐时不能展示；换代后也不能沿用实时标志跳过历史回放。
  test("实时恢复仍等待基线且不影响下一次历史加载", () => {
    const commits: HydrationCommitReason[] = [];
    const { gate, scheduler } = createGate({ onCommit: (reason) => commits.push(reason) });
    gate.reset(true);
    gate.setBlocked(true);
    gate.markLive();
    scheduler.advance(1000);
    expect(commits).toEqual([]);
    gate.setBlocked(false);
    scheduler.advance(16);
    expect(commits).toEqual(["live"]);

    gate.reset(true);
    gate.setReplayActive(true);
    scheduler.advance(500);
    expect(commits).toEqual(["live"]);
    gate.setReplayActive(false);
    gate.markComplete();
    scheduler.advance(249);
    expect(commits).toEqual(["live"]);
    scheduler.advance(1);
    expect(commits).toEqual(["live", "settled"]);
  });

  // 缺口 1：回放批次间隔 300/600/1200ms 时，回放结束前提交次数必须为 0，结束后恰好 1 次。
  test("回放间隔 300/600/1200ms 都不提前放行", () => {
    for (const interval of [300, 600, 1200]) {
      const commits: HydrationCommitReason[] = [];
      const { gate, scheduler } = createGate({ onCommit: (reason) => commits.push(reason) });
      gate.reset(true);
      gate.setReplayActive(true);
      const batches = Math.floor(9000 / interval);
      for (let index = 0; index < batches; index += 1) {
        gate.notify();
        scheduler.advance(interval);
      }
      expect(commits).toEqual([]);
      gate.setReplayActive(false);
      gate.markComplete();
      scheduler.advance(250);
      expect(commits).toEqual(["settled"]);
    }
  });

  // 缺口 1（慢启动）：回放 2s/4s 后才开始吐数据，服务端已在窗口开启时写入 replaying；
  // 客户端只要收到该信号，无活动兜底就不得放行。
  test("回放 2s/4s 后才开始也不提前放行", () => {
    for (const startDelay of [2000, 4000]) {
      const commits: HydrationCommitReason[] = [];
      const { gate, scheduler } = createGate({ onCommit: (reason) => commits.push(reason) });
      gate.reset(true);
      gate.setReplayActive(true);
      scheduler.advance(startDelay);
      expect(commits).toEqual([]);
      for (let index = 0; index < 150; index += 1) {
        gate.notify();
        scheduler.advance(50);
      }
      expect(commits).toEqual([]);
      gate.setReplayActive(false);
      gate.markComplete();
      scheduler.advance(250);
      expect(commits).toEqual(["settled"]);
    }
  });

  // 回放完成前的所有更新只更新数据；完成后一次提交，且不再重复提交。
  test("回放完成后只提交一次", () => {
    const commits: HydrationCommitReason[] = [];
    const { gate, scheduler } = createGate({ onCommit: (reason) => commits.push(reason) });
    gate.reset(true);
    gate.setReplayActive(true);
    for (let index = 0; index < 100; index += 1) {
      gate.notify();
      scheduler.advance(10);
    }
    expect(commits).toEqual([]);
    gate.setReplayActive(false);
    gate.markComplete();
    scheduler.advance(249);
    expect(commits).toEqual([]);
    scheduler.advance(1);
    expect(commits).toEqual(["settled"]);
    scheduler.advance(12000);
    expect(commits).toEqual(["settled"]);
  });

  // 没有回放/实时 turn 时，noActivity 只作兜底放行，且仍等一个静默窗口。
  test("无回放时 noActivity 兜底", () => {
    const commits: HydrationCommitReason[] = [];
    const { gate, scheduler } = createGate({ onCommit: (reason) => commits.push(reason) });
    gate.reset(true);
    scheduler.advance(1499);
    expect(commits).toEqual([]);
    scheduler.advance(1);
    expect(commits).toEqual([]);
    scheduler.advance(250);
    expect(commits).toEqual(["settled"]);
  });

  // 新协议基线未齐备（APPLY_ACK 未完成）时即使完成信号到达也不放行；解除后重新静默。
  test("基线未齐备时暂缓放行", () => {
    const commits: HydrationCommitReason[] = [];
    const { gate, scheduler } = createGate({ onCommit: (reason) => commits.push(reason) });
    gate.reset(true);
    gate.setBlocked(true);
    gate.markComplete();
    scheduler.advance(5000);
    expect(commits).toEqual([]);

    gate.setBlocked(false);
    scheduler.advance(249);
    expect(commits).toEqual([]);
    scheduler.advance(1);
    expect(commits).toEqual(["settled"]);
  });

  // 回放窗口异常不收敛时，maxWait 硬上限只放行一次。
  test("回放不收敛时 maxWait 硬上限放行一次", () => {
    const commits: HydrationCommitReason[] = [];
    const { gate, scheduler } = createGate({ onCommit: (reason) => commits.push(reason) });
    gate.reset(true);
    gate.setReplayActive(true);
    gate.notify();
    scheduler.advance(12000);
    expect(commits).toEqual(["max-wait"]);
  });

  // 实时阶段同一帧内的多条更新合并为一次提交，不再逐条触发 React。
  test("实时阶段按帧合并提交", () => {
    const commits: HydrationCommitReason[] = [];
    const { gate, scheduler } = createGate({ onCommit: (reason) => commits.push(reason) });
    gate.reset(true);
    gate.markComplete();
    scheduler.advance(250);
    expect(commits).toEqual(["settled"]);

    for (let index = 0; index < 5; index += 1) gate.notify();
    expect(commits).toHaveLength(1);
    scheduler.advance(16);
    expect(commits).toEqual(["settled", "live"]);

    for (let index = 0; index < 5; index += 1) gate.notify();
    scheduler.advance(16);
    expect(commits).toEqual(["settled", "live", "live"]);
  });

  // 会话切换重新 hydrate：旧计时器必须取消，新会话完成后才提交。
  test("reset 取消旧计时器，新会话独立提交", () => {
    const commits: HydrationCommitReason[] = [];
    const { gate, scheduler } = createGate({ onCommit: (reason) => commits.push(reason) });
    gate.reset(true);
    gate.setReplayActive(true);
    gate.notify();
    scheduler.advance(100);

    gate.reset(true);
    scheduler.advance(1000);
    expect(commits).toEqual([]);
    gate.markComplete();
    scheduler.advance(250);
    expect(commits).toEqual(["settled"]);
  });

  // 缺口 1 的规模证据：10k 条、200 批回放期间 0 次提交，回放结束后一次提交 1 万条且不重复。
  test("一万条大会话回放期间零提交", () => {
    const scheduler = createScheduler();
    const merger = createSyncMessageMerger();
    const legacy: StructuredMessage[] = [];
    const sync: StructuredMessage[] = [];
    let committed: StructuredMessage[] = [];
    let commits = 0;
    const gate = createHydrationGate({
      settleMs: 250,
      noActivityMs: 1500,
      maxWaitMs: 12000,
      commitGapMs: 16,
      schedule: scheduler.schedule,
      onCommit: () => {
        commits += 1;
        committed = merger(legacy, sync);
      },
    });

    gate.reset(true);
    gate.setReplayActive(true);
    const total = 10000;
    const batch = 50;
    for (let start = 0; start < total; start += batch) {
      for (let index = start; index < Math.min(start + batch, total); index += 1) {
        legacy.push(assistant(`m${index}`, `answer ${index}`));
        sync.push(assistant(`m${index}`, `answer ${index}`));
      }
      gate.notify();
      scheduler.advance(50);
    }
    expect(commits).toBe(0);
    gate.setReplayActive(false);
    gate.markComplete();
    scheduler.advance(250);
    expect(commits).toBe(1);
    expect(committed).toHaveLength(total);
    expect(new Set(committed.map((message) => message.id)).size).toBe(total);
  });

  // 本地新建会话没有历史：hydrate 期间不得挂伪 loading，空状态必须立即保持原样。
  test("新建会话空状态不显示骨架", () => {
    const legacy = {
      acpSessionId: "",
      sessionStatus: "ready",
      status: "idle",
      loading: null,
      canCancel: false,
      structuredMessages: [],
      pendingQuestions: new Map(),
      agentPublicError: null,
    } satisfies SessionStateSnapshot;
    const gated = applyChatHydration(
      legacy,
      { messages: [], hydrating: true },
      { syncEnabled: true, legacyFallback: false, noReplaySession: true },
    );
    expect(gated.loading).toBeNull();
    expect(gated.structuredMessages).toEqual([]);
  });

  // 延迟窗口内 loadingVisible=false 不得挂骨架；窗口结束后仍无内容才出现，快速切换不闪屏。
  test("骨架 loading 延迟到窗口结束后出现", () => {
    const legacy = {
      acpSessionId: "ses_1",
      sessionStatus: "ready",
      status: "idle",
      loading: null,
      canCancel: false,
      structuredMessages: [],
      pendingQuestions: new Map(),
      agentPublicError: null,
    } satisfies SessionStateSnapshot;

    const delayed = applyChatHydration(
      legacy,
      { messages: [], hydrating: true, loadingVisible: false },
      { syncEnabled: true, legacyFallback: false },
    );
    expect(delayed.loading).toBeNull();

    const visible = applyChatHydration(
      legacy,
      { messages: [], hydrating: true, loadingVisible: true },
      { syncEnabled: true, legacyFallback: false },
    );
    expect(visible.loading).toEqual({ kind: "session/bootstrap", since: 0 });
  });

  // chatSync=0 回退路径：hydrate 期间同样收起半成品；完成后原样返回旧状态对象（不引入新协议字段）。
  test("旧路径只在 hydrate 期间门控，完成后不改写状态", () => {
    const legacy = {
      acpSessionId: "ses_1",
      sessionStatus: "ready",
      status: "idle",
      loading: null,
      canCancel: false,
      structuredMessages: [assistant("a", "历史")],
      pendingQuestions: new Map(),
      agentPublicError: null,
    } satisfies SessionStateSnapshot;

    const gated = applyChatHydration(
      legacy,
      { messages: [], hydrating: true, loadingVisible: true },
      { syncEnabled: false, legacyFallback: false },
    );
    expect(gated.structuredMessages).toEqual([]);
    expect(gated.loading).not.toBeNull();

    const live = applyChatHydration(
      legacy,
      { messages: [], hydrating: false },
      { syncEnabled: false, legacyFallback: false },
    );
    expect(live).toBe(legacy);
  });
});
