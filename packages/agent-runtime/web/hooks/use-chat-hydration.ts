// packages/agent-runtime/web/hooks/use-chat-hydration.ts
// 展示层消息门控：hydrate 期间返回空列表（由调用方显示骨架），静默后一次性提交合并结果。
//
// 新旧两路都可能在初次打开/切换会话时逐批到达（旧路径 ACP 回放、新路径 DOC_BASE/DOC_UPDATE）。
// 直接把每批写进 React 会造成「逐条向下填充 + 每批自动滚动」。本 hook 只暴露两个状态：
// - hydrating=true 时 messages 恒为空，调用方显示 loading；
// - 基线静默后提交一次完整列表，之后按帧级节流接收实时增量。

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
  /** 本地新建会话：没有历史回放，不得用骨架替换空状态。 */
  readonly noReplaySession?: boolean;
}

export interface ChatHydrationState {
  readonly messages: StructuredMessage[];
  readonly hydrating: boolean;
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
    noReplaySession = false,
  } = options;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope 只作为重建合并器的驱动键，合并器函数体不读取它。
  const merger = useMemo(() => createSyncMessageMerger(), [scope]);
  const latest = useRef<LatestInput>({ scope, legacy, sync, merger });

  const [display, setDisplay] = useState<ChatHydrationState & { scope: string }>(() => ({
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

  // 消息引用或基线阻塞状态变化才通知；notify 通过 latest ref 读取内容。
  // biome-ignore lint/correctness/useExhaustiveDependencies: legacy/sync/blocked 是刻意的触发依赖。
  useEffect(() => {
    gateRef.current?.notify();
  }, [legacy, sync, blocked]);

  if (display.scope !== scope) return { messages: EMPTY_CHAT_MESSAGES, hydrating: true };
  return display;
}

/**
 * 把门控结果投影到旧会话状态：hydrating 时清空时间线并挂 loading；实时时按开关决定是否
 * 合并新投影。旧路径（chatSync=0 或明确回退）在非 hydrate 阶段保持原对象引用。
 */
export function applyChatHydration(
  legacy: LegacySessionState,
  hydration: ChatHydrationState,
  options: { readonly syncEnabled: boolean; readonly legacyFallback: boolean; readonly noReplaySession?: boolean },
): LegacySessionState {
  // 新建会话没有历史可等：不挂伪 loading，空状态立即保持原样。
  const gated = hydration.hydrating && !(options.noReplaySession && legacy.structuredMessages.length === 0);
  const loading = gated ? (legacy.loading ?? HYDRATION_LOADING) : legacy.loading;
  if (!options.syncEnabled || options.legacyFallback) {
    return hydration.hydrating ? { ...legacy, structuredMessages: EMPTY_CHAT_MESSAGES, loading } : legacy;
  }
  return {
    ...legacy,
    structuredMessages: hydration.hydrating ? EMPTY_CHAT_MESSAGES : hydration.messages,
    loading,
  };
}
