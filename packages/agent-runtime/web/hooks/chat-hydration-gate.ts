// packages/agent-runtime/web/hooks/chat-hydration-gate.ts
// 初次加载/会话切换的展示门控：基线与回放增量到达期间不提交 React 状态，完成后一次性呈现。
//
// 完成信号优先使用确定性事实：
// - 旧路径：Session Doc 的 `presenting` 从 `replaying` 离开（服务端回放窗口收敛后写入）；
// - 实时 turn：`presenting === "responding"`，不是 hydrate，立即完成；
// - 新协议：首批 DOC_BASE 的 APPLY_ACK 全部 processed（由 transport tracker 提供）。
//
// 没有任何回放/基线活动时，用 noActivityMs 作为「不会再有回放」的兜底；maxWaitMs 是硬上限，
// 防止服务端异常时界面永久停在骨架屏。两者都不是正常路径的完成依据。
//
// 该模块是纯状态机（定时器可注入），便于断言「hydrate 期间提交次数为 0、完成后恰好 1 次」。

export type HydrationPhase = "hydrating" | "live";
export type HydrationCommitReason = "settled" | "max-wait" | "live";

export interface HydrationGateOptions {
  /** 完成信号后最后一次消息变化到提交的静默窗口（等待同批尾部帧）。 */
  readonly settleMs: number;
  /** 没有任何回放/基线活动时的兜底放行时间。 */
  readonly noActivityMs: number;
  /** hydrate 的硬上限；服务端异常时仍能呈现已有内容。 */
  readonly maxWaitMs: number;
  /** 实时阶段两次提交之间的最小间隔（帧级合并）。 */
  readonly commitGapMs: number;
  readonly schedule?: (task: () => void, delayMs: number) => () => void;
  readonly onCommit: (reason: HydrationCommitReason) => void;
}

export interface HydrationGate {
  /** 会话/代次切换：隐藏半成品并重新进入 hydrating；active 表示数据源已就绪。 */
  reset(active: boolean): void;
  /** 数据源（旧连接）就绪：开始兜底计时。 */
  activate(): void;
  /** 新协议基线（APPLY_ACK）尚未齐备时暂缓放行；解除后按完成状态决定是否收口。 */
  setBlocked(blocked: boolean): void;
  /** 旧路径进入/离开回放：进入时禁用无活动兜底，离开时由调用方 markComplete。 */
  setReplayActive(active: boolean): void;
  /** 确定性完成信号：回放结束 / 实时 turn / 基线齐备且无回放。 */
  markComplete(): void;
  /** 任一消息源变化。 */
  notify(): void;
  phase(): HydrationPhase;
  dispose(): void;
}

function defaultSchedule(task: () => void, delayMs: number): () => void {
  const handle = setTimeout(task, delayMs);
  return () => clearTimeout(handle);
}

export function createHydrationGate(options: HydrationGateOptions): HydrationGate {
  const schedule = options.schedule ?? defaultSchedule;
  let phase: HydrationPhase = "hydrating";
  let active = false;
  let disposed = false;
  let complete = false;
  let blocked = false;
  let replayActive = false;
  let noActivityElapsed = false;
  let settleCancel: (() => void) | null = null;
  let noActivityCancel: (() => void) | null = null;
  let maxCancel: (() => void) | null = null;
  let commitCancel: (() => void) | null = null;
  let livePending = false;

  function cancelSettle(): void {
    settleCancel?.();
    settleCancel = null;
  }

  function cancelNoActivity(): void {
    noActivityCancel?.();
    noActivityCancel = null;
  }

  function cancelMax(): void {
    maxCancel?.();
    maxCancel = null;
  }

  function cancelCommit(): void {
    commitCancel?.();
    commitCancel = null;
  }

  function reveal(reason: HydrationCommitReason): void {
    if (disposed || phase !== "hydrating") return;
    // 正常完成与静默收口必须等基线/回放结束；硬上限无条件放行。
    if (reason !== "max-wait" && (blocked || replayActive)) return;
    phase = "live";
    cancelSettle();
    cancelNoActivity();
    cancelMax();
    livePending = false;
    options.onCommit(reason);
  }

  function scheduleSettle(): void {
    if (disposed || !active || phase !== "hydrating" || blocked || replayActive) return;
    if (!complete && !noActivityElapsed) return;
    cancelSettle();
    settleCancel = schedule(() => {
      settleCancel = null;
      reveal("settled");
    }, options.settleMs);
  }

  function scheduleNoActivity(): void {
    if (disposed || !active || phase !== "hydrating" || replayActive || complete) return;
    cancelNoActivity();
    noActivityCancel = schedule(() => {
      noActivityCancel = null;
      if (disposed || phase !== "hydrating" || replayActive || complete) return;
      noActivityElapsed = true;
      scheduleSettle();
    }, options.noActivityMs);
  }

  function scheduleMax(): void {
    if (disposed || !active || phase !== "hydrating" || maxCancel !== null) return;
    maxCancel = schedule(() => {
      maxCancel = null;
      reveal("max-wait");
    }, options.maxWaitMs);
  }

  function scheduleLiveCommit(): void {
    if (disposed || !active || phase !== "live") return;
    livePending = true;
    if (commitCancel !== null) return;
    commitCancel = schedule(() => {
      commitCancel = null;
      livePending = false;
      options.onCommit("live");
      if (livePending) scheduleLiveCommit();
    }, options.commitGapMs);
  }

  function activate(): void {
    if (disposed || active) return;
    active = true;
    scheduleMax();
    scheduleNoActivity();
    // markComplete 可能早于旧连接就绪（例如新协议先进入终态错误）：激活后必须补一次收口。
    scheduleSettle();
  }

  return {
    reset(nextActive: boolean): void {
      if (disposed) return;
      cancelSettle();
      cancelNoActivity();
      cancelMax();
      cancelCommit();
      phase = "hydrating";
      active = false;
      complete = false;
      blocked = false;
      replayActive = false;
      noActivityElapsed = false;
      livePending = false;
      if (nextActive) activate();
    },
    activate,
    setBlocked(nextBlocked: boolean): void {
      if (disposed || phase !== "hydrating") return;
      blocked = nextBlocked;
      if (blocked) {
        cancelSettle();
        return;
      }
      scheduleSettle();
    },
    setReplayActive(nextReplayActive: boolean): void {
      if (disposed || phase !== "hydrating") return;
      replayActive = nextReplayActive;
      if (replayActive) {
        cancelNoActivity();
        cancelSettle();
      }
    },
    markComplete(): void {
      if (disposed || phase !== "hydrating") return;
      complete = true;
      cancelNoActivity();
      scheduleSettle();
    },
    notify(): void {
      if (disposed || !active) return;
      if (phase === "hydrating") {
        scheduleSettle();
        return;
      }
      scheduleLiveCommit();
    },
    phase(): HydrationPhase {
      return phase;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelSettle();
      cancelNoActivity();
      cancelMax();
      cancelCommit();
      livePending = false;
    },
  };
}
