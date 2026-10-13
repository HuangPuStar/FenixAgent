// ChatPanel.tsx —— chat 域的面板壳（CE 阶段 2 §1.6 T6d 曾从
// `packages/agent-runtime/web/agent-panel/ChatPanel.tsx` 归位宿主并按用户裁定拆成三份；
// 2026-09-25 随台账 `ce-standards-todo.md` D1 的归属裁定回到本包）。
//
// 为什么归本包：§9 的归属表把 Chat 整体划给 `@fenix/agent-runtime`，本组件是聊天面板本身（分支渲染 +
// 连接状态机 + ui-components 面板的端口装配），不是「把哪个 Environment 装进哪个面板」的宿主装配。
// T6d 曾因依赖 `@fenix/identity/web` 与宿主 `@/src/hooks/*`、`@/src/i18n` 而留在宿主；D1 把这些跨域能力
// 改为宿主注入（见 `chat-panel-host-ports.ts`）与包内字典后，本文件不再持有任何跨域依赖。
//
// 拆分（三份，各 ≤500 行）：本文件只做分支渲染与错误卡片；连接状态机在 `use-chat-panel-runtime.ts`，
// ui-components 面板的端口在 `chat-panel-ports.tsx`。
//
// 包不得依赖 apps（`web-package-not-to-app`）：宿主保留的槽位/keep-alive 装配在
// `apps/web/src/pages/agent-panel/ChatArea.tsx`，它经包出口 `@fenix/agent-runtime/web` 取本组件。

import { ACPMain } from "@fenix/ui-components/chat/shell/ACPMain";
import { PublicErrorCard } from "@fenix/ui-components/chat/view/PublicErrorCard";
import { UI_COMPONENTS_NS } from "@fenix/ui-components/i18n/namespace";
import { ErrorFallback } from "@fenix/ui-components/ui/error-fallback";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { TooltipProvider } from "@fenix/ui-components/ui/tooltip";
import { Bot } from "lucide-react";
import type { ReactNode } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { useTranslation } from "react-i18next";
import { AGENT_CHAT_NS } from "../i18n/namespace";
import type { ChatPanelHostPorts } from "./chat-panel-host-ports";
import { useChatPanelPorts } from "./chat-panel-ports";
import { useChatPanelRuntime } from "./use-chat-panel-runtime";

/**
 * 已连接会话内那几张错误卡片的外边距。
 *
 * 卡片本体在 `@fenix/ui-components`（`chat/view/PublicErrorCard`），按库内约定**不带外边距**——
 * 同一组件在 `MessageBubble` 里嵌在消息末尾、不需要外边距；本面板把它直接放在面板顶部，
 * 需要与消息区对齐的左右留白与顶距。三个调用点共用一份，避免同一间距写三遍而各自漂移。
 */
const INLINE_ERROR_CARD_CLASS = "mx-4 mt-3";

/**
 * 面板级空态骨架的容器：撑满面板的居中一列 + 12px 间距 + 提示色文字。
 *
 * 2026-09-28 之前这串取值是宿主 `apps/web/src/shell/agent-panel.css` 的 `.agent-welcome-empty`——
 * 包内组件读宿主的类名，属越界的样式契约（宿主改一处、包内静默错版）。收口后取值随实现归位到本包：
 * 12px 间距走 `gap-3`（`--spacing` 已在 `@theme` 按 px 落地，1 档 = 4px，`gap-3` 即 12px 设计值），
 * 三个消费点（空态骨架、断开态错误卡、登录失败）共用这一份，避免同一间距写三遍而各自漂移。
 *
 * 两处细节按原值搬：`h-full` 而不是 `flex-1`——本面板还会经 `chatPanel` 端口注入 workflow 编辑器，
 * 那里的宿主容器没有 flex 上下文；`text-text-muted` 传给 `PublicErrorCard` 时会经 `cn()`（tailwind-merge）
 * 压掉卡片自带的 `text-destructive`，与收口前 `.agent-welcome-empty` 的未分层覆写同效。
 *
 * 2026-10-10 修：文字色 token 是 `text-text-muted`（`--color-text-muted`，浅色 #94a3b8），**不是**
 * `text-muted`（`--color-muted: #f1f5f9` 是 shadcn 的**面色**档，浅色下近白）。收口时误写了面色档，
 * 于是空态标题/说明在白底上不可见；更糟的是传给 `PublicErrorCard` 时它同样压掉了 `text-destructive`
 * 却换成近白，整面板只剩 `bg-destructive/10` 的浅红底——即「红底白字看不见」的现场。
 * 判据：本仓库只有 `--color-text-*` 一族是文字色，`--color-muted`/`--color-secondary` 是面色（见 index.css）。
 */
