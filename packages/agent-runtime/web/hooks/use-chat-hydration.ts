// packages/agent-runtime/web/hooks/use-chat-hydration.ts
// 展示层消息门控：hydrate 期间不提交任何消息，完成后一次性合并收口。
//
// 新旧两路都可能在初次打开/切换会话时逐批到达（旧路径 ACP 回放、新路径 DOC_BASE/DOC_UPDATE）。
// 直接把每批写进 React 会造成「逐条向下填充 + 每批自动滚动」。本 hook 暴露两个状态：
// - hydrating=true 时保持空展示；骨架 loading 延迟 LOADING_DELAY_MS 出现，快速切换不闪屏；
// - 基线静默后提交一次完整列表并切换为 live，之后按帧级节流接收实时增量。

import type { StructuredMessage } from "@fenix/chat-channel";
import { useEffect, useMemo, useRef, useState } from "react";
import { createHydrationGate, type HydrationGate } from "./chat-hydration-gate";
import { createSyncMessageMerger } from "./sync-chat-messages";
import type { useSessionState } from "./use-session-state";

type LegacySessionState = ReturnType<typeof useSessionState>["state"];

/** hydrate 期间没有真实 loading 投影时的占位：只驱动骨架屏与输入禁用。 */
const HYDRATION_LOADING = { kind: "session/bootstrap", since: 0 } as const;

/** hydrate 期间最后一次消息变化后的静默窗口。 */
const SETTLE_MS = 250;
/** 没有任何回放/基线活动时的兜底放行时间（例如复用持久化投影）。 */
const NO_ACTIVITY_MS = 1_500;
/** 硬上限：服务端异常时仍能呈现已有内容（覆盖 10s 回放窗口）。 */
const MAX_WAIT_MS = 12_000;
/** 实时阶段的帧级提交间隔。 */
const COMMIT_GAP_MS = 16;
/** 进入 hydrate 后延迟展示骨架：覆盖常见 load_session + settle（约 450ms），快速切换不闪屏。 */
const LOADING_DELAY_MS = 500;

/** 稳定的空数组：hydrate 期间所有渲染共享同一引用，ChatView 的 memo 才能生效。 */
export const EMPTY_CHAT_MESSAGES: StructuredMessage[] = [];

export interface UseChatHydrationOptions {
  /** 会话 + 投影代次；变化即重新进入 hydrating。 */
  readonly scope: string;
  readonly legacy: readonly StructuredMessage[];
  readonly sync: readonly StructuredMessage[];
  /** 旧连接已就绪（初始快照可能仍在途）；未就绪时门控不开始计时。 */
  readonly sourceReady: boolean;
  /** 旧路径正在回放历史（Session Doc presenting === "replaying"）。 */
  readonly replayActive?: boolean;
  /** 旧路径有实时 turn（presenting === "responding"），不是 hydrate。 */
  readonly liveActive?: boolean;
  /** 新协议基线（首批 DOC_BASE 的 APPLY_ACK）尚未齐备时暂缓放行。 */
  readonly blocked?: boolean;
  /** 新协议已进入不可恢复终态：必须结束骨架，让旧通道内容/空状态与输入区恢复可用。 */
  readonly syncTerminalError?: boolean;
  /** 本地新建会话：没有历史回放，不得用骨架替换空状态。 */
  readonly noReplaySession?: boolean;
}

export interface ChatHydrationState {
  readonly messages: StructuredMessage[];
  readonly hydrating: boolean;
  /** hydrate 持续超过 LOADING_DELAY_MS 后才为 true；调用方据此决定是否挂骨架 loading。 */
  readonly loadingVisible?: boolean;
}

interface LatestInput {
  readonly scope: string;
  readonly legacy: readonly StructuredMessage[];
  readonly sync: readonly StructuredMessage[];
  readonly merger: ReturnType<typeof createSyncMessageMerger>;
}

