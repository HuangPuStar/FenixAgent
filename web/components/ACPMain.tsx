import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { ACPClient } from "../src/acp/client";
import type { AgentSessionInfo } from "../src/acp/types";
import { ChatInterface, type ChatInterfaceHandle } from "./ChatInterface";
import { cn } from "../src/lib/utils";
import { MessageSquare, Plus, PanelLeftClose, PanelLeft } from "lucide-react";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { apiGetEnvironment } from "../src/api/client";

interface ACPMainProps {
  client: ACPClient;
  agentId?: string;
  readonly?: boolean;
}

/**
 * Main container — Anthropic sidebar + chat layout.
 * Sidebar: sectioned by recency, orange active state, warm raised bg.
 */
export function ACPMain({ client, agentId, readonly }: ACPMainProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [cwd, setCwd] = useState<string | undefined>();
  const chatRef = useRef<ChatInterfaceHandle>(null);

  useEffect(() => {
    if (!agentId) return;
    apiGetEnvironment(agentId)
      .then((env) => setCwd(env.workspace_path.replace(/\/+$/, "")))
      .catch(() => {});
  }, [agentId]);

  // Handle session selection
  const handleSelectSession = useCallback(async (session: AgentSessionInfo) => {
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
  }, [client]);

  return (
    <div className="flex h-full w-full">
      {/* 侧边栏 — Anthropic warm sidebar, hidden on mobile / hidden in readonly share mode */}
      {!readonly && <div
        className={cn(
          "hidden md:flex flex-col border-r border-border/60 bg-surface-1/50 transition-all duration-200 flex-shrink-0",
          sidebarCollapsed ? "w-12" : "w-64",
        )}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-3 py-4">
          {!sidebarCollapsed && (
            <span className="text-xs font-display font-semibold text-text-muted uppercase tracking-widest px-1">会话</span>
          )}
          <div className={cn("flex items-center gap-0.5", sidebarCollapsed && "mx-auto")}>
            {!sidebarCollapsed && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => chatRef.current?.newSession()}
                className="h-7 w-7 text-text-muted hover:text-brand hover:bg-brand/10"
                title="新会话"
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
              {sidebarCollapsed ? (
                <PanelLeft className="h-4 w-4" />
              ) : (
                <PanelLeftClose className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>

        {/* 会话列表 */}
        {!sidebarCollapsed && (
          <ScrollArea className="flex-1">
            <SidebarSessionList client={client} cwd={cwd} onSelectSession={handleSelectSession} />
          </ScrollArea>
        )}
      </div>}

      {/* 聊天区域 */}
      <div className="flex-1 flex flex-col min-w-0">
        <ChatInterface ref={chatRef} client={client} agentId={agentId} cwd={cwd} readonly={readonly} />
      </div>
    </div>
  );
}

// =============================================================================
// 侧边栏会话列表 — Anthropic 分段式（今天/昨天/更早）
// =============================================================================

function SidebarSessionList({
  client,
  cwd,
  onSelectSession,
}: {
  client: ACPClient;
  cwd?: string;
  onSelectSession: (session: AgentSessionInfo) => void;
}) {
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    if (!client.supportsSessionList) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await client.listSessions(cwd ? { cwd } : undefined);
      setSessions(response.sessions);
    } catch (err) {
      console.warn("[SidebarSessionList] Failed to load:", err);
    } finally {
      setLoading(false);
    }
  }, [client, cwd]);

  useEffect(() => {
    if (client.getState() === "connected" && client.supportsSessionList) {
      loadSessions();
    }
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
    const interval = setInterval(loadSessions, 10000);
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
        <span className="text-xs text-text-muted font-display">加载中...</span>
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <span className="text-xs text-text-muted font-display">暂无会话</span>
      </div>
    );
  }

  // 按日期分组
  const groups = groupByRecency(sorted);

  return (
    <nav className="py-1" aria-label="历史会话">
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
                {session.title && session.title.trim() ? session.title : "新会话"}
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

function groupByRecency(sessions: AgentSessionInfo[]): SessionGroup[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);

  const groups: SessionGroup[] = [
    { label: "今天", sessions: [] },
    { label: "昨天", sessions: [] },
    { label: "更早", sessions: [] },
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