const EMPTY_STATE_SHELL_CLASS = "flex h-full flex-col items-center justify-center gap-3 text-text-muted";

/**
 * 面板级空态骨架：「居中大图标 + 主文案 + 说明」。
 *
 * 2026-09-22 前端去重：未选中 agent、登录态失败、断开/重连中三个分支此前各写一份同样的 `<div>` +
 * `<p className="title">` + `<p className="desc">`，改文案时要在三处同步。收敛到本组件后，
 * 分支之间只剩「文案与要不要图标」的差别。
 *
 * 为什么没有改用库里的 `EmptyState`：那是两种不同的东西。`EmptyState` 是**内联**状态块
 * （`py-10 text-center`，24px 图标槽，标题 `text-sm`、说明 `text-xs`），而这里是**撑满整个面板**的
 * 欢迎/等待屏：`h-full` 的居中 flex + 64px 淡图标 + 16px 主文案是它的视觉主语。改用 `EmptyState`
 * 会同时发生两件不受欢迎的事：① 面板高度与居中要靠调用方 className 再复刻一遍，等于把重复换个地方写，
 * 且三处都要写；② 图标与标题整体降一档，整屏欢迎态变得像一条内联提示，而同一面板的错误分支用的是
 * 「占满面板」的 `PublicErrorCard`，两者会并排成两种版式。故此处按「克制」取舍：骨架留本地、不迁移版式。
 */
function PanelEmptyState({ icon, title, description }: { icon?: ReactNode; title: string; description?: string }) {
  return (
    <div className={EMPTY_STATE_SHELL_CLASS}>
      {icon}
      {/* 主文案 16px 走 `text-16`（px 档令牌，且不带行高；`text-base` 虽同为 16px，但会连带 1.5 的行高）。
          色取 `text-text-secondary`（#64748b）：`text-secondary` 是面色档（#f1f5f9），浅色下与白底同色。 */}
      <p className="text-16 font-semibold text-text-secondary">{title}</p>
      {description && <p className="text-13">{description}</p>}
    </div>
  );
}

export interface ChatPanelProps {
  agentId: string | null;
  sessionId?: string | null;
  hideSidebar?: boolean;
  scenePrompt?: string;
  contextKey?: string;
  onPromptComplete?: () => void;
  /**
   * 宿主注入的能力端口（登录态、Peri Task 订阅与详情取数、已绑定 MCP）。
   *
   * 必需项由宿主壳 `apps/web/src/pages/agent-panel/ChatArea.tsx` 组装一次并透传给每个 keep-alive 槽位；
   * 各字段为什么只能注入、注入什么，见 `chat-panel-host-ports.ts` 的边界说明。可选字段缺席时面板降级
   * 而非崩溃：无 `boundMcps` 时命令菜单只显示 ACP 命令，无 `loadPeriTaskDetail` 时任务行只读。
   */
  hostPorts: ChatPanelHostPorts;
}

export function ChatPanel(props: ChatPanelProps) {
  return (
    <ErrorBoundary
      FallbackComponent={ErrorFallback}
      onError={(error, info) => console.error("[ChatPanel] 渲染失败", error, info)}
    >
      <ChatPanelView {...props} />
    </ErrorBoundary>
  );
}

/**
 * 聊天交互面板（§7.1 放置矩阵第 3 行）：根组件裹一层错误边界，聊天区崩溃不牵连同屏的侧栏与输出面板。
 *
 * 边界裹在**导出**处而不是某个 `return` 上：本组件有欢迎态 / 错误卡 / 登录中 / 连接中 / 已连接五个出口，
 * 逐出口加边界既写五遍也漏掉 `useChatPanelRuntime` 这类运行时 hook 的抛错。降级 UI 取统一 `ErrorFallback`
 * （`panel` 形态，撑满原面板位置），重试即重新挂载整块面板。
 */
