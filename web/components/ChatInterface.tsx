import type { ContentBlock, PeriTaskViewProjection, PromptUsage } from "@fenix/chat-channel";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ChatStatsDispatcher } from "../src/lib/chat-stats";
import { flushContext } from "../src/lib/context-queue";
import { extractChangedFiles } from "../src/lib/extract-changed-files";
import { structuredToThreadEntries } from "../src/lib/structured-to-thread";
import type { ChatInputMessage, ThreadEntry } from "../src/lib/types";
import { ContextPanel } from "./ContextPanel";
import { ChatComposer } from "./chat/ChatComposer";
import { ChatView } from "./chat/ChatView";
import { derivePendingPermissions, deriveTodoItems } from "./chat/chat-derived-state";
import { prepareImageContent } from "./chat/chat-image-content";
import type { ChatInterfaceHandle, ChatInterfaceProps } from "./chat/chat-interface-types";
import { ChatStatusPanel } from "./chat/chat-status-panel";
import { PeriTaskDetailSheet } from "./chat/PeriTaskDetailSheet";
import { PermissionPanel } from "./chat/PermissionPanel";
import { QuestionPanel } from "./chat/QuestionPanel";

import { Button } from "./ui/button";

export type { ChatInterfaceHandle } from "./chat/chat-interface-types";

