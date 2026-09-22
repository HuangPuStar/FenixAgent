/**
 * ChatInterface — 会话消息区 + 输入岛 + 上下文面板的组合容器。
 *
 * 来源：逐字复制 `packages/chat-channel/web/components/ChatInterface.tsx`（结构、类名、交互与文案不变）。
 * 纯化改动点：
 * - 包内 API 客户端（`envApi` / `agentApi` / `mcpApi` / `unwrap`）与 agent 配置查询逻辑移除，
 *   绑定 MCP 列表改为 `boundMcps` prop 由宿主注入（原查询链见 `ChatInterfaceProps.boundMcps`）。
 * - `ChatStatsDispatcher` + window `chat:stats` 事件改为 `onStatsChange` 回调（节流/幂等交给宿主）。
 * - sonner `toast` 改为 `onNotice` 回调；`localStorage` 会话记忆移出组件（见 `onSessionCreated`）。
 * - `structuredToThreadEntries`（依赖 YJS doc 助手 + i18n 单例的传输/持久化投影层）改为
 *   `projectEntries` 注入。
 * - 提交链路抽到 `./internal/use-chat-input-submit`、调试快照抽到 `./internal/use-debug-snapshot`
 *   （单文件 500 行约束）；类型与工具函数全部改为包内导入，i18n 收敛到 `UI_COMPONENTS_NS`。
 * - 空状态建议提示词与消息「引用」原经 window 事件回到 ChatComposer，纯化后由
 *   `./internal/use-composer-input-bridge` 在包内自闭合（把包内事件汇入宿主注入的
 *   `subscribeExternal` 通道，见该文件说明）。
 * - `loadPeriTaskDetail` 端口与 `PeriTaskDetailSheet` 详情抽屉一并移除（2026-09-18）：`PeriTask*`
 *   三件套源自 `agent-runtime`，在 `apps/web` 无对应实现，属旧组件。`ChatStatusPanel` 的 tasks Tab
 *   仍在（`periTasks` / `periTasksLoaded` 保留）；详情入口改由 `renderPeriTaskDetail` 注入槽承接
 *   （宿主渲染自己的抽屉），未注入时任务行只读。
 * - `ContextPanel` 右栏与其开关一并移除（2026-09-18）：该面板源自 `chat-channel`，`apps/web` 从不渲染它
 *   （宿主走自己的 `apps/web/src/pages/agent-panel/ChatArea.tsx`，CE 阶段 2 任务 1.6 T5b 起由该处接管），
 *   源 ACPMain 也一直传 `hideContextPanel={true}`。
 *   `hideContextPanel` prop 随之删除；`renderEntries` / `promptUsage` 仍被状态面板与输入岛上下文计使用。
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { Button } from "../../ui/button";
import { ChatComposer } from "../composer/ChatComposer";
import { derivePendingPermissions, deriveTodoItems } from "../lib/chat-derived-state";
import { extractChangedFiles } from "../lib/extract-changed-files";
import { classifyToolSemantic } from "../lib/tool-semantic";
import { ChatStatusPanel } from "../panels/chat-status-panel";
import { PermissionPanel } from "../panels/PermissionPanel";
import { QuestionPanel } from "../panels/QuestionPanel";
import type { PeriTaskViewProjection, ThreadEntry, TokenUsage } from "../types";
import { ChatView } from "../view/ChatView";
import type { ChatInterfaceHandle, ChatInterfaceProps } from "./chat-interface-types";
import { useChatInputSubmit } from "./internal/use-chat-input-submit";
import { useComposerInputBridge } from "./internal/use-composer-input-bridge";
import { useChatDebugSnapshot } from "./internal/use-debug-snapshot";

export type { ChatInterfaceHandle } from "./chat-interface-types";

/** ChatInterface 组件。复制自源 `ChatInterface.tsx`；纯化改动点见文件头。 */
export const ChatInterface = forwardRef<ChatInterfaceHandle, ChatInterfaceProps>(function ChatInterface(
  {
    agentId,
    readonly,
    rcsSessionId,
    detailSessionId,
    onSessionCreated,
    scenePrompt,
    contextKey,
    onPromptComplete: _onPromptComplete,
    sessionState,
    chatState,
    onSendPrompt,
    onCancel,
    onCreateSession,
    onRespondPermission,
    onRespondQuestion,
    availableCommands,
    availableModes,
    currentModeId,
    onSetMode,
    supportsModeSelection: _supportsModeSelection,
    supportsImages,
    modelName,
    tokenUsage,
    periTasks = [],
    periTasksLoaded = false,
    renderPeriTaskDetail,
    connectionState,
    boundMcps = [],
    projectEntries,
    flushContext,
    onNotice,
    onStatsChange,
    onOpenWorkspaceFile,
    uploadFiles,
    compressImage,
    renderFilePicker,
    subscribeExternal,
  },
  ref,
) {
  const { t } = useTranslation(UI_COMPONENTS_NS);

  // ── YJS-driven computed state ──

  // 从 Yjs chatState 获取当前活跃会话 ID
  const activeSessionId = chatState?.activeSessionId ?? null;
  const composerContextScope = rcsSessionId ?? activeSessionId ?? undefined;

  // 从 Yjs sessionState 计算 loading 状态
  const isLoading = sessionState?.loading != null;

  // turn 是否可取消（accepting/running/awaiting_permission）：驱动 ChatComposer 停止按钮。
  // 与 loading 正交——running 正文流式输出期间 loading 保持非空（输出中指示器不消失），
  // 停止按钮可用性必须由 canCancel 独立保证，不可回退到 Send 按钮
  const canCancel = sessionState?.canCancel ?? false;

  // 会话系统就绪（可输入）：session.status 仅在 create/load 成功后投影为 "ready"，
  // 无历史会话时为 null——此时输入框必须可用，由提交链路懒创建会话
  // （否则无会话场景输入被禁用、懒创建永不触发，页面死锁在"等待会话..."）。
  // 仅明确处于 "initializing"（会话系统初始化中，当前 acp-link 不下发该会话级
  // 状态，保留为防御分支）时禁用输入；turn 展示态只驱动 loading/canCancel。
  const sessionReady = sessionState?.sessionStatus !== "initializing";

  // 从 Yjs structuredMessages 计算渲染用的 ThreadEntry[]
  // 依赖收窄到 structuredMessages 引用本身：快照中其他字段（loading/canCancel 等）
  // 变化不再触发整条时间线 O(N) 重建，这是流式期间渲染链的主要成本来源。
  // 投影函数（源为宿主 `structuredToThreadEntries`，依赖 YJS doc 助手与 i18n 单例）由宿主注入。
  const structuredMessages = sessionState?.structuredMessages;
  const renderEntries: ThreadEntry[] = useMemo(() => {
    if (!structuredMessages?.length || !projectEntries) return [];
    return projectEntries(structuredMessages);
  }, [structuredMessages, projectEntries]);

  // ── Refs & retained local state (YJS does not yet carry these fields) ──

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 追踪用户主动取消操作，避免取消后触发错误提示
  const userCancelledRef = useRef(false);
  // ACP 返回的真实 token 用量（prompt/complete 响应），供输入岛上下文计展示
  const [promptUsage, setPromptUsage] = useState<TokenUsage | null>(null);

  // Notify parent when active session changes
  // （源同时把会话 ID 写入 localStorage 键 `acp_last_session_<agentId>`；该持久化属宿主策略，已移出组件，
  //   宿主可在此回调中自行落盘。）
  useEffect(() => {
    if (activeSessionId) {
      onSessionCreated?.(activeSessionId);
    }
  }, [activeSessionId, onSessionCreated]);

  // ── Core operations ──

  const resetThreadState = useCallback(() => {
    setErrorMessage(null);
    if (errorTimerRef.current) {
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    userCancelledRef.current = false;
    setPromptUsage(null);
  }, []);

  const requestCreateSession = useCallback(async () => {
    await onCreateSession();
  }, [onCreateSession]);

  // ── 输入岛外部事件的包内环路 ──
  // 空状态建议提示词与消息「引用」由 ChatView 产生、ChatComposer 消费，源实现经 window
  // 自定义事件回环；这里把包内事件并入宿主注入的订阅通道（见 `./internal/use-composer-input-bridge`）。
  const { subscribe: composerSubscribe, emit: emitComposerInput } = useComposerInputBridge(subscribeExternal);

  // 建议提示词：替换草稿正文（ChatComposer 侧语义）。
  const handleApplySuggestedPrompt = useCallback(
    (prompt: string) => emitComposerInput({ type: "suggested-prompt", prompt }),
    [emitComposerInput],
  );

  // 消息引用：追加一条待发送引用（配额判断与截断在 ChatComposer 内）。
  const handleQuote = useCallback(
    (text: string) => emitComposerInput({ type: "quote", quote: { text } }),
    [emitComposerInput],
  );

  // 提交链路（归一化 ContentBlock[] + 无会话时缓存 prompt 并等待就绪）
  const handleChatInputSubmit = useChatInputSubmit({
    isLoading,
    activeSessionId,
    scenePrompt,
    contextScope: composerContextScope,
    flushContext,
    // 输入岛与发送边界共用同一个压缩端口（缺这里发送路径就丢失 >2MiB 图片的二次压缩）
    compressImage,
    onCreateSession,
    onSendPrompt,
    onNotice,
    imagePrepareFailedMessage: t("chat.components.composerAssets.prepareImageFailed"),
  });

  // Todo 面板状态 — 从当前聊天渲染条目中提取最新 TodoWrite 工具调用。
  // 使用 renderEntries 而不是直接读取 structuredMessages，确保输入框上方的 Todo
  // 列表与当前消息投影保持一致；执行计划等非消息条目不会影响此列表。
  const todoItems = useMemo(() => deriveTodoItems(renderEntries), [renderEntries]);

  // 会话内被 Agent 修改过的文件列表 — 供状态面板展示与统计摘要回调消费
  const changedFiles = useMemo(() => extractChangedFiles(renderEntries), [renderEntries]);

  // 会话统计摘要出口。源实现经 ChatStatsDispatcher 派发 window `chat:stats`
  // （幂等签名跳过 / 1s trailing 节流 / 卸载时 flush 补发最终态），纯化后由宿主决定节流策略
  // （宿主可直接复用 `ChatStatsDispatcher` 作为 onStatsChange 的实现）。
  useEffect(() => {
    onStatsChange?.({
      agentName: agentId,
      modelName,
      entryCount: renderEntries.length,
      changedFiles,
    });
  }, [agentId, modelName, renderEntries, changedFiles, onStatsChange]);

  // =============================================================================
  // User Actions
  // =============================================================================

  // Creates a new session by clearing current state and calling new_session
  const handleNewSession = useCallback(() => {
    // 正在等待 agent 响应时，阻止新建会话以避免状态混乱
    if (isLoading) {
      onNotice?.({ level: "warning", message: t("chat.components.acpMain.chatBusy") });
      return;
    }

    resetThreadState();
    // Create new session — YJS will update chatState.activeSessionId
    requestCreateSession();
  }, [isLoading, resetThreadState, requestCreateSession, t, onNotice]);

  // 当 contextKey 变化时自动开始新会话（仅在 contextKey 有值且发生变化时触发）
  const contextKeyRef = useRef(contextKey);
  useEffect(() => {
    if (contextKey !== undefined && contextKeyRef.current !== undefined && contextKeyRef.current !== contextKey) {
      handleNewSession();
    }
    contextKeyRef.current = contextKey;
  }, [contextKey, handleNewSession]);

  useImperativeHandle(
    ref,
    () => ({
      newSession: handleNewSession,
      isLoading,
    }),
    [handleNewSession, isLoading],
  );

  // Cancel handler - send cancel notification to agent.
  // Tool call status updates come from YJS sessionState.
  const handleCancel = useCallback(() => {
    // 标记为用户主动取消，后续错误提示不弹出
    userCancelledRef.current = true;
    // Send cancel notification to server (which forwards to agent)
    onCancel();
    // Note: isLoading is now computed from YJS sessionState.loading.
    // The server will clear loading state upon cancel completion.
    // Safety: if agent is dead and loading never clears, server handles the timeout.
  }, [onCancel]);

  // =============================================================================
  // Render helpers
  // =============================================================================

  // Collect pending permissions from YJS chatState
  // ask-user-question 由 QuestionPanel 承接：过滤判定由本层注入（源实现在 lib 内固定过滤，
  // 包内改为注入以保证 lib 不依赖宿主分类器）。
  const pendingPermissions = useMemo(
    () =>
      derivePendingPermissions(chatState?.permissions, {
        shouldSuppress: (tool) => classifyToolSemantic({ name: tool }) === "ask-user-question",
      }),
    [chatState?.permissions],
  );

  // AskUserQuestion 待应答问题（Session Doc pendingQuestions 投影，已过滤 pending+未过期）：
  // 依赖收窄到 Map 引用本身（快照中其他字段变化不触发重建）
  const pendingQuestions = useMemo(() => {
    const map = sessionState?.pendingQuestions;
    if (!map || map.size === 0) return [];
    return Array.from(map.values());
  }, [sessionState?.pendingQuestions]);

  // 按 Ctrl + Alt + Shift + D 即时输出当前完整状态快照。对象结构全部保留，
  // 仅递归遮蔽密钥、token、密码、cookie 等敏感字段。
  useChatDebugSnapshot(() => ({
    capturedAt: new Date(),
    props: {
      agentId,
      readonly,
      rcsSessionId,
      detailSessionId,
      availableCommands,
      availableModes,
      currentModeId,
      supportsImages,
      modelName,
      tokenUsage,
      periTasks,
      periTasksLoaded,
      connectionState,
    },
    derivedState: {
      activeSessionId,
      isLoading,
      canCancel,
      sessionReady,
      pendingPermissions,
      pendingQuestions,
      renderEntries,
      promptUsage,
      errorMessage,
    },
    chatState,
    sessionState,
  }));

  // 详情抽屉的选中态由本组件持有，抽屉内容由宿主经 `renderPeriTaskDetail` 渲染（见文件头与 README「收录范围」）。
  const [selectedPeriTask, setSelectedPeriTask] = useState<PeriTaskViewProjection | null>(null);

  return (
    <div className="chat-interface-root flex h-full min-h-0 min-w-0 flex-1">
      {/* chat-interface-column 保留为类名：`web/chat/css/chat-layout.css`（下一阶段迁移）与宿主同款
          样式表仍以它作为「唯一高度链」选择器；本行新增的几何工具类即原 `chat-design-shell.css` 的声明。 */}
      <div className="chat-interface-column relative flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden bg-white">
        {/* Peri Task 详情抽屉（宿主渲染；未注入时任务行只读） */}
        {renderPeriTaskDetail && selectedPeriTask
          ? renderPeriTaskDetail(selectedPeriTask, () => setSelectedPeriTask(null))
          : null}

        {/* Chat messages — unified ChatView */}
        <ChatView
          entries={renderEntries}
          isLoading={isLoading && !sessionReady ? false : isLoading}
          emptyTitle={sessionReady ? t("chat.components.chatEmpty.startConversation") : undefined}
          emptyDescription={sessionReady ? t("chat.components.chatEmpty.startConversationDesc") : undefined}
          sessionId={rcsSessionId ?? activeSessionId ?? undefined}
          envId={agentId}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
          onApplySuggestedPrompt={handleApplySuggestedPrompt}
          onQuote={handleQuote}
        />

        <div className="relative z-20 shrink-0 bg-white">
          {/* 交互区域只显示一种状态：阻塞型权限/提问覆盖非阻塞任务状态。 */}
          {pendingPermissions.length > 0 ? (
            <PermissionPanel requests={pendingPermissions} onRespond={onRespondPermission} />
          ) : pendingQuestions.length > 0 ? (
            <QuestionPanel questions={pendingQuestions} onRespond={onRespondQuestion} />
          ) : (
            <ChatStatusPanel
              todos={todoItems}
              tasks={periTasks}
              tasksLoaded={periTasksLoaded}
              reconnecting={Boolean(connectionState && connectionState !== "connected")}
              changedFiles={changedFiles}
              onOpenTask={renderPeriTaskDetail ? setSelectedPeriTask : undefined}
              onPreviewFile={agentId && onOpenWorkspaceFile ? (path) => onOpenWorkspaceFile(agentId, path) : undefined}
            />
          )}

          {/* Error banner */}
          {errorMessage && (
            <div className="mx-auto max-w-3xl w-full px-4 sm:px-8 pb-1">
              <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 px-3 py-2 text-sm text-red-700 dark:text-red-300 flex items-center justify-between">
                <span>{errorMessage}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setErrorMessage(null)}
                  className="ml-2 h-6 w-6 text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-200 flex-shrink-0"
                >
                  {"\u00D7"}
                </Button>
              </div>
            </div>
          )}

          {/* ChatComposer — 玻璃磨砂命令岛，整合输入框 + 元信息条 */}
          {!readonly && (
            <div className="flex-shrink-0">
              <ChatComposer
                onSubmit={handleChatInputSubmit}
                isLoading={isLoading}
                onInterrupt={handleCancel}
                canCancel={canCancel}
                disabled={!sessionReady}
                placeholder={
                  sessionReady
                    ? t("chat.components.chatInterface.agentPlaceholder")
                    : t("chat.components.chatInterface.waitingSession")
                }
                supportsImages={supportsImages}
                commands={availableCommands.length > 0 ? availableCommands : undefined}
                mcps={boundMcps}
                contextScope={composerContextScope}
                availableModes={availableModes}
                currentModeId={currentModeId}
                onModeChange={onSetMode}
                contextUsage={tokenUsage ?? promptUsage}
                onNewSession={handleNewSession}
                showNewSession={renderEntries.length > 0}
                modelName={modelName}
                uploadFiles={uploadFiles}
                compressImage={compressImage}
                renderFilePicker={renderFilePicker}
                subscribeExternal={composerSubscribe}
                onNotice={onNotice}
              />
            </div>
          )}
        </div>
        {readonly && (
          <div className="flex-shrink-0">
            <div className="max-w-3xl mx-auto w-full px-4 sm:px-8 py-3 text-center">
              <span className="text-xs text-text-muted">{t("chat.components.chatInterface.readonlyMode")}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
