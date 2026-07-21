import { useNavigate } from "@tanstack/react-router";
import { PanelRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePanelRef } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { envApi } from "@/src/api/environments";
import { unwrap } from "@/src/api/request";
import { dispatchConfigChange } from "../../lib/config-events";
import { AgentFormDialog } from "./AgentFormDialog";
import { AgentSidebar } from "./AgentSidebar";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { ChatPanel } from "./ChatPanel";
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

  // ArtifactsPanel 对应的 ResizablePanel imperative handle，由 toggle 按钮调用 collapse/expand
  const artifactsPanelRef = usePanelRef();
  const artifactsCollapsedRef = useRef(true);
  const [artifactsCollapsed, setArtifactsCollapsed] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches) artifactsPanelRef.current?.collapse();
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [artifactsPanelRef]);

  useEffect(() => {
    setSelectedAgentId(agentId);
    setCurrentSessionId(sessionId ?? null);
    setSelectedInstanceId(null);
  }, [agentId, sessionId]);

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
      void navigate({ to: `/agent/${pageId}` as never });
    },
    [navigate],
  );

  // 新建智能体成功后，自动查找/创建环境并导航到聊天页
  const handleCreateSuccess = useCallback(
    async (agentConfigId?: string) => {
      if (!agentConfigId) return;
      try {
        const envList = await unwrap(envApi.list());
        const existingEnv = (Array.isArray(envList) ? envList : []).find((e) => e.agentConfigId === agentConfigId);
        if (existingEnv) {
          void navigate({ to: "/agent/$agentId", params: { agentId: existingEnv.id } });
          dispatchConfigChange("agents");
          return;
        }
        const newEnv = await unwrap(
          envApi.create({
            name: `env-${agentConfigId.slice(0, 8)}`,
            agentConfigId,
            autoStart: true,
          }),
        );
        const envId = newEnv?.id;
        if (envId) {
          void navigate({ to: "/agent/$agentId", params: { agentId: envId } });
          dispatchConfigChange("agents");
        }
      } catch (e) {
        console.error("创建智能体后导航失败:", e);
      }
    },
    [navigate],
  );

  // Panel.onResize 同步折叠状态（仅在翻转时触发，避免拖拽中频繁 re-render）
  const handleArtifactsResize = useCallback(() => {
    const panel = artifactsPanelRef.current;
    if (!panel) return;
    const collapsed = panel.isCollapsed();
    if (collapsed !== artifactsCollapsedRef.current) {
      artifactsCollapsedRef.current = collapsed;
      setArtifactsCollapsed(collapsed);
    }
  }, [artifactsPanelRef]);

  const toggleArtifacts = useCallback(() => {
    const panel = artifactsPanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }, [artifactsPanelRef]);

  return (
    <div className="agent-panel-layout">
      <AgentSidebar
        activeNav={null}
        selectedInstanceId={selectedInstanceId}
        selectedEnvironmentId={selectedAgentId}
        onSelectInstance={handleSelectInstance}
        onNavigate={handleNavigate}
        onCreateAgent={() => setCreateDialogOpen(true)}
      />
      <div className="agent-panel-body">
        <div className="agent-panel-content">
          <ResizablePanelGroup orientation="horizontal" className="agent-panel-resizable">
            <ResizablePanel defaultSize="60%" minSize="30%">
              <div className="agent-chat-area">
                <ChatPanel agentId={selectedAgentId} sessionId={currentSessionId} />
              </div>
            </ResizablePanel>

            <ResizableHandle>
              <button
                type="button"
                className={`agent-artifacts-expand-btn${artifactsCollapsed ? "" : " open"}`}
                onClick={toggleArtifacts}
                title={artifactsCollapsed ? t("showArtifacts") : t("hideArtifacts")}
              >
                {artifactsCollapsed ? (
                  <PanelRight className="h-3.5 w-3.5" />
                ) : (
                  <PanelRight className="h-3.5 w-3.5 -scale-x-100" />
                )}
              </button>
            </ResizableHandle>

            <ResizablePanel
              panelRef={artifactsPanelRef}
              defaultSize="40%"
              minSize="20%"
              maxSize="70%"
              collapsible
              collapsedSize="0%"
              onResize={handleArtifactsResize}
            >
              <ArtifactsPanel envId={selectedAgentId} />
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>
      <AgentFormDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        mode="create"
        onSuccess={handleCreateSuccess}
      />
    </div>
  );
}
