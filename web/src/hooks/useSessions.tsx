import { useRequest } from "ahooks";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ACPClient } from "../acp/client";
import type { AgentSessionInfo } from "../acp/types";

export interface SessionsState {
  sessions: AgentSessionInfo[];
  loading: boolean;
  error: Error | null;
  refresh: () => void;
  isReady: boolean;
  /** 乐观更新本地数据（rename/delete 后立即刷新 UI，轮询随后从服务端确认） */
  mutate: (sessions: AgentSessionInfo[]) => void;
}

const SessionsContext = createContext<SessionsState | null>(null);

/**
 * SessionsProvider — 在 ACPMain 层级挂载，统一管理会话列表的请求/轮询/错误。
 *
 * 使用 ahooks useRequest + pollingInterval 替代各自组件的 setInterval。
 * capabilities 到达后通过 ready 参数自动触发首次请求，之后每 30s 轮询。
 *
 * 关键设计：
 * - isReady 是 useState（响应式），订阅 capabilitiesChange 事件更新，
 *   而非一次性读取 client.supportsSessionList（后者不会触发 re-render）
 * - 不用 refreshDeps 额外触发——ready 由 false→true 时 useRequest 自动执行
 * - mutate 供消费者做乐观更新，避免 rename/delete 后 UI 闪烁
 */
export function SessionsProvider({ client, children }: { client: ACPClient; children: React.ReactNode }) {
  // 响应式订阅 capabilities，避免非响应式读取导致 ready 永远不触发自动请求
  const [isReady, setIsReady] = useState(() => client.supportsSessionList);

  useEffect(() => {
    const onCaps = () => setIsReady(client.supportsSessionList);
    client.state.on("capabilitiesChange", onCaps);
    return () => {
      client.state.off("capabilitiesChange", onCaps);
    };
  }, [client]);

  const {
    data: sessionsRaw,
    loading,
    error,
    refresh,
    mutate,
  } = useRequest(
    async () => {
      const response = await client.listSessions();
      return Array.isArray(response?.sessions) ? (response.sessions as AgentSessionInfo[]) : [];
    },
    {
      pollingInterval: 30_000,
      ready: isReady,
      // 不用 refreshDeps — ready 由 false→true 时 useRequest 自动触发首次请求
      onError: (err) => {
        console.warn("[useSessions] Failed to load sessions:", err);
      },
    },
  );

  const sessions = sessionsRaw ?? [];

  const value = useMemo<SessionsState>(
    () => ({ sessions, loading, error: error ?? null, refresh, isReady, mutate }),
    [sessions, loading, error, refresh, isReady, mutate],
  );

  return <SessionsContext.Provider value={value}>{children}</SessionsContext.Provider>;
}

/**
 * useSessions — 消费 SessionsProvider 提供的共享会话列表数据。
 * 必须在 SessionsProvider 内部使用，否则抛出错误。
 */
export function useSessions(): SessionsState {
  const ctx = useContext(SessionsContext);
  if (!ctx) {
    throw new Error("useSessions must be used within a SessionsProvider");
  }
  return ctx;
}
