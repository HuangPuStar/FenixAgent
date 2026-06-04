import { MessageSquare, PanelLeft, PanelLeftClose, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ACPClient } from "../src/acp/client";
import type { AgentSessionInfo } from "../src/acp/types";
import { cn } from "../src/lib/utils";
import { ChatInterface, type ChatInterfaceHandle } from "./ChatInterface";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";

interface ACPMainProps {
  client: ACPClient;
  agentId?: string;
  initialCwd?: string;
  readonly?: boolean;
  hideSidebar?: boolean;
  rcsSessionId?: string;
  scenePrompt?: string;
  onPromptComplete?: () => void;
}

/**
 * Main container — Anthropic sidebar + chat layout.
 * Sidebar: sectioned by recency, orange active state, warm raised bg.
 */
export function ACPMain({
  client,
  agentId,
  readonly,
  hideSidebar,
  rcsSessionId,
  scenePrompt,
  onPromptComplete,
}: ACPMainProps) {
  const { t } = useTranslation("components");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [initialActiveSessionId, setInitialActiveSessionId] = useState<string | null>(null);
  const BOOTSTRAP_MAX_ATTEMPTS = 10;
  const chatRef = useRef<ChatInterfaceHandle>(null);
  const bootstrappedRef = useRef(false);
  const bootstrapRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: client 变更时需重置 bootstrap 状态，否则新连接不会加载会话
  useEffect(() => {
    bootstrappedRef.current = false;
    setBootstrapAttempt(0);
    if (bootstrapRetryTimerRef.current) {
      clearTimeout(bootstrapRetryTimerRef.current);
      bootstrapRetryTimerRef.current = null;
    }
  }, [client]);

  // When capabilities arrive via ACP event (not React getter), bump bootstrap attempt once.
  // This avoids the infinite loop caused by depending on a getter that returns true on every render.
  useEffect(() => {
    const onCaps = () => {
      if (bootstrappedRef.current) return;
      if (client.getState() !== "connected") return;
      if (!client.supportsSessionList) return;
      setBootstrapAttempt((prev) => prev + 1);
    };
    client.state.on("capabilitiesChange", onCaps);
    // Also check immediately in case capabilities already arrived before listener was registered
    onCaps();
    return () => client.state.off("capabilitiesChange", onCaps);
  }, [client]);

  // Handle session selection
  const handleSelectSession = useCallback(
    async (session: AgentSessionInfo) => {
      try {
        if (client.supportsLoadSession) {
          await client.loadSession({ sessionId: session.sessionId, cwd: session.cwd });
        } else if (client.supportsResumeSession) {
          await client.resumeSession({ sessionId: session.sessionId, cwd: session.cwd });
        } else {
          throw new Error("Loading or resuming sessions is not supported by this agent.");
        }
      } catch (error) {
        console.error("Failed to load/resume session:", error);
      }
    },
    [client],
  );

  // Bootstrap: load latest session or create new one.
  // Triggers on connection ready AND when capabilities arrive (via bootstrapAttempt increment).
  useEffect(() => {
    if (client.getState() !== "connected") {
      return;
    }
    if (bootstrappedRef.current) {
      return;
    }

    let cancelled = false;

    const bootstrap = async () => {
      try {
        if (!client.supportsSessionList) {
          // Capabilities not ready yet — retry via timer (not polling, just wait)
          if (bootstrapAttempt < BOOTSTRAP_MAX_ATTEMPTS) {
            if (!cancelled) {
              bootstrapRetryTimerRef.current = setTimeout(() => {
                setBootstrapAttempt((prev) => prev + 1);
              }, 200);
            }
            return;
          }
          // capabilities 始终不可用，跳过 session list 直接创建新会话
          console.log("[ACPMain] Session list not supported, creating new session directly");
          bootstrappedRef.current = true;
          chatRef.current?.newSession();
          return;
        }

        bootstrappedRef.current = true;
        // 不传 cwd — 让 agent 自己决定工作目录（本地/远程路径由后端处理）
        const response = await client.listSessions();
        if (cancelled) return;

        const latest = [...response.sessions].sort((a, b) => {
          const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          return timeB - timeA;
        })[0];

        if (latest) {
          setInitialActiveSessionId(latest.sessionId);
          await handleSelectSession(latest);
          return;
        }

        console.log("[ACPMain] No existing sessions found, creating new session");
        chatRef.current?.newSession();
      } catch (error) {
        bootstrappedRef.current = false;
        console.warn("[ACPMain] Failed to bootstrap latest session:", error);
      }
    };

    bootstrap();

    return () => {
      cancelled = true;
      if (bootstrapRetryTimerRef.current) {
        clearTimeout(bootstrapRetryTimerRef.current);
        bootstrapRetryTimerRef.current = null;
      }
    };
  }, [bootstrapAttempt, client, handleSelectSession]);

  return (
    <div className="flex h-full w-full">
      {/* 侧边栏 — Anthropic warm sidebar, hidden on mobile / hidden in readonly share mode */}
      {!readonly && !hideSidebar && (
        <div
          className={cn(
            "hidden md:flex flex-col border-r border-border/60 bg-surface-1/50 transition-all duration-200 flex-shrink-0",
            sidebarCollapsed ? "w-12" : "w-64",
          )}
        >
          {/* 头部 */}
          <div className="flex items-center justify-between px-3 py-4">
            {!sidebarCollapsed && (
              <span className="text-xs font-display font-semibold text-text-muted uppercase tracking-widest px-1">
                {t("acpMain.sessions")}
              </span>
            )}
            <div className={cn("flex items-center gap-0.5", sidebarCollapsed && "mx-auto")}>
              {!sidebarCollapsed && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => chatRef.current?.newSession()}
                  className="h-7 w-7 text-text-muted hover:text-brand hover:bg-brand/10"
                  title={t("acpMain.newSession")}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
                className="h-7 w-7 text-text-muted hover:text-text-primary hover:bg-surface-2"
              >
                {sidebarCollapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          {/* 会话列表 */}
          {!sidebarCollapsed && (
            <ScrollArea className="flex-1">
              <SidebarSessionList
                client={client}
                initialActiveSessionId={initialActiveSessionId}
                onSelectSession={handleSelectSession}
              />
            </ScrollArea>
          )}
        </div>
      )}

      {/* 聊天区域 */}
      <div className="flex-1 flex flex-col min-w-0">
        {hideSidebar && (
          <div className="flex items-center justify-end px-2 py-1 border-b border-border/40">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => chatRef.current?.newSession()}
              className="h-7 w-7 text-text-muted hover:text-brand hover:bg-brand/10"
              title={t("acpMain.newSession")}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        )}
        <ChatInterface
          ref={chatRef}
          client={client}
          agentId={agentId}
          readonly={readonly}
          hideContextPanel={true}
          rcsSessionId={rcsSessionId}
          scenePrompt={scenePrompt}
          onSessionCreated={(sessionId) => setInitialActiveSessionId(sessionId)}
          onPromptComplete={onPromptComplete}
        />
      </div>
    </div>
  );
}

