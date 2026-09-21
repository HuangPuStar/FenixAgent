// ChatPanel.tsx —— 宿主侧的会话面板视图（CE 阶段 2 §1.6 T6d 从
// `packages/agent-runtime/web/agent-panel/ChatPanel.tsx` 归位宿主并按用户裁定拆成三份）。
//
// 为什么归位宿主：本组件是宿主接线层，依赖只属于宿主的 `@/src/lib/auth-client`（identity 的 web）、
// `@/src/hooks/*` 与 `@/src/i18n`，而 `.dependency-cruiser.cjs` 按 §2.3 禁止 agent-runtime 依赖
// 这些包/宿主模块（此前 6 处越界登记在台账里，T6d 随搬迁消失）。
// 拆分：本文件只做分支渲染与错误卡片；连接状态机在 `use-chat-panel-runtime.ts`，
// ui-components 面板的宿主端口在 `chat-panel-ports.tsx`。
//
// workflow 包的 `MetaAgentPanel` 曾从 `@fenix/agent-runtime` 根出口取 `ChatPanel`；包不得依赖 apps
// （`web-package-not-to-app`），故改为宿主经 `WorkflowEditor` 的 `chatPanel` 端口注入——与
// `ProdViewPage` 的 `chatArea` 端口同型（用户 2026-09-21 裁定）。

