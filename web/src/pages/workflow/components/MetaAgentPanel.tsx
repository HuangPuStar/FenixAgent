import { Bot, ChevronRight, Loader2, Menu, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ACPClient } from "../../../acp/client";
import type { AgentSessionInfo } from "../../../acp/types";
import { ChatPanel } from "../../agent-panel/ChatPanel";

interface MetaAgentPanelProps {
  chatOpen: boolean;
  setChatOpen: (open: boolean) => void;
  metaAgentId: string | null;
  scenePrompt: string | undefined;
  onPromptComplete?: () => void;
}

export function MetaAgentPanel({
  chatOpen,
  setChatOpen,
  metaAgentId,
  scenePrompt,
  onPromptComplete,
}: MetaAgentPanelProps) {
  const { t } = useTranslation("workflows");
  const [client, setClient] = useState<ACPClient | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const loadSessions = useCallback(async () => {
    if (!client?.supportsSessionList) return;
    setLoading(true);
    try {
      const response = await client.listSessions();
      setSessions(response.sessions);
    } catch (err) {
      console.warn("[MetaAgentPanel] Failed to load sessions:", err);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (client?.supportsSessionList && client.getState() === "connected") {
      loadSessions();
    }
  }, [client, loadSessions]);

  useEffect(() => {
    if (!client) return;
    const onCaps = () => {
      if (client.supportsSessionList) {
        loadSessions();
      }
    };
    client.state.on("capabilitiesChange", onCaps);
    return () => client.state.off("capabilitiesChange", onCaps);
  }, [client, loadSessions]);

  useEffect(() => {
    if (!historyOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setHistoryOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [historyOpen]);

  const handleSelectSession = useCallback(
    async (session: AgentSessionInfo) => {
      if (!client) return;
      try {
        if (client.supportsLoadSession) {
          await client.loadSession({ sessionId: session.sessionId, cwd: session.cwd });
        } else if (client.supportsResumeSession) {
          await client.resumeSession({ sessionId: session.sessionId, cwd: session.cwd });
        }
        setActiveSessionId(session.sessionId);
        setHistoryOpen(false);
      } catch (err) {
        console.error("[MetaAgentPanel] Failed to load session:", err);
      }
    },
    [client],
  );

  const grouped = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => {
      const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return tb - ta;
    });
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today.getTime() - 86400000);
    const groups: { label: string; items: AgentSessionInfo[] }[] = [
      { label: t("editor.history_today"), items: [] },
      { label: t("editor.history_yesterday"), items: [] },
      { label: t("editor.history_earlier"), items: [] },
    ];
    for (const s of sorted) {
      const d = s.updatedAt ? new Date(s.updatedAt) : new Date(0);
      if (d >= today) groups[0].items.push(s);
      else if (d >= yesterday) groups[1].items.push(s);
      else groups[2].items.push(s);
    }
    return groups.filter((g) => g.items.length > 0);
  }, [sessions, t]);

  if (!chatOpen) return null;

  return (
    <div
      style={{
        width: 400,
        minWidth: 400,
        display: "flex",
        flexDirection: "column",
        background: "#fff",
        borderLeft: "1px solid #e5e7eb",
        position: "relative",
      }}
    >
      {/* 头部 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          borderBottom: "1px solid #e5e7eb",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
          <button
            type="button"
            onClick={() => setHistoryOpen(!historyOpen)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 4,
              borderRadius: 4,
              color: historyOpen ? "#3b82f6" : "#6b7280",
              display: "flex",
              alignItems: "center",
              transition: "color 0.15s",
            }}
            title={t("editor.history_title")}
          >
            <Menu size={14} />
          </button>
          <Bot size={14} />
          Meta Agent
        </span>
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          <button
            type="button"
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 4,
              borderRadius: 4,
              color: "#6b7280",
              display: "flex",
              alignItems: "center",
            }}
            onClick={() => setChatOpen(false)}
            title={t("editor.chat_collapse")}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>

      {/* 浮空会话历史面板 */}
      {historyOpen && (
        <div
          ref={panelRef}
          style={{
            position: "absolute",
            top: 44,
            left: 4,
            width: 260,
            maxHeight: 400,
            background: "#fff",
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            boxShadow: "0 4px 12px rgba(0,0,0,0.12)",
            zIndex: 50,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              padding: "8px 12px",
              fontSize: 11,
              fontWeight: 600,
              color: "#9ca3af",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              borderBottom: "1px solid #f3f4f6",
            }}
          >
            {t("editor.history_title")}
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {loading && sessions.length === 0 ? (
              <div style={{ display: "flex", justifyContent: "center", padding: 16 }}>
                <Loader2 size={16} style={{ animation: "wf-spin 1s linear infinite", color: "#9ca3af" }} />
              </div>
            ) : sessions.length === 0 ? (
              <div style={{ padding: 16, textAlign: "center", fontSize: 12, color: "#9ca3af" }}>
                {t("editor.history_empty")}
              </div>
            ) : (
              grouped.map((group, gi) => (
                <div key={group.label}>
                  {gi > 0 && <div style={{ margin: "4px 12px", borderTop: "1px solid #f3f4f6" }} />}
                  <div
                    style={{
                      padding: "6px 12px 2px",
                      fontSize: 10,
                      fontWeight: 600,
                      color: "#d1d5db",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                    }}
                  >
                    {group.label}
                  </div>
                  {group.items.map((session) => (
                    <button
                      key={session.sessionId}
                      type="button"
                      onClick={() => handleSelectSession(session)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        width: "100%",
                        padding: "6px 12px",
                        border: "none",
                        background: session.sessionId === activeSessionId ? "#eff6ff" : "transparent",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 12,
                        color: session.sessionId === activeSessionId ? "#3b82f6" : "#374151",
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) => {
                        if (session.sessionId !== activeSessionId) e.currentTarget.style.background = "#f9fafb";
                      }}
                      onMouseLeave={(e) => {
                        if (session.sessionId !== activeSessionId) e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <MessageSquare size={13} style={{ flexShrink: 0, opacity: 0.5 }} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {session.title?.trim() || t("editor.history_untitled")}
                      </span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* 聊天区域 */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        <ChatPanel
          agentId={metaAgentId}
          hideSidebar
          scenePrompt={scenePrompt}
          onClientChange={setClient}
          onPromptComplete={onPromptComplete}
        />
      </div>
    </div>
  );
}