export const ChatInterface = forwardRef<ChatInterfaceHandle, ChatInterfaceProps>(function ChatInterface(
  {
    agentId,
    readonly,
    hideContextPanel,
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
    connectionState,
  },
  ref,
) {
  const { t } = useTranslation("components");

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
  // 无历史会话时为 null——此时输入框必须可用，由 handleChatInputSubmit 懒创建会话
  // （否则无会话场景输入被禁用、懒创建永不触发，页面死锁在"等待会话..."）。
  // 仅明确处于 "initializing"（会话系统初始化中，当前 acp-link 不下发该会话级
  // 状态，保留为防御分支）时禁用输入；turn 展示态只驱动 loading/canCancel。
  const sessionReady = sessionState?.sessionStatus !== "initializing";

  // 从 Yjs structuredMessages 计算渲染用的 ThreadEntry[]
  // 依赖收窄到 structuredMessages 引用本身：快照中其他字段（loading/canCancel 等）
  // 变化不再触发整条时间线 O(N) 重建，这是流式期间渲染链的主要成本来源
  const structuredMessages = sessionState?.structuredMessages;
  const renderEntries: ThreadEntry[] = useMemo(() => {
    if (!structuredMessages?.length) return [];
    return structuredToThreadEntries(structuredMessages);
  }, [structuredMessages]);

  // ── Refs & retained local state (YJS does not yet carry these fields) ──

  const scenePromptUsedRef = useRef(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 追踪用户主动取消操作，避免取消后触发错误提示
  const userCancelledRef = useRef(false);
  // 缓存用户首次发送的 prompt，等 activeSessionId 就绪后自动发送
  const pendingSendRef = useRef<ContentBlock[] | null>(null);
  const pendingSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interfaceColumnRef = useRef<HTMLDivElement>(null);
  const inputDockRef = useRef<HTMLDivElement>(null);
  const [contextPanelOpen, setContextPanelOpen] = useState(true);
  // ACP 返回的真实 token 用量（prompt/complete 响应），用于 ContextPanel 优先展示
  const [promptUsage, setPromptUsage] = useState<PromptUsage | null>(null);

  // ── Side effects from YJS state changes ──

  // Reset scene prompt flag when session changes
  useEffect(() => {
    scenePromptUsedRef.current = false;
  }, []);

  useEffect(() => {
    const column = interfaceColumnRef.current;
    const dock = inputDockRef.current;
    if (!column || !dock) return;
    const updateClearance = () =>
      column.style.setProperty("--chat-input-clearance", `${Math.ceil(dock.offsetHeight + 8)}px`);
    updateClearance();
    const observer = new ResizeObserver(updateClearance);
    observer.observe(dock);
    return () => observer.disconnect();
  }, []);

  // Persist active session id to localStorage when it changes via YJS
  const storageKey = agentId ? `acp_last_session_${agentId}` : null;
  useEffect(() => {
    if (activeSessionId && storageKey) {
      try {
        localStorage.setItem(storageKey, activeSessionId);
      } catch {}
    }
  }, [activeSessionId, storageKey]);

  // Notify parent when active session changes
  useEffect(() => {
    if (activeSessionId) {
      onSessionCreated?.(activeSessionId);
    }
  }, [activeSessionId, onSessionCreated]);

  // 当 activeSessionId 从无到有时（首次发送自动创建会话），发送缓存的 prompt
  useEffect(() => {
    if (activeSessionId && pendingSendRef.current) {
      const blocks = pendingSendRef.current;
      pendingSendRef.current = null;
      if (pendingSendTimerRef.current) {
        clearTimeout(pendingSendTimerRef.current);
        pendingSendTimerRef.current = null;
      }
      userCancelledRef.current = false;
      onSendPrompt(blocks).catch((err) => {
        console.error("[ChatInterface] Pending send failed:", err);
      });
    }
  }, [activeSessionId, onSendPrompt]);

  // 组件卸载或 contextKey 变化时清理 pending prompt（避免内存泄漏 / 错误发送）
  useEffect(() => {
    return () => {
      pendingSendRef.current = null;
      if (pendingSendTimerRef.current) {
        clearTimeout(pendingSendTimerRef.current);
        pendingSendTimerRef.current = null;
      }
    };
  }, []);

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

  // Todo 面板状态 — 从当前聊天渲染条目中提取最新 TodoWrite 工具调用。
  // 使用 renderEntries 而不是直接读取 structuredMessages，确保输入框上方的 Todo
  // 列表与当前消息投影保持一致；执行计划等非消息条目不会影响此列表。
  const todoItems = useMemo(() => deriveTodoItems(renderEntries), [renderEntries]);

  // 会话内被 Agent 修改过的文件列表 — 路由层 ArtifactsPanel 消费（经 chat:stats 摘要事件）
  const changedFiles = useMemo(() => extractChangedFiles(renderEntries), [renderEntries]);

  // Broadcast 摘要 via custom event（路由层 ChatArea 据此派生 changedFiles 给 ArtifactsPanel）。
  // 派发逻辑（幂等签名跳过 / 1s trailing 节流 / 依赖变化与卸载时 flush 补发最终态）
  // 封装在 ChatStatsDispatcher，时序行为由 chat-stats.test.ts 覆盖
  const statsDispatcher = useMemo(() => new ChatStatsDispatcher(), []);
  // 卸载时补发待发摘要；不能放进下方 effect 的 cleanup——依赖变化也会触发 cleanup，
  // 若在那里 flush 会把节流退化为每次变化立即派发
  useEffect(() => () => statsDispatcher.flush(), [statsDispatcher]);
  useEffect(() => {
    statsDispatcher.update({
      agentName: agentId,
      modelName,
      entryCount: renderEntries.length,
      changedFiles,
    });
  }, [agentId, modelName, renderEntries, changedFiles, statsDispatcher]);

  // =============================================================================
  // User Actions
  // =============================================================================

  // Creates a new session by clearing current state and calling new_session
  const handleNewSession = useCallback(() => {
    // 正在等待 agent 响应时，阻止新建会话以避免状态混乱
    if (isLoading) {
      toast.warning(t("acpMain.chatBusy"));
      return;
    }

    resetThreadState();
    // Create new session — YJS will update chatState.activeSessionId
    requestCreateSession();
  }, [isLoading, resetThreadState, requestCreateSession, t]);

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
  const pendingPermissions = useMemo(() => derivePendingPermissions(chatState?.permissions), [chatState?.permissions]);

  // AskUserQuestion 待应答问题（Session Doc pendingQuestions 投影，已过滤 pending+未过期）：
  // 依赖收窄到 Map 引用本身（快照中其他字段变化不触发重建）
  const pendingQuestions = useMemo(() => {
    const map = sessionState?.pendingQuestions;
    if (!map || map.size === 0) return [];
    return Array.from(map.values());
  }, [sessionState?.pendingQuestions]);

  // Handle ChatInput submit — convert ChatInputMessage to ContentBlock[]
  const handleChatInputSubmit = useCallback(
    async (message: ChatInputMessage) => {
      const draftText = message.text.trim();
      const images = message.images || [];
      const attachmentReferences = (message.attachments ?? [])
        .filter((attachment) => !draftText.includes(`@./${attachment.path}`))
        .map((attachment) => `@./${attachment.path}`);
      const text = [draftText, ...attachmentReferences].filter(Boolean).join("\n");

      if ((!text && images.length === 0) || isLoading) return;

      const contentBlocks: ContentBlock[] = [];

      if (text) {
        contentBlocks.push({ type: "text", text });
      }

      // 图片保持 ContentBlock 顺序；单张失败不阻塞其余正文与附件引用。
      for (const image of images) {
        try {
          contentBlocks.push(await prepareImageContent(image));
        } catch (error) {
          console.error("[ChatInterface] Failed to prepare image:", error);
          toast.error(t("composerAssets.prepareImageFailed"));
          return;
        }
      }

      if (contentBlocks.length === 0) return;

      // 注入场景提示词（仅第一条消息，隐藏不显示）
      if (scenePrompt && !scenePromptUsedRef.current) {
        contentBlocks.unshift({ type: "text", text: scenePrompt });
        scenePromptUsedRef.current = true;
      }

      // 注入上下文队列（flush 后清空）
      const contextBlock = flushContext(composerContextScope);
      if (contextBlock) {
        contentBlocks.unshift({ type: "text", text: contextBlock });
      }

      userCancelledRef.current = false;

      // 无活跃会话时先创建会话，prompt 缓存到 pendingSendRef，等 activeSessionId 就绪后由 useEffect 自动发送
      if (!activeSessionId) {
        // 已有待发送的 prompt 在等待中，忽略重复提交
        if (pendingSendRef.current) return;
        pendingSendRef.current = contentBlocks;
        // 10 秒超时保护：若会话创建失败则清理缓存，避免 prompt 永久挂起
        pendingSendTimerRef.current = setTimeout(() => {
          if (pendingSendRef.current) {
            pendingSendRef.current = null;
            console.warn("[ChatInterface] Session creation timeout, pending send cleared");
          }
        }, 10_000);
        try {
          await onCreateSession();
        } catch (err) {
          console.error("[ChatInterface] Failed to create session:", err);
          pendingSendRef.current = null;
          if (pendingSendTimerRef.current) {
            clearTimeout(pendingSendTimerRef.current);
            pendingSendTimerRef.current = null;
          }
        }
        return;
      }

      try {
        await onSendPrompt(contentBlocks);
      } catch (error) {
        console.error("[ChatInterface] Failed to send prompt:", error);
      }
    },
    [isLoading, onSendPrompt, scenePrompt, activeSessionId, onCreateSession, composerContextScope, t],
  );

  const [selectedPeriTask, setSelectedPeriTask] = useState<PeriTaskViewProjection | null>(null);

  return (
    <div className="flex h-full">
      <div ref={interfaceColumnRef} className="chat-interface-column flex flex-col flex-1 min-w-0">
        {agentId && detailSessionId ? (
          <PeriTaskDetailSheet
            environmentId={agentId}
            sessionId={detailSessionId}
            task={selectedPeriTask}
            onClose={() => setSelectedPeriTask(null)}
          />
        ) : null}

        {/* Chat messages — unified ChatView */}
        <ChatView
          entries={renderEntries}
          isLoading={isLoading && !sessionReady ? false : isLoading}
          emptyTitle={sessionReady ? t("chatEmpty.startConversation") : undefined}
          emptyDescription={sessionReady ? t("chatEmpty.startConversationDesc") : undefined}
          sessionId={rcsSessionId ?? activeSessionId ?? undefined}
          envId={agentId}
        />

        <div ref={inputDockRef} className="chat-input-dock">
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
              onOpenTask={agentId && detailSessionId ? setSelectedPeriTask : undefined}
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
                placeholder={sessionReady ? t("chatInterface.agentPlaceholder") : t("chatInterface.waitingSession")}
                supportsImages={supportsImages}
                commands={availableCommands.length > 0 ? availableCommands : undefined}
                envId={agentId}
                contextScope={composerContextScope}
                availableModes={availableModes}
                currentModeId={currentModeId}
                onModeChange={onSetMode}
                contextUsage={tokenUsage ?? promptUsage}
                onNewSession={handleNewSession}
                showNewSession={renderEntries.length > 0}
                modelName={modelName}
              />
            </div>
          )}
        </div>
        {readonly && (
          <div className="flex-shrink-0">
            <div className="max-w-3xl mx-auto w-full px-4 sm:px-8 py-3 text-center">
              <span className="text-xs text-text-muted">{t("chatInterface.readonlyMode")}</span>
            </div>
          </div>
        )}
      </div>

      {/* Context Panel */}
      {!readonly && !hideContextPanel && (
        <ContextPanel
          entries={renderEntries}
          agentName={agentId}
          modelName={modelName}
          collapsed={!contextPanelOpen}
          onToggle={() => setContextPanelOpen(!contextPanelOpen)}
          acpUsage={tokenUsage ?? promptUsage}
        />
      )}
    </div>
  );
});
