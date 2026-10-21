import type { YjsHistoryIncomplete, YjsWsOptions } from "@fenix/chat-channel";
import { useCallback, useEffect, useRef, useState } from "react";
import type { getDocHubGenerations } from "../yjs/doc-hub";

type SyncComplete = Parameters<NonNullable<YjsWsOptions["onSyncComplete"]>>[0];
interface RecoveryAttempt {
  epoch: number;
  active: boolean;
  required: Map<string, string | undefined>;
  covered: Map<string, string>;
}

/** 跟踪旧历史的当前连接证明；普通实时更新不能结算缺失历史。 */
export function useChatHistoryRecovery() {
  const [historyRecovery, setHistoryRecovery] = useState<YjsHistoryIncomplete | null>(null);
  const [historyRecoveryRetrying, setHistoryRecoveryRetrying] = useState(false);
  const [historyRecoveryAttempt, setHistoryRecoveryAttempt] = useState(0);
  const recovery = useRef<YjsHistoryIncomplete | null>(null);
  const attempt = useRef<RecoveryAttempt>({ epoch: 0, active: false, required: new Map(), covered: new Map() });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const ownsConnection = useCallback((epoch: number) => attempt.current.epoch === epoch, []);
  const isCurrentConnection = useCallback(
    (epoch: number) => attempt.current.active && attempt.current.epoch === epoch,
    [],
  );
  const beginConnection = useCallback(() => {
    // 新连接可以加载新世代；其完整投递证明必须与届时实际应用的 Doc 世代匹配。
    attempt.current = {
      epoch: attempt.current.epoch + 1,
      active: true,
      required: new Map((recovery.current?.docs ?? []).map((doc) => [doc, undefined])),
      covered: new Map(),
    };
    return attempt.current.epoch;
  }, []);
  const closeConnection = useCallback(
    (epoch: number) => {
      if (!ownsConnection(epoch)) return;
      attempt.current.active = false;
      attempt.current.covered.clear();
      clearTimer();
      setHistoryRecoveryRetrying(false);
    },
    [ownsConnection, clearTimer],
  );
  const recordIncomplete = useCallback(
    (epoch: number, info: YjsHistoryIncomplete) => {
      if (!isCurrentConnection(epoch)) return;
      // 失败保留本轮所需证明，迟到的同连接差量仍可由显式完成通知结算。
      attempt.current.required = new Map(info.docs.map((doc) => [doc, info.generation]));
      attempt.current.covered.clear();
      clearTimer();
      recovery.current = info;
      setHistoryRecovery(info);
      setHistoryRecoveryRetrying(false);
    },
    [isCurrentConnection, clearTimer],
  );
  const complete = useCallback(
    (epoch: number, info: SyncComplete, generations: ReturnType<typeof getDocHubGenerations>) => {
      const generation = info.generation;
      if (!isCurrentConnection(epoch) || recovery.current === null || !generation) return;
      const current = attempt.current;
      const applied = new Map(generations.map(({ docName, generation }) => [docName, generation]));
      // 换代使旧证明失效；部分成功也只能在同一世代内累计。
      for (const [docName, proof] of current.covered) {
        if (proof !== generation || applied.get(docName) !== proof) current.covered.delete(docName);
      }
      for (const docName of info.docs) {
        if (!current.required.has(docName)) continue;
        const expected = current.required.get(docName);
        if (expected !== undefined && expected !== generation) continue;
        if (applied.get(docName) !== generation) continue;
        current.covered.set(docName, generation);
      }
      if (
        current.required.size === 0 ||
        [...current.required].some(
          ([doc, expected]) =>
            current.covered.get(doc) !== generation ||
            applied.get(doc) !== generation ||
            (expected !== undefined && expected !== generation),
        )
      )
        return;
      current.required.clear();
      current.covered.clear();
      recovery.current = null;
      clearTimer();
      setHistoryRecovery(null);
      setHistoryRecoveryRetrying(false);
    },
    [isCurrentConnection, clearTimer],
  );
  const retryHistoryRecovery = useCallback(() => {
    if (recovery.current === null) return;
    clearTimer();
    setHistoryRecoveryRetrying(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      // 超时只重新开放重试按钮，不能替代历史完整性的证明。
      setHistoryRecoveryRetrying(false);
    }, 10_000);
    setHistoryRecoveryAttempt((value) => value + 1);
  }, [clearTimer]);
  useEffect(() => () => clearTimer(), [clearTimer]);
  return {
    historyRecovery,
    historyRecoveryRetrying,
    historyRecoveryAttempt,
    retryHistoryRecovery,
    beginConnection,
    closeConnection,
    ownsConnection,
    isCurrentConnection,
    recordIncomplete,
    complete,
  };
}
