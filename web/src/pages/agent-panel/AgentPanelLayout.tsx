import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { AgentConfigDialog } from "./AgentConfigDialog";
import { AgentCreateDialog } from "./AgentCreateDialog";
import { AgentSidebar } from "./AgentSidebar";
import "./agent-panel.css";

export function AgentPanelLayout() {
  const navigate = useNavigate();
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;

  console.log('[AgentPanelLayout Debug] Render:', { pathname });

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [configDialog, setConfigDialog] = useState<{ open: boolean; agentName: string }>({
    open: false,
    agentName: "",
  });

  const activeNav = (() => {
    const segment = pathname.replace("/ctrl/agent/", "").split("/")[0];
    if (segment === "chat" || segment === "" || pathname === "/ctrl/agent") return null;
    return segment;
  })();

  const handleNavigate = useCallback(
    (pageId: string) => {
      console.log('[AgentPanelLayout Debug] Navigating to:', pageId);
      void navigate({ to: `/agent/${pageId}` as never });
    },
    [navigate],
  );

  const handleSelectInstance = useCallback(
    (_instanceId: string, envId: string, sessionId: string | null) => {
      console.log('[AgentPanelLayout Debug] Selecting instance:', { envId, sessionId });
      if (sessionId) {
        void navigate({
          to: "/agent/chat/$agentId/$sessionId",
          params: { agentId: envId, sessionId },
        });
      } else {
        void navigate({
          to: "/agent/chat/$agentId",
          params: { agentId: envId },
        });
      }
    },
    [navigate],
  );

  return (
    <div className="agent-panel-layout">
      <AgentSidebar
        activeNav={activeNav}
        onSelectInstance={handleSelectInstance}
        onNavigate={handleNavigate}
        onCreateAgent={() => setCreateDialogOpen(true)}
        onEditAgent={(agentName) => setConfigDialog({ open: true, agentName })}
      />
      <div className="agent-panel-body">
        <Outlet />
      </div>
      <AgentCreateDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
      <AgentConfigDialog
        open={configDialog.open}
        onOpenChange={(open) => setConfigDialog((prev) => ({ ...prev, open }))}
        agentName={configDialog.agentName}
      />
    </div>
  );
}
