import { useEffect, useRef, useState } from "react";

/** 稳定同步 key 的派生状态：按命名空间隔离，记录已见 ACP 会话与需要触发投影重建的 key。 */
export interface StableSyncSessionKeyState {
  readonly namespace: string;
  readonly seenAcpSessionId: string | null;
  readonly key: string | null;
}

/**
 * 从 ACP session id 序列派生 `useSyncChatState.sessionKey`。
 *
 * 空值→首个 ACP id 是会话建立后的补全，不是切换；若直接把它当 key，会 dispose 并重连同步投影，
 * 而 hydration gate 的 mergeScope（docHubKey + replacementVersion）不会同步重建，重连期间
 * blocked 提前变 false，旧通道消息可能被提前提交。规则：
 * - 命名空间变化时重置，新命名空间的首个值只作基线；
 * - 空值忽略，不清除已见值；
 * - 首个非空值只记录，不改变 key；此后不同的非空值才更新 key 触发投影重建。
 */
export function deriveStableSyncSessionKey(
  previous: StableSyncSessionKeyState | null,
  namespace: string,
  acpSessionId: string | null | undefined,
): StableSyncSessionKeyState {
  const next = acpSessionId === null || acpSessionId === undefined || acpSessionId.length === 0 ? null : acpSessionId;
  if (previous === null || previous.namespace !== namespace) {
    return { namespace, seenAcpSessionId: next, key: null };
  }
  // 会话切换或关闭期间可能短暂读不到 ACP id：忽略空值，保留已见值以避免把恢复误判成新一轮补全。
  if (next === null) return previous;
  if (previous.seenAcpSessionId === null) {
    return { namespace, seenAcpSessionId: next, key: previous.key };
  }
  if (previous.seenAcpSessionId === next) return previous;
  return { namespace, seenAcpSessionId: next, key: next };
}

/** 把派生状态接到 React；key 只随真实 ACP 会话切换变化（见 `deriveStableSyncSessionKey`）。 */
export function useStableSyncSessionKey(namespace: string, acpSessionId: string | null | undefined): string | null {
  const stateRef = useRef<StableSyncSessionKeyState | null>(null);
  const [scope, setScope] = useState<{ namespace: string; key: string | null }>({ namespace, key: null });

  useEffect(() => {
    const next = deriveStableSyncSessionKey(stateRef.current, namespace, acpSessionId);
    stateRef.current = next;
    setScope((current) =>
      current.namespace === next.namespace && current.key === next.key
        ? current
        : { namespace: next.namespace, key: next.key },
    );
  }, [namespace, acpSessionId]);

  // 命名空间切换后的首帧不沿用旧 key（此时 useSyncChatState 的 scope 已在按新会话重建）。
  return scope.namespace === namespace ? scope.key : null;
}