import type { PublicErrorInfo } from "@fenix/chat-channel";
import { ACPMain } from "@fenix/ui-components/chat/shell/ACPMain";
import type { BoundMcpOption } from "@fenix/ui-components/chat/shell/chat-interface-types";
import { TooltipProvider } from "@fenix/ui-components/ui/tooltip";
import { Bot, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";
import { useChatPanelPorts } from "./chat-panel-ports";
import { useChatPanelRuntime } from "./use-chat-panel-runtime";

interface ChatPanelProps {
  agentId: string | null;
  sessionId?: string | null;
  hideSidebar?: boolean;
  scenePrompt?: string;
  contextKey?: string;
  onPromptComplete?: () => void;
  /**
   * 已绑定 MCP 列表（透传给 ui-components 面板的 `boundMcps` 端口）。
   *
   * 取数在宿主容器：`agent-config/web` 的 `loadBoundMcps` 只能由宿主容器调用——`.dependency-cruiser.cjs`
   * 的 `agent-runtime-not-to-resources` 禁止 agent-runtime 包依赖 resources（含 `agent-config`）。
   * 未注入时命令菜单只显示 ACP 命令、不含 MCP 条目。
   */
  boundMcps?: readonly BoundMcpOption[];
}

export function ChatPanel({
  agentId,
  sessionId,
  hideSidebar,
  scenePrompt,
  contextKey,
  onPromptComplete,
  boundMcps,
}: ChatPanelProps) {
  const { t } = useTranslation(NS.AGENT_PANEL);
  const {
    authState,
    connectionState,
    classifiedError,
    actionError,
    autoReconnecting,
    rcsSessionKey,
    chatState,
    sessionState,
    periTasks,
    periTasksLoaded,
    derivedState,
    callbacks,
  } = useChatPanelRuntime({ agentId, sessionId });

  // 宿主端口（纯化后由 ui-components 的 chat 外壳注入；实现与来源见 chat-panel-ports.tsx）
  const ports = useChatPanelPorts({ agentId, sessionId });

  // 未选中实例 → 欢迎空状态
  if (!agentId) {
    return (
      <div className="agent-welcome-empty">
        <Bot className="h-16 w-16" />
        <p className="title">{t("selectAgent")}</p>
        <p className="desc">{t("selectAgentDesc")}</p>
      </div>
    );
  }

  // 错误状态
  if ((connectionState === "error" || connectionState === "disconnected") && classifiedError) {
    return <PublicErrorCard error={classifiedError} className="agent-welcome-empty" />;
  }

  // 登录态未就绪（user session 加载中）——与"连接中"（WS 建连）语义分离，
  // 避免 auth 悬挂时 UI 永驻"正在连接 Agent"转圈
  if (authState === "loading") {
    return (
      <div className="agent-welcome-empty">
        <Loader2 className="h-8 w-8 animate-spin text-brand" />
        <p className="title">{t("loadingUser")}</p>
      </div>
    );
  }

  // 登录态失败（useSession 报错 / 未登录）——明确错误态 + 重试出口
  if (authState === "failed") {
    return (
      <div className="agent-welcome-empty">
        <p className="title">{t("authFailed")}</p>
        <p className="desc">{t("authFailedDesc")}</p>
      </div>
    );
  }

  // 连接中
  if (connectionState === "connecting") {
    return (
      <div className="agent-welcome-empty">
        <Loader2 className="h-8 w-8 animate-spin text-brand" />
        <p className="title">{t("connectingAgent")}</p>
      </div>
    );
  }

  // 已连接 → 渲染 ACPMain
  if (connectionState === "connected") {
    return (
      <TooltipProvider>
        {classifiedError && <PublicErrorCard error={classifiedError} />}
        {actionError && <PublicErrorCard error={actionError.error} />}
        {sessionState.agentPublicError &&
          sessionState.agentPublicError.id !== classifiedError?.id &&
          sessionState.agentPublicError.id !== actionError?.error.id && (
            <PublicErrorCard error={sessionState.agentPublicError} />
          )}
        <ACPMain
          agentId={agentId}
          hideSidebar={hideSidebar}
          // 此处必须是 RCS session id（与 Y.Doc 命名一致），不是 URL sessionId：
          rcsSessionId={rcsSessionKey ?? undefined}
          detailSessionId={sessionId ?? undefined}
          scenePrompt={scenePrompt}
          contextKey={contextKey}
          onPromptComplete={onPromptComplete}
          chatState={chatState}
          sessionState={sessionState}
          connectionState={connectionState}
          // Peri Task 视图（切片 2）：会话活动面板数据，经 ACPMain 透传给 ChatInterface
          periTasks={periTasks}
          periTasksLoaded={periTasksLoaded}
          supportsImages={derivedState.supportsImages}
          supportsLoadSession={derivedState.supportsLoadSession}
          modelName={derivedState.modelName}
          tokenUsage={derivedState.tokenUsage}
          availableCommands={derivedState.availableCommands}
          availableModes={derivedState.availableModes}
          currentModeId={derivedState.currentModeId}
          supportsModeSelection={derivedState.supportsModeSelection}
          boundMcps={boundMcps}
          {...callbacks}
          {...ports}
        />
      </TooltipProvider>
    );
  }

  // 断开仅表示连接生命周期；状态机可自行重连，不生成业务错误或恢复操作。
  return (
    <div className="agent-welcome-empty">
      <p className="title">{autoReconnecting ? t("reconnecting") : t("agentDisconnected")}</p>
      <p className="desc">{autoReconnecting ? t("reconnectingDesc") : t("agentOfflineDesc")}</p>
    </div>
  );
}

function PublicErrorCard({ error, className }: { error: PublicErrorInfo; className?: string }) {
  // 标题取 `uiComponents` 命名空间：同一张卡片（同样的 class、`role="alert"`、Type/ID 尾注）在
  // `@fenix/ui-components` 的 `MessageBubble` 里渲染 turn 失败错误，键 `chat.components.messageBubble.turnError`
  // 的 owner 是该包；宿主旧的 `components.messageBubble.*` 子树在 T6 搬迁后已无宿主消费方（T9c 收敛）。
  // 命名空间常量经中心表 `NS.UI_COMPONENTS` 取，与 `NS.AGENTS` 等宿主消费包命名空间的先例一致。
  const { t } = useTranslation(NS.UI_COMPONENTS);
  return (
    <div
      className={
        className ??
        "mx-4 mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      }
      role="alert"
    >
      <p className="font-medium">{t("chat.components.messageBubble.turnError")}</p>
      <p className="mt-1 whitespace-pre-wrap">{error.message}</p>
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1">
        <span className="break-all">Type: {error.type}</span>
        <span className="break-all">ID: {error.id}</span>
      </div>
    </div>
  );
}
