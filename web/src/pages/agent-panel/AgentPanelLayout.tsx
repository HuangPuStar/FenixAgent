import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { type EnterEnvironmentResponse, type EnvironmentDetail, envApi } from "@/src/api/environments";
import { unwrap } from "@/src/api/request";
import { dispatchConfigChange } from "../../lib/config-events";
import { AgentSidebar } from "./AgentSidebar";
import { AgentFormDialog } from "./agent-editor/AgentFormDialog";
import { ChatArea } from "./ChatArea";
import "./agent-panel.css";

interface CreatedAgentEnvironmentGateway {
  list: () => Promise<EnvironmentDetail[]>;
  create: (body: { name: string; agentConfigId: string; autoStart: boolean }) => Promise<EnvironmentDetail>;
  enter: (environmentId: string) => Promise<EnterEnvironmentResponse>;
}

/** 新建 Agent 后确保关联到真实 Instance，再生成聊天路由目标。 */
export async function resolveCreatedAgentChatTarget(
  agentConfigId: string,
  gateway: CreatedAgentEnvironmentGateway,
): Promise<{ environmentId: string; instanceUid: string }> {
  const environments = await gateway.list();
  const existingEnvironment = environments.find((environment) => environment.agentConfigId === agentConfigId);
  const environment =
    existingEnvironment ??
    (await gateway.create({
      name: `env-${agentConfigId.slice(0, 8)}`,
      agentConfigId,
      autoStart: true,
    }));
  const entered = await gateway.enter(environment.id);
  return { environmentId: entered.environmentId ?? environment.id, instanceUid: entered.instanceUid };
}

export function AgentPanelLayout() {
  const navigate = useNavigate();
  // 仅订阅 pathname：避免 useRouterState() 无选择器订阅全部路由状态
  // 导致每次 search/hash/loader 变动都触发级联重渲染
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const pathParts = pathname
    .replace(/^\/agent\/?/, "")
    .split("/")
    .filter(Boolean);

  const [panelHost, setPanelHost] = useState<HTMLDivElement | null>(null);
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

  // 新建智能体成功后，确保进入真实实例并导航到聊天页
  const handleCreateSuccess = useCallback(
    async (agentConfigId?: string) => {
      if (!agentConfigId) return;
      try {
        const target = await resolveCreatedAgentChatTarget(agentConfigId, {
          list: async () => {
            const environments = await unwrap(envApi.list());
            return Array.isArray(environments) ? environments : [];
          },
          create: async (body) => unwrap(envApi.create(body)),
          enter: async (environmentId) => unwrap(envApi.enter({ id: environmentId })),
        });
        void navigate({
          to: "/agent/chat/$agentId/$sessionId",
          params: { agentId: target.environmentId, sessionId: target.instanceUid },
        });
        dispatchConfigChange("agents");
      } catch (e) {
        console.error("创建智能体后导航失败:", e);
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
      <div className="agent-panel-body" ref={setPanelHost}>
        <Outlet />
        <ChatArea agentId={lastChatAgentRef.current} sessionId={lastChatSessionRef.current} visible={isChatRoute} />
      </div>
      <AgentFormDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        mode="create"
        portalContainer={panelHost}
        onSuccess={handleCreateSuccess}
      />
      <AgentFormDialog
        open={configDialog.open}
        onOpenChange={(open) => setConfigDialog((prev) => ({ ...prev, open }))}
        mode="edit"
        agentName={configDialog.agentName}
        portalContainer={panelHost}
      />
    </div>
  );
}