function ChatPanelView({
  agentId,
  sessionId,
  hideSidebar,
  scenePrompt,
  contextKey,
  onPromptComplete,
  hostPorts,
}: ChatPanelProps) {
  const { t } = useTranslation(AGENT_CHAT_NS);
  // 错误卡片的标题键 `chat.components.messageBubble.turnError` 归 ui-components 命名空间（卡片本体也在
  // 那个包里），故单独取一本字典；`tUi` 连同 error 一起喂给 `PublicErrorCard`。
  const { t: tUi } = useTranslation(UI_COMPONENTS_NS);
  const {
    authState,
    connectionState,
    classifiedError,
    actionError,
    autoReconnecting,
    terminalUiCode,
    rcsSessionKey,
    chatState,
    sessionState,
    periTasks,
    periTasksLoaded,
    derivedState,
    callbacks,
  } = useChatPanelRuntime({
    agentId,
    sessionId,
    authState: hostPorts.authState,
    userId: hostPorts.userId,
    usePeriTaskViews: hostPorts.usePeriTaskViews,
  });

  // 面板端口（纯化后由 ui-components 的 chat 外壳注入；实现与来源见 chat-panel-ports.tsx）
  const ports = useChatPanelPorts({ agentId, sessionId, loadPeriTaskDetail: hostPorts.loadPeriTaskDetail });

  // 未选中实例 → 欢迎空状态（图标 64px 淡描边：`opacity-30` 原在宿主的 `.agent-welcome-empty svg` 上）
  if (!agentId) {
    return (
      <PanelEmptyState
        icon={<Bot className="h-16 w-16 opacity-30" />}
        title={t("selectAgent")}
        description={t("selectAgentDesc")}
      />
    );
  }

  // 实例已停止（服务端 4002）：终态但**不是故障**——用户在侧栏主动停止的结果，重连不会恢复
  // （服务端持有停止意图，直到显式 restart），故此处不显示错误卡，只提示回侧栏重启实例。
  // 必须排在错误卡分支之前：`classifiedError` 是会话级残留值，早先任何一次 error 帧都会让它非空，
  // 排在后面会被它抢走（现象：主动停止被报成「Agent 实例启动失败。」红色满屏卡）。
  if (terminalUiCode === "instance_stopped") {
    return (
      <PanelEmptyState
        icon={<Bot className="h-16 w-16 opacity-30" />}
        title={t("instanceStopped")}
        description={t("instanceStoppedDesc")}
      />
    );
  }

  // 错误状态（容器形态复用空态骨架那一串：卡片自带底色与描边，缺的是居中与撑满）
  if ((connectionState === "error" || connectionState === "disconnected") && classifiedError) {
    return <PublicErrorCard error={classifiedError} t={tUi} className={EMPTY_STATE_SHELL_CLASS} />;
  }

  // 登录态未就绪（user session 加载中）——与"连接中"（WS 建连）语义分离，
  // 避免 auth 悬挂时 UI 永驻"正在连接 Agent"转圈。
  // `h-full` 与空态骨架同源（`EMPTY_STATE_SHELL_CLASS`）：`panel` 形态提供块级宽度与居中，
  // 而本面板还会经 `chatPanel` 端口注入 workflow 编辑器，那里的宿主容器没有 flex 上下文，`flex-1` 不生效。
  if (authState === "loading") {
    return <Spinner variant="panel" className="h-full" label={t("loadingUser")} />;
  }

  // 登录态失败（useSession 报错 / 未登录）——明确错误态 + 重试出口
  if (authState === "failed") {
    return <PanelEmptyState title={t("authFailed")} description={t("authFailedDesc")} />;
  }

  // 连接中
  if (connectionState === "connecting") {
    return <Spinner variant="panel" className="h-full" label={t("connectingAgent")} />;
  }

  // 已连接 → 渲染 ACPMain
  if (connectionState === "connected") {
    return (
      <TooltipProvider>
        {classifiedError && <PublicErrorCard error={classifiedError} t={tUi} className={INLINE_ERROR_CARD_CLASS} />}
        {actionError && <PublicErrorCard error={actionError.error} t={tUi} className={INLINE_ERROR_CARD_CLASS} />}
        {sessionState.agentPublicError &&
          sessionState.agentPublicError.id !== classifiedError?.id &&
          sessionState.agentPublicError.id !== actionError?.error.id && (
            <PublicErrorCard error={sessionState.agentPublicError} t={tUi} className={INLINE_ERROR_CARD_CLASS} />
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
          boundMcps={hostPorts.boundMcps}
          {...callbacks}
          {...ports}
        />
      </TooltipProvider>
    );
  }

  // 断开仅表示连接生命周期；状态机可自行重连，不生成业务错误或恢复操作。
  return (
    <PanelEmptyState
      title={autoReconnecting ? t("reconnecting") : t("agentDisconnected")}
      description={autoReconnecting ? t("reconnectingDesc") : t("agentOfflineDesc")}
    />
  );
}
