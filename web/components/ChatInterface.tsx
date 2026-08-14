import type {
  AvailableCommand,
  ChatStateSnapshot,
  ContentBlock,
  ImageContent,
  PromptUsage,
  SessionMode,
  SessionStateSnapshot,
  StructuredMessage,
} from "@fenix/chat-channel";
import imageCompression from "browser-image-compression";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { flushContext } from "../src/lib/context-queue";
import { structuredToThreadEntries } from "../src/lib/structured-to-thread";
import { computeStats, type TokenStats } from "../src/lib/token-stats";
import type { ChatInputMessage, PendingPermission, ThreadEntry, UserMessageImage } from "../src/lib/types";
import { ContextPanel } from "./ContextPanel";
import { ChatComposer } from "./chat/ChatComposer";
import { ChatView } from "./chat/ChatView";
import { PermissionPanel } from "./chat/PermissionPanel";
import { isTodoWriteToolCall, parseTodosFromRawInput, TodoPanel } from "./chat/TodoPanel";

// Image compression options
// Claude API has a 5MB limit, so we target 2MB to be safe
const IMAGE_COMPRESSION_OPTIONS = {
  maxSizeMB: 2, // Max output size in MB
  maxWidthOrHeight: 2048, // Max dimension (scales proportionally, no cropping)
  useWebWorker: true, // Non-blocking compression
  fileType: "image/jpeg" as const, // Convert to JPEG for better compression
};

// Convert data URL to Blob without using fetch()
// This is critical for Chrome extensions where fetch(dataUrl) violates CSP
function dataUrlToBlob(dataUrl: string): Blob {
  // Parse the data URL: data:[<mediatype>][;base64],<data>
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) {
    throw new Error("Invalid data URL: missing comma separator");
  }

  const header = dataUrl.slice(0, commaIndex);
  const base64Data = dataUrl.slice(commaIndex + 1);

  // Extract MIME type from header (e.g., "data:image/png;base64")
  const mimeMatch = header.match(/^data:([^;,]+)/);
  const mimeType = mimeMatch ? mimeMatch[1] : "application/octet-stream";

  // Decode base64 to binary
  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return new Blob([bytes], { type: mimeType });
}

import { Button } from "./ui/button";

// =============================================================================
// Type Definitions - imported from shared types module
// =============================================================================

interface ChatInterfaceProps {
  agentId?: string;
  readonly?: boolean;
  hideContextPanel?: boolean;
  rcsSessionId?: string;
  onSessionCreated?: (sessionId: string) => void;
  scenePrompt?: string;
  onPromptComplete?: () => void;
  /** 上下文标识：变化时自动触发 newSession（如工作流 ID 变化） */
  contextKey?: string;
  /** Yjs Session 级状态快照 — 替代旧 SessionUpdate handler */
  sessionState?: SessionStateSnapshot | null;
  /** Yjs Chat 级状态快照 — 替代旧 session 创建/切换/权限 handler */
  chatState?: ChatStateSnapshot;

  // ── Callbacks（替代 client 方法）──
  onSendPrompt: (contentBlocks: ContentBlock[]) => Promise<void>;
  onCancel: () => void;
  onCreateSession: () => Promise<void>;
  onRespondPermission: (requestId: string, optionId: string | null) => void;

  // ── 提升的状态（原 useCommands/useModes 结果）──
  availableCommands: AvailableCommand[];
  availableModes: SessionMode[];
  currentModeId: string | null;
  onSetMode: (modeId: string) => void;
  supportsModeSelection: boolean;

  // ── 提升的状态（原从 client 直接读）──
  supportsImages: boolean;
  modelName: string | undefined;
  /** ACP prompt_complete 返回的真实 token 用量 */
  tokenUsage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number } | null;
}

// =============================================================================
// ChatInterface Component
// =============================================================================

export interface ChatInterfaceHandle {
  newSession: () => void;
  /** 当前是否正在等待 agent 响应（prompt 已发送、尚未收到 prompt_complete） */
  isLoading: boolean;
}

