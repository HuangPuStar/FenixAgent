import { useRequest } from "ahooks";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
 * ChatPageVisibleContext — 由 ChatArea 提供，标识当前聊天页面是否对用户可见。
 * SessionsProvider 消费此 context 来控制 session/list 轮询：
 * 页面不可见（用户导航到非 chat 页面）时暂停轮询，切回后自动恢复。
 * 默认 true，确保在非 ChatArea 场景（如 MetaAgentPanel）下轮询正常工作。
 */
export const ChatPageVisibleContext = createContext<boolean>(true);

/** useChatPageVisible — 读取当前聊天页面是否对用户可见。 */
export function useChatPageVisible(): boolean {
  return useContext(ChatPageVisibleContext);
}

const POLL_INTERVAL = 30_000;

/**
 * SessionsProvider — 在 ACPMain 层级挂载，统一管理会话列表的请求/轮询/错误。
 *
 * capabilities 到达后通过 ready 参数自动触发首次请求。轮询由 useEffect 手动管理
 * setInterval/clearInterval，而非依赖 ahooks 的 pollingInterval 选项——
 * 这样可以精确控制何时启动/停止定时器，避免 ahooks 对动态 pollingInterval 处理不一致的问题。
 *
 * 关键设计：
 * - isReady 是 useState（响应式），订阅 capabilitiesChange 事件更新，
 *   而非一次性读取 client.supportsSessionList（后者不会触发 re-render）
 * - 轮询定时器受 isReady && pageVisible 双重控制：任一变 false 即 clearInterval
 * - 切回可见时立即 refresh() 拉取最新数据，不等 30s
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

  // 聊天页面可见性：切到非 chat 页面时暂停轮询，切回后自动恢复
  const pageVisible = useChatPageVisible();

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
      ready: isReady,
      onError: (err) => {
        console.warn("[useSessions] Failed to load sessions:", err);
      },
    },
  );

  // 缓存 refresh 引用，避免 effect 因 refresh 变化而反复重建定时器
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const fetchSessions = useCallback(() => {
    refreshRef.current();
  }, []);

  // 手动管理轮询：isReady && pageVisible 时启动，否则清除
  useEffect(() => {
    if (!isReady || !pageVisible) return;

    fetchSessions();
    const timer = setInterval(fetchSessions, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [isReady, pageVisible, fetchSessions]);

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
