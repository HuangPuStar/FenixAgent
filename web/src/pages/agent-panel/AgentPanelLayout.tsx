import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { AgentFormDialog } from "./AgentFormDialog";
import { AgentSidebar } from "./AgentSidebar";
import { ChatArea } from "./ChatArea";
import "./agent-panel.css";

export function AgentPanelLayout() {
  const navigate = useNavigate();
  // 仅订阅 pathname：避免 useRouterState() 无选择器订阅全部路由状态
  // 导致每次 search/hash/loader 变动都触发级联重渲染
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const pathParts = pathname
    .replace(/^\/agent\/?/, "")
    .split("/")
    .filter(Boolean);

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [configDialog, setConfigDialog] = useState<{ open: boolean; agentName: string }>({
    open: false,
    agentName: "",
  });

  const activeNav = (() => {
    const segment = pathParts[0] ?? "";
    if (segment === "" || segment === "home" || pathname === "/agent") return "home";
    if (segment === "chat") return null;
    return segment;
  })();
  const selectedEnvironmentId = pathParts[0] === "chat" ? (pathParts[1] ?? null) : null;

  const handleNavigate = useCallback(
    (pageId: string) => {
      void navigate({ to: `/agent/${pageId}` as never });
    },
    [navigate],
  );

  const handleSelectInstance = useCallback(
    (_instanceId: string, envId: string, sessionId: string | null) => {
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

  // ── Chat keep-alive：始终渲染 ChatArea，仅通过 CSS 切换可见性 ──
  //   从 URL 解析 agentId/sessionId，仅在用户主动进入 chat 路由时更新；
  //   切到非 chat 页面时保留上次的 agentId，ChatPanel 保持挂载/连接。
  const isChatRoute = pathParts[0] === "chat";
  const chatAgentId = isChatRoute ? (pathParts[1] ?? null) : null;
  const chatSessionId = isChatRoute ? (pathParts[2] ?? null) : null;

  const lastChatAgentRef = useRef<string | null>(null);
  const lastChatSessionRef = useRef<string | null>(null);
  if (chatAgentId) {
    lastChatAgentRef.current = chatAgentId;
    lastChatSessionRef.current = chatSessionId;
  }

  return (
    <div className="agent-panel-layout">
      <AgentSidebar
        activeNav={activeNav}
        selectedEnvironmentId={selectedEnvironmentId}
        onSelectInstance={handleSelectInstance}
        onNavigate={handleNavigate}
        onCreateAgent={() => setCreateDialogOpen(true)}
        onEditAgent={(agentName) => setConfigDialog({ open: true, agentName })}
      />
      <div className="agent-panel-body">
        <Outlet />
        <ChatArea agentId={lastChatAgentRef.current} sessionId={lastChatSessionRef.current} visible={isChatRoute} />
      </div>
      <AgentFormDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} mode="create" />
      <AgentFormDialog
        open={configDialog.open}
        onOpenChange={(open) => setConfigDialog((prev) => ({ ...prev, open }))}
        mode="edit"
        agentName={configDialog.agentName}
      />
    </div>
  );
}
