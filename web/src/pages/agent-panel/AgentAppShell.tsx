import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { PanelRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AgentCreateDialog } from "./AgentCreateDialog";
import { AgentSidebar } from "./AgentSidebar";
import { ChatPanel } from "./ChatPanel";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { StatusHeader } from "../../components/agent-panel/StatusHeader";
import type { ThreadEntry } from "../../../src/lib/types";
import "./agent-panel.css";

interface AgentAppShellProps {
  agentId: string;
  sessionId?: string;
}

export function AgentAppShell({ agentId, sessionId }: AgentAppShellProps) {
  const navigate = useNavigate();
  const { t } = useTranslation("agentPanel");
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(agentId);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(sessionId ?? null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  // Listen for stats broadcast from ChatInterface
  const [stats, setStats] = useState<{ agentName?: string; modelName?: string; entries: ThreadEntry[] }>({
    entries: [],
  });

  useEffect(() => {
    const handler = (e: Event) => {
      setStats((e as CustomEvent).detail);
    };
    window.addEventListener("chat:stats", handler);
    return () => window.removeEventListener("chat:stats", handler);
  }, []);

  const [artifactsCollapsed, setArtifactsCollapsed] = useState(() => {
    const saved = localStorage.getItem("agent-panel:artifacts-collapsed");
    return saved === "true";
  });

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches) {
        setArtifactsCollapsed(true);
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    localStorage.setItem("agent-panel:artifacts-collapsed", String(artifactsCollapsed));
  }, [artifactsCollapsed]);

  const handleSelectInstance = useCallback(
    (instanceId: string, envId: string, newSessionId: string | null) => {
      setSelectedInstanceId(instanceId);
      setSelectedAgentId(envId);
      setCurrentSessionId(newSessionId);
      if (newSessionId) {
        void navigate({ to: "/agent/$agentId/$sessionId", params: { agentId: envId, sessionId: newSessionId } });
      } else {
        void navigate({ to: "/agent/$agentId", params: { agentId: envId } });
      }
    },
    [navigate],
  );

  const handleNavigate = useCallback(
    (pageId: string) => {
      if (pageId === "dashboard") {
        void navigate({ to: "/" });
      } else if (pageId === "apikeys") {
        void navigate({ to: "/apikeys" });
      } else {
        void navigate({ to: `/${pageId}` });
      }
    },
    [navigate],
  );

  return (
    <div className="agent-panel-layout">
      <AgentSidebar
        selectedInstanceId={selectedInstanceId}
        onSelectInstance={handleSelectInstance}
        onNavigate={handleNavigate}
        onCreateAgent={() => setCreateDialogOpen(true)}
      />
      <div className="agent-panel-body">
        <StatusHeader
          agentName={stats.agentName}
          modelName={stats.modelName}
          entries={stats.entries}
        />
        <div className="agent-panel-content">
          <div className="agent-chat-area">
            <ChatPanel agentId={selectedAgentId} sessionId={currentSessionId} />
          </div>
          <ArtifactsPanel
            collapsed={artifactsCollapsed}
            onToggleCollapse={() => setArtifactsCollapsed(!artifactsCollapsed)}
            envId={selectedAgentId}
          />
          {artifactsCollapsed && (
            <button
              type="button"
              className="agent-artifacts-expand-btn"
              onClick={() => setArtifactsCollapsed(false)}
              title={t("showArtifacts")}
            >
              <PanelRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      <AgentCreateDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
    </div>
  );
}
