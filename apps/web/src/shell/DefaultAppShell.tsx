// DefaultAppShell.tsx
// 默认 WebShell：控制台外壳的品牌区、侧栏、内容槽与聊天保活。
//
// **为什么落 `apps/web/src/shell/`**：全局布局属于应用壳而不属于任何资源模块（standards §4.1），
// 浏览器产物 `apps/generated/web-contributions.ts` 与 `apps/web/fenix.module.ts` 的
// `kind: "web-shell"` 又要求壳的实现有一个确定落点。本文件与 `AgentSidebar*` / `ArtifactsPanel` /
// 两份 CSS 在 §1.6 T11d 从 `pages/agent-panel/` 迁入本目录：它们只做品牌、布局、导航与容器，
// 不含任何资源模块的业务语义，留在 `pages/` 会与真正的资源页面混同。
//
// **与 `packages/*/web` 的边界**：外壳不实现业务能力，只消费各包贡献的导航声明（见
// `./shell-navigation.ts`）与路由目标。业务页面经 TanStack 文件路由挂在 `<Outlet/>` 上。

import { AgentFormDialog } from "@fenix/agent-config/web";
import { resolveCreatedAgentChatTarget } from "@fenix/agent-config/web/lib/agent-create-navigation";
import { envApi } from "@fenix/agent-runtime/web/api/environments";
import { unwrap } from "@fenix/web-runtime/api/request";
import { dispatchConfigChange } from "@fenix/web-runtime/lib/config-events";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { ChatArea } from "@/src/pages/agent-panel/ChatArea";
import { AgentSidebar } from "./AgentSidebar";
import "./agent-panel.css";

export function DefaultAppShell() {
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
  const [deletedEnvironmentIds, setDeletedEnvironmentIds] = useState<ReadonlySet<string>>(() => new Set());
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

  const handleDeleteAgentEnvironments = useCallback(
    (environmentIds: string[]) => {
      if (environmentIds.length === 0) return;
      setDeletedEnvironmentIds((current) => new Set([...current, ...environmentIds]));
      if (selectedEnvironmentId && environmentIds.includes(selectedEnvironmentId)) {
        lastChatAgentRef.current = null;
        lastChatSessionRef.current = null;
        void navigate({ to: "/agent/home" });
      }
    },
    [navigate, selectedEnvironmentId],
  );

  return (
    <div className="agent-panel-layout">
      <AgentSidebar
        activeNav={activeNav}
        selectedEnvironmentId={selectedEnvironmentId}
        selectedInstanceId={isChatRoute ? chatSessionId : lastChatSessionRef.current}
        onSelectInstance={handleSelectInstance}
        onNavigate={handleNavigate}
        onCreateAgent={() => setCreateDialogOpen(true)}
        onEditAgent={(agentName) => setConfigDialog({ open: true, agentName })}
        onDeleteAgentEnvironments={handleDeleteAgentEnvironments}
      />
      <div className="agent-panel-body" ref={setPanelHost}>
        <Outlet />
        <ChatArea
          agentId={lastChatAgentRef.current}
          sessionId={lastChatSessionRef.current}
          visible={isChatRoute}
          deletedEnvironmentIds={deletedEnvironmentIds}
        />
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