export function useChatHydration(options: UseChatHydrationOptions): ChatHydrationState {
  const {
    scope,
    legacy,
    sync,
    sourceReady,
    replayActive = false,
    liveActive = false,
    blocked = false,
    syncTerminalError = false,
    noReplaySession = false,
  } = options;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope 只作为重建合并器的驱动键，合并器函数体不读取它。
  const merger = useMemo(() => createSyncMessageMerger(), [scope]);
  const latest = useRef<LatestInput>({ scope, legacy, sync, merger });

  const [display, setDisplay] = useState<{ scope: string; messages: StructuredMessage[]; hydrating: boolean }>(() => ({
    scope,
    messages: EMPTY_CHAT_MESSAGES,
    hydrating: true,
  }));
  // 新协议基线在途时冻结同步投影：live 阶段继续显示旧快照，基线齐备后一次性替换；
  // hydrate 阶段保持空，避免半成品进入合并器。这样后到的基线不会逐帧追加。
  const effectiveSync = useRef<readonly StructuredMessage[]>(EMPTY_CHAT_MESSAGES);
  if (!blocked) effectiveSync.current = sync;
  else if (display.hydrating) effectiveSync.current = EMPTY_CHAT_MESSAGES;
  latest.current = { scope, legacy, sync: effectiveSync.current, merger };
  const gateRef = useRef<HydrationGate | null>(null);
  const sourceReadyRef = useRef(sourceReady);
  sourceReadyRef.current = sourceReady;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const noReplaySessionRef = useRef(noReplaySession);
  noReplaySessionRef.current = noReplaySession;
  const seenReplayRef = useRef(false);
  /** 基线在途后首次合并：完整基线可能晚于旧历史 5 秒，需按正文全量配对一次。 */
  const baselineMergeRef = useRef(false);
  /** 骨架 loading 的延迟展示：hydrate 在窗口内完成就完全不出现。按 scope 绑定，换代首帧不继承旧值。 */
  const [loading, setLoading] = useState<{ scope: string; visible: boolean }>({ scope, visible: false });
  const loadingVisible = loading.scope === scope && loading.visible;
  const hydratingNow = display.scope === scope ? display.hydrating : true;

  useEffect(() => {
    setLoading((previous) => (previous.scope === scope && !previous.visible ? previous : { scope, visible: false }));
    if (!hydratingNow) return;
    const timer = setTimeout(() => setLoading({ scope, visible: true }), LOADING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [scope, hydratingNow]);

  useEffect(() => {
    const gate = createHydrationGate({
      settleMs: SETTLE_MS,
      noActivityMs: NO_ACTIVITY_MS,
      maxWaitMs: MAX_WAIT_MS,
      commitGapMs: COMMIT_GAP_MS,
      onCommit: () => {
        const current = latest.current;
        if (current.scope !== scope) return;
        // 完整基线后到：允许跨 5s 窗口按角色+正文配对一次，避免异 ID 历史重复。
        const relax = baselineMergeRef.current;
        baselineMergeRef.current = false;
        const messages = current.merger(current.legacy, current.sync, relax ? Number.POSITIVE_INFINITY : undefined);
        setDisplay((previous) =>
          previous.scope === scope && previous.messages === messages && !previous.hydrating
            ? previous
            : { scope, messages, hydrating: false },
        );
      },
    });
    gateRef.current = gate;
    seenReplayRef.current = false;
    baselineMergeRef.current = false;
    gate.reset(sourceReadyRef.current);
    gate.setBlocked(blockedRef.current);
    if (noReplaySessionRef.current) gate.markComplete();
    const current = latest.current;
    if (current.legacy.length > 0 || current.sync.length > 0) gate.notify();
    return () => {
      gate.dispose();
      if (gateRef.current === gate) gateRef.current = null;
    };
  }, [scope]);

  useEffect(() => {
    if (!sourceReady) return;
    gateRef.current?.activate();
    // 已有消息说明基线在激活前就到齐了：通知门控按完成/兜底规则收口。
    const current = latest.current;
    if (current.legacy.length > 0 || current.sync.length > 0) gateRef.current?.notify();
  }, [sourceReady]);

  useEffect(() => {
    if (blocked) baselineMergeRef.current = true;
    gateRef.current?.setBlocked(blocked);
  }, [blocked]);

  useEffect(() => {
    if (noReplaySession) gateRef.current?.markComplete();
  }, [noReplaySession]);

  // 确定性完成信号：回放从 active 离开、或旧路径有实时 turn（不是 hydrate）。
  useEffect(() => {
    const gate = gateRef.current;
    if (gate === null) return;
    if (replayActive) {
      seenReplayRef.current = true;
      gate.setReplayActive(true);
      return;
    }
    if (liveActive) {
      seenReplayRef.current = false;
      gate.setReplayActive(false);
      gate.markComplete();
      return;
    }
    if (seenReplayRef.current) {
      seenReplayRef.current = false;
      gate.setReplayActive(false);
      gate.markComplete();
    }
  }, [replayActive, liveActive]);

  // 同步终态错误优先于回放标志：结束骨架，旧通道消息或空状态立即可见，输入区不被伪 loading 禁用。
  useEffect(() => {
    if (!syncTerminalError) return;
    // scope 是换代触发键：gateRef 在 scope effect 中重建，换代后必须重新收口。
    void scope;
    const gate = gateRef.current;
    if (gate === null) return;
    // 旧通道未就绪也必须收口：否则错误卡与骨架会一起长期停留。
    gate.activate();
    gate.setBlocked(false);
    gate.setReplayActive(false);
    gate.markComplete();
    gate.notify();
  }, [scope, syncTerminalError]);

  // 消息引用或基线阻塞状态变化才通知；notify 通过 latest ref 读取内容。
  // biome-ignore lint/correctness/useExhaustiveDependencies: legacy/sync/blocked 是刻意的触发依赖。
  useEffect(() => {
    gateRef.current?.notify();
  }, [legacy, sync, blocked]);

  if (display.scope !== scope) return { messages: EMPTY_CHAT_MESSAGES, hydrating: true, loadingVisible };
  return {
    messages: display.messages,
    hydrating: display.hydrating,
    loadingVisible: display.hydrating && loadingVisible,
  };
}

/**
 * 把门控结果投影到旧会话状态：hydrate 期间不展示半成品，只有延迟窗口已过且完全没有内容时
 * 才挂伪 loading；实时时按开关决定是否合并新投影。旧路径（chatSync=0 或明确回退）在非
 * hydrate 阶段保持原对象引用。
 */
export function applyChatHydration(
  legacy: LegacySessionState,
  hydration: ChatHydrationState,
  options: {
    readonly syncEnabled: boolean;
    readonly legacyFallback: boolean;
    readonly noReplaySession?: boolean;
    /** 同步终态错误时清掉骨架 loading，保证输入区可用。 */
    readonly syncTerminalError?: boolean;
  },
): LegacySessionState {
  // 延迟窗口内 loadingVisible=false：快速切换不出现骨架；空会话（noReplaySession + 无历史）也不挂。
  const gated =
    hydration.hydrating &&
    hydration.loadingVisible !== false &&
    hydration.messages.length === 0 &&
    !(options.noReplaySession && legacy.structuredMessages.length === 0);
  const loading = options.syncTerminalError ? null : gated ? (legacy.loading ?? HYDRATION_LOADING) : legacy.loading;
  if (!options.syncEnabled || options.legacyFallback) {
    return hydration.hydrating ? { ...legacy, structuredMessages: EMPTY_CHAT_MESSAGES, loading } : legacy;
  }
  return {
    ...legacy,
    structuredMessages: hydration.messages,
    loading,
  };
}