// =============================================================================
// 侧边栏会话列表 — Anthropic 分段式（今天/昨天/更早）
// =============================================================================

function SidebarSessionList({
  client,
  initialActiveSessionId,
  onSelectSession,
}: {
  client: ACPClient;
  initialActiveSessionId: string | null;
  onSelectSession: (session: AgentSessionInfo) => void;
}) {
  const { t } = useTranslation("components");
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (initialActiveSessionId) {
      setActiveId(initialActiveSessionId);
    }
  }, [initialActiveSessionId]);

  const loadSessions = useCallback(async () => {
    if (!client.supportsSessionList) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await client.listSessions();
      setSessions(response.sessions);
    } catch (err) {
      console.warn("[SidebarSessionList] Failed to load:", err);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (client.getState() === "connected") {
      loadSessions();
    }
  }, [client, loadSessions]);

  // When capabilities arrive via ACP event, load sessions
  useEffect(() => {
    const onCaps = () => {
      if (client.supportsSessionList) {
        loadSessions();
      }
    };
    client.state.on("capabilitiesChange", onCaps);
    return () => client.state.off("capabilitiesChange", onCaps);
  }, [client, loadSessions]);

  useEffect(() => {
    const handler = (state: string) => {
      if (state === "connected") {
        setTimeout(loadSessions, 200);
      }
    };
    client.setConnectionStateHandler(handler);
    return () => client.removeConnectionStateHandler(handler);
  }, [client, loadSessions]);

  useEffect(() => {
    const interval = setInterval(loadSessions, 30_000);
    return () => clearInterval(interval);
  }, [loadSessions]);

  const sorted = useMemo(
    () =>
      [...sessions].sort((a, b) => {
        const dateA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const dateB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return dateB - dateA;
      }),
    [sessions],
  );

  if (loading && sessions.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="h-5 w-5 rounded-full border-2 border-brand border-t-transparent animate-spin" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-1">
        <span className="text-xs text-text-muted font-display">{t("acpMain.noSessions")}</span>
        <span className="text-[10px] text-text-muted">{t("acpMain.clickToCreate")}</span>
      </div>
    );
  }

  // 按日期分组
  const groups = groupByRecency(sorted, {
    today: t("acpMain.today"),
    yesterday: t("acpMain.yesterday"),
    earlier: t("acpMain.earlier"),
  });

  return (
    <nav className="py-1" aria-label={t("acpMain.historySessions")}>
      {groups.map((group, gi) => (
        <div key={group.label}>
          {gi > 0 && <div className="mx-3 my-2 border-t border-border/40" />}
          <div className="px-4 py-2">
            <span className="text-[10px] font-display font-semibold uppercase tracking-widest text-text-muted/70">
              {group.label}
            </span>
          </div>
          {group.sessions.map((session) => (
            <Button
              key={session.sessionId}
              variant="ghost"
              onClick={() => {
                setActiveId(session.sessionId);
                onSelectSession(session);
              }}
              className={cn(
                "w-full flex items-center gap-2.5 px-4 py-2 text-left justify-start rounded-none",
                session.sessionId === activeId
                  ? "bg-brand/8 text-text-primary hover:bg-brand/8"
                  : "text-text-secondary hover:bg-surface-2/60 hover:text-text-primary",
              )}
              title={session.title || session.sessionId}
            >
              <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 opacity-50" />
              <span className="text-[13px] font-display truncate leading-snug">
                {session.title?.trim() ? session.title : t("acpMain.newSession")}
              </span>
            </Button>
          ))}
        </div>
      ))}
    </nav>
  );
}

// =============================================================================
// 按日期分组：今天 / 昨天 / 更早
// =============================================================================

interface SessionGroup {
  label: string;
  sessions: AgentSessionInfo[];
}

function groupByRecency(
  sessions: AgentSessionInfo[],
  labels: { today: string; yesterday: string; earlier: string },
): SessionGroup[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);

  const groups: SessionGroup[] = [
    { label: labels.today, sessions: [] },
    { label: labels.yesterday, sessions: [] },
    { label: labels.earlier, sessions: [] },
  ];

  for (const session of sessions) {
    const date = session.updatedAt ? new Date(session.updatedAt) : new Date(0);
    if (date >= today) {
      groups[0].sessions.push(session);
    } else if (date >= yesterday) {
      groups[1].sessions.push(session);
    } else {
      groups[2].sessions.push(session);
    }
  }

  return groups.filter((g) => g.sessions.length > 0);
}