export const ChatInterface = forwardRef<ChatInterfaceHandle, ChatInterfaceProps>(function ChatInterface(
  {
    agentId,
    readonly,
    hideContextPanel,
    rcsSessionId,
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
    availableCommands,
    availableModes,
    currentModeId,
    onSetMode,
    supportsModeSelection: _supportsModeSelection,
    supportsImages,
    modelName,
    tokenUsage,
  },
  ref,
) {
  const { t } = useTranslation("components");

  // ── YJS-driven computed state ──

  // 从 Yjs chatState 获取当前活跃会话 ID
  const activeSessionId = chatState?.activeSessionId ?? null;

  // 从 Yjs sessionState 计算 loading 状态
  const isLoading = sessionState?.loading != null;

  // turn 是否可取消（accepting/running/awaiting_permission）：仅驱动 ChatComposer 停止按钮，
  // 与 loading 正交——running 输出期间 loading 为 null（按钮原逻辑会退回 Send），
  // 必须靠 canCancel 让整个输出过程保持可中断
  const canCancel = sessionState?.canCancel ?? false;

  // 会话系统就绪（可输入）：session.status 仅在 create/load 成功后投影为 "ready"，
  // 无历史会话时为 null——此时输入框必须可用，由 handleChatInputSubmit 懒创建会话
  // （否则无会话场景输入被禁用、懒创建永不触发，页面死锁在"等待会话..."）。
  // 仅明确处于 "initializing"（会话系统初始化中，当前 acp-link 不下发该会话级
  // 状态，保留为防御分支）时禁用输入；turn 展示态只驱动 loading/canCancel。
  const sessionReady = sessionState?.sessionStatus !== "initializing";

  // 从 Yjs structuredMessages 计算渲染用的 ThreadEntry[]
  const renderEntries: ThreadEntry[] = useMemo(() => {
    if (!sessionState) return [];
    const result = sessionState.structuredMessages?.length
      ? structuredToThreadEntries(sessionState.structuredMessages)
      : [];
    return result;
  }, [sessionState]);

  // ── Refs & retained local state (YJS does not yet carry these fields) ──

  const scenePromptUsedRef = useRef(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 追踪用户主动取消操作，避免取消后触发错误提示
  const userCancelledRef = useRef(false);
  // 缓存用户首次发送的 prompt，等 activeSessionId 就绪后自动发送
  const pendingSendRef = useRef<ContentBlock[] | null>(null);
  const pendingSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [contextPanelOpen, setContextPanelOpen] = useState(true);
  // ACP 返回的真实 token 用量（prompt/complete 响应），用于 ContextPanel 优先展示
  const [promptUsage, setPromptUsage] = useState<PromptUsage | null>(null);

  // ── Side effects from YJS state changes ──

  // Reset scene prompt flag when session changes
  useEffect(() => {
    scenePromptUsedRef.current = false;
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

  // Todo 面板状态 — 从 Yjs structuredMessages 中提取最新 TodoWrite 工具调用
  const todoItems = useMemo(() => {
    if (!sessionState) return [];
    if (!sessionState.structuredMessages) return [];
    const todoWrites = sessionState.structuredMessages
      .filter(
        (m): m is StructuredMessage & { type: "tool_call"; rawInput?: Record<string, unknown> } =>
          m.type === "tool_call",
      )
      .filter((m) => isTodoWriteToolCall(m.title, m.rawInput));
    const last = todoWrites[todoWrites.length - 1];
    if (!last?.rawInput) return [];
    return parseTodosFromRawInput(last.rawInput);
  }, [sessionState]);

  // 计算 token 统计，传给 ChatComposer 元信息条
  const tokenStats: TokenStats = useMemo(() => computeStats(renderEntries), [renderEntries]);

  // Broadcast entries via custom event（路由层 chat.$agentId.tsx 据此派生 changedFiles 给 ArtifactsPanel）
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("chat:stats", {
        detail: { agentName: agentId, modelName, entries: renderEntries },
      }),
    );
  }, [renderEntries, agentId, modelName]);

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

  // Permission response — called from ChatView inline permission buttons
  const handlePermissionResponse = useCallback(
    (requestId: string, optionId: string | null) => {
      onRespondPermission(requestId, optionId);
    },
    [onRespondPermission],
  );

  // Stable callback matching ChatView's onPermissionRespond signature (3-param)
  const handlePermissionRespond = useCallback(
    (requestId: string, optionId: string | null, _optionKind: string | null) => {
      handlePermissionResponse(requestId, optionId);
    },
    [handlePermissionResponse],
  );

  // =============================================================================
  // Render helpers
  // =============================================================================

  // Collect pending permissions from YJS chatState
  const pendingPermissions: PendingPermission[] = useMemo(() => {
    if (!chatState?.permissions) return [];
    return chatState.permissions
      .filter((p) => p.status === "pending")
      .map((p) => ({
        requestId: p.id,
        toolName: p.tool,
        toolInput: (p.args as Record<string, unknown>) ?? {},
        description: p.tool,
        // 统一面板当前仍渲染 allow/deny 两键；options 透传供面板后续消费（二期）
        options: p.options,
      }));
  }, [chatState?.permissions]);

  // Handle permission respond for unified PermissionPanel
  const handlePermissionPanelRespond = useCallback(
    (requestId: string, approved: boolean) => {
      onRespondPermission(requestId, approved ? "allow" : null);
    },
    [onRespondPermission],
  );

  // Handle ChatInput submit — convert ChatInputMessage to ContentBlock[]
  const handleChatInputSubmit = useCallback(
    async (message: ChatInputMessage) => {
      const text = message.text.trim();
      const images = message.images || [];

      if ((!text && images.length === 0) || isLoading) return;

      const contentBlocks: ContentBlock[] = [];

      if (text) {
        contentBlocks.push({ type: "text", text });
      }

      // Convert images to ContentBlock
      const userImages: UserMessageImage[] = [];

      for (const img of images) {
        try {
          const dataUrl = `data:${img.mimeType};base64,${img.data}`;
          let blob: Blob;
          if (dataUrl.startsWith("data:")) {
            blob = dataUrlToBlob(dataUrl);
          } else {
            const response = await fetch(dataUrl);
            blob = await response.blob();
          }

          let finalBlob: Blob = blob;
          let finalMimeType = img.mimeType;

          if (blob.size > 2 * 1024 * 1024) {
            const imageFile = new File([blob], "image.jpg", { type: blob.type });
            finalBlob = await imageCompression(imageFile, IMAGE_COMPRESSION_OPTIONS);
            finalMimeType = "image/jpeg";
          }

          const base64Data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              const result = reader.result as string;
              const commaIndex = result.indexOf(",");
              resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
            };
            reader.onerror = () => reject(new Error(`FileReader error: ${reader.error?.message}`));
            reader.readAsDataURL(finalBlob);
          });

          const imageContent: ImageContent = {
            type: "image",
            mimeType: finalMimeType,
            data: base64Data,
          };
          contentBlocks.push(imageContent);

          userImages.push({
            mimeType: finalMimeType,
            data: base64Data,
          });
        } catch {
          // 图片处理失败静默跳过
        }
      }

      if (contentBlocks.length === 0) return;

      // 注入场景提示词（仅第一条消息，隐藏不显示）
      if (scenePrompt && !scenePromptUsedRef.current) {
        contentBlocks.unshift({ type: "text", text: scenePrompt });
        scenePromptUsedRef.current = true;
      }

      // 注入上下文队列（flush 后清空）
      const contextBlock = flushContext();
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
    [isLoading, onSendPrompt, scenePrompt, activeSessionId, onCreateSession],
  );

  return (
    <div className="flex h-full">
      <div className="flex flex-col flex-1 min-w-0">
        {/* Chat messages — unified ChatView */}
        <ChatView
          entries={renderEntries}
          isLoading={isLoading && !sessionReady ? false : isLoading}
          onPermissionRespond={handlePermissionRespond}
          emptyTitle={sessionReady ? t("chatEmpty.startConversation") : undefined}
          emptyDescription={sessionReady ? t("chatEmpty.startConversationDesc") : undefined}
          sessionId={rcsSessionId ?? activeSessionId ?? undefined}
          envId={agentId}
        />

        {/* Permission panel — fixed above input */}
        <PermissionPanel requests={pendingPermissions} onRespond={handlePermissionPanelRespond} />

        {/* Todo panel — 显示在输入框上方 */}
        <TodoPanel todos={todoItems} />

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
              availableModes={availableModes}
              currentModeId={currentModeId}
              onModeChange={onSetMode}
              tokenStats={tokenStats}
              onNewSession={handleNewSession}
              showNewSession={renderEntries.length > 0}
              modelName={modelName}
            />
          </div>
        )}
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
