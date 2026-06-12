import { getParentToolUseId } from "acp-link/types";
import imageCompression from "browser-image-compression";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ACPClient } from "../src/acp/client";
import type {
  ContentBlock,
  ImageContent,
  PermissionOption,
  PermissionRequestPayload,
  SessionUpdate,
} from "../src/acp/types";
import { useCommands } from "../src/hooks/useCommands";
import { useModes } from "../src/hooks/useModes";
import { flushContext, isVisibleContentBlock } from "../src/lib/context-queue";
import type {
  ChatInputMessage,
  PendingPermission,
  ThreadEntry,
  ToolCallData,
  ToolCallEntry,
  ToolCallStatus,
  UserMessageEntry,
  UserMessageImage,
} from "../src/lib/types";
import { ContextPanel } from "./ContextPanel";
import { ChatInput } from "./chat/ChatInput";
import { ChatView } from "./chat/ChatView";
import { PermissionPanel } from "./chat/PermissionPanel";
import { SessionModeSelector } from "./chat/SessionModeSelector";
import type { TodoItem } from "./chat/TodoPanel";
import { isTodoWriteToolCall, parseTodosFromRawInput, TodoPanel } from "./chat/TodoPanel";
import { ModelSelectorPopover } from "./model-selector";

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

import { Plus } from "lucide-react";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

// =============================================================================
// Type Definitions - imported from shared types module
// =============================================================================

interface ChatInterfaceProps {
  client: ACPClient;
  agentId?: string;
  readonly?: boolean;
  hideContextPanel?: boolean;
  rcsSessionId?: string;
  onSessionCreated?: (sessionId: string) => void;
  scenePrompt?: string;
  onPromptComplete?: () => void;
}
// Helper Functions
// =============================================================================

// Map ACP status string to our status type
function mapToolStatus(status: string): ToolCallStatus {
  if (status === "completed") return "complete";
  if (status === "failed") return "error";
  if (status === "canceled" || status === "cancelled") return "canceled";
  if (status === "rejected") return "rejected";
  // "pending" / "in_progress" / unknown → "running"
  return "running";
}

// Find tool call index in entries (search from end, like Zed)
function findToolCallIndex(entries: ThreadEntry[], toolCallId: string): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && entry.type === "tool_call" && entry.toolCall.id === toolCallId) {
      return i;
    }
  }
  return -1;
}

// 终态集合 — 已处于终态的工具调用不接受服务器状态覆盖
const TERMINAL_STATUSES = new Set<ToolCallStatus>(["canceled", "rejected"]);

// =============================================================================
// 纯函数：将 SessionUpdate 应用到 entries 数组，返回新数组
// 顶级和子 agent 嵌套复用同一套逻辑
// =============================================================================
function applySessionUpdateToEntries(entries: ThreadEntry[], update: SessionUpdate): ThreadEntry[] {
  // Handle agent message chunk
  if (update.sessionUpdate === "agent_message_chunk") {
    const text = update.content.type === "text" && update.content.text ? update.content.text : "";
    if (!text) return entries;

    const lastEntry = entries[entries.length - 1];

    // If last entry is AssistantMessage, append to it
    if (lastEntry?.type === "assistant_message") {
      const lastChunk = lastEntry.chunks[lastEntry.chunks.length - 1];
      if (lastChunk?.type === "message") {
        return [
          ...entries.slice(0, -1),
          {
            ...lastEntry,
            chunks: [...lastEntry.chunks.slice(0, -1), { type: "message", text: lastChunk.text + text }],
          },
        ];
      }
      return [...entries.slice(0, -1), { ...lastEntry, chunks: [...lastEntry.chunks, { type: "message", text }] }];
    }

    return [
      ...entries,
      { type: "assistant_message", id: `assistant-${Date.now()}`, chunks: [{ type: "message", text }] },
    ];
  }

  // Handle agent thought chunk
  if (update.sessionUpdate === "agent_thought_chunk") {
    const text = update.content.type === "text" && update.content.text ? update.content.text : "";
    if (!text) return entries;

    const lastEntry = entries[entries.length - 1];

    if (lastEntry?.type === "assistant_message") {
      const lastChunk = lastEntry.chunks[lastEntry.chunks.length - 1];
      if (lastChunk?.type === "thought") {
        return [
          ...entries.slice(0, -1),
          {
            ...lastEntry,
            chunks: [...lastEntry.chunks.slice(0, -1), { type: "thought", text: lastChunk.text + text }],
          },
        ];
      }
      return [...entries.slice(0, -1), { ...lastEntry, chunks: [...lastEntry.chunks, { type: "thought", text }] }];
    }

    return [
      ...entries,
      { type: "assistant_message", id: `assistant-${Date.now()}`, chunks: [{ type: "thought", text }] },
    ];
  }

  // Handle user message chunk
  if (update.sessionUpdate === "user_message_chunk") {
    const text = update.content.type === "text" && update.content.text ? update.content.text : "";
    if (!text) return entries;
    if (!isVisibleContentBlock({ type: "text", text })) return entries;

    const lastEntry = entries[entries.length - 1];
    if (lastEntry?.type === "user_message") {
      return [...entries.slice(0, -1), { ...lastEntry, content: lastEntry.content + text }];
    }

    return [...entries, { type: "user_message", id: `user-${Date.now()}`, content: text }];
  }

  // Handle tool call (UPSERT)
  if (update.sessionUpdate === "tool_call") {
    const toolCallData: ToolCallData = {
      id: update.toolCallId,
      title: update.title,
      status: mapToolStatus(update.status),
      content: update.content,
      rawInput: update.rawInput,
      rawOutput: update.rawOutput,
    };

    const existingIndex = findToolCallIndex(entries, update.toolCallId);
    if (existingIndex >= 0) {
      return entries.map((entry, index) => {
        if (index !== existingIndex || entry.type !== "tool_call") return entry;
        // 保护终态和待确认状态
        if (TERMINAL_STATUSES.has(entry.toolCall.status) || entry.toolCall.status === "waiting_for_confirmation")
          return entry;
        return { type: "tool_call", toolCall: { ...entry.toolCall, ...toolCallData } };
      });
    }

    return [...entries, { type: "tool_call", toolCall: toolCallData }];
  }

  // Handle tool call update (partial update)
  if (update.sessionUpdate === "tool_call_update") {
    const existingIndex = findToolCallIndex(entries, update.toolCallId);

    if (existingIndex < 0) {
      const failedEntry: ToolCallEntry = {
        type: "tool_call",
        toolCall: {
          id: update.toolCallId,
          title: update.title || "Tool call not found",
          status: "error",
          content: [{ type: "content", content: { type: "text", text: "Tool call not found" } }],
        },
      };
      return [...entries, failedEntry];
    }

    return entries.map((entry, index) => {
      if (index !== existingIndex || entry.type !== "tool_call") return entry;
      // 保护终态和待确认状态
      if (TERMINAL_STATUSES.has(entry.toolCall.status) || entry.toolCall.status === "waiting_for_confirmation")
        return entry;

      const newStatus = update.status ? mapToolStatus(update.status) : entry.toolCall.status;
      const mergedContent = update.content
        ? [...(entry.toolCall.content || []), ...update.content]
        : entry.toolCall.content;

      return {
        type: "tool_call",
        toolCall: {
          ...entry.toolCall,
          status: newStatus,
          ...(update.title && { title: update.title }),
          content: mergedContent,
          ...(update.rawInput && { rawInput: update.rawInput }),
          ...(update.rawOutput && { rawOutput: update.rawOutput }),
        },
      };
    });
  }

  // Handle plan update
  if (update.sessionUpdate === "plan") {
    if (update.entries.length === 0) {
      return entries.filter((e) => e.type !== "plan");
    }

    const lastPlanIndex = entries.reduce((acc, entry, i) => (entry.type === "plan" ? i : acc), -1);
    if (lastPlanIndex >= 0) {
      return entries.map((entry, index) => (index === lastPlanIndex ? { ...entry, entries: update.entries } : entry));
    }

    return [...entries, { type: "plan", id: `plan-${Date.now()}`, entries: update.entries }];
  }

  return entries;
}

// =============================================================================
// ChatInterface Component
// =============================================================================

export interface ChatInterfaceHandle {
  newSession: () => void;
}

export const ChatInterface = forwardRef<ChatInterfaceHandle, ChatInterfaceProps>(function ChatInterface(
  { client, agentId, readonly, hideContextPanel, rcsSessionId, onSessionCreated, scenePrompt, onPromptComplete },
  ref,
) {
  const { t } = useTranslation("components");
  // Flat list of entries (like Zed's entries: Vec<AgentThreadEntry>)
  const [entries, setEntries] = useState<ThreadEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  // 断连时记住 loading 状态，WS 重连 resume 后恢复
  const wasLoadingBeforeDisconnect = useRef(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const scenePromptUsedRef = useRef(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 追踪用户主动取消操作，避免取消后触发错误提示
  const userCancelledRef = useRef(false);
  // Todo 面板状态 — 每次 todowrite 调用替换
  const [todoItems, setTodoItems] = useState<TodoItem[]>([]);
  // Reference: Zed's supports_images() checks prompt_capabilities.image
  const [supportsImages, setSupportsImages] = useState(false);
  const [contextPanelOpen, setContextPanelOpen] = useState(true);
  const { commands: availableCommands } = useCommands(client);
  const { availableModes, currentModeId, setMode } = useModes(client);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    scenePromptUsedRef.current = false;
  }, [activeSessionId]);

  const resetThreadState = useCallback(() => {
    setEntries([]);
    setIsLoading(false);
    setSessionReady(false);
    setTodoItems([]);
    // 清除残留的错误提示和定时器，避免切换会话后错误横幅持续显示
    setErrorMessage(null);
    if (errorTimerRef.current) {
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    userCancelledRef.current = false;
    wasLoadingBeforeDisconnect.current = false;
  }, []);

  const storageKey = agentId ? `acp_last_session_${agentId}` : null;

  const requestCreateSession = useCallback(async () => {
    await client.createSession();
  }, [client]);

  const activateSession = useCallback(
    (sessionId: string, options?: { resetEntries?: boolean }) => {
      const shouldResetEntries = options?.resetEntries ?? true;
      if (shouldResetEntries) {
        setEntries([]);
        setIsLoading(false);
        wasLoadingBeforeDisconnect.current = false;
      }
      setActiveSessionId(sessionId);
      setSessionReady(true);
      setSupportsImages(client.supportsImages);
      if (storageKey) {
        try {
          localStorage.setItem(storageKey, sessionId);
        } catch {}
      }
      console.log("[ChatInterface] Active session:", sessionId, "supportsImages:", client.supportsImages);
    },
    [client, storageKey],
  );

  // =============================================================================
  // Permission Request Handler
  // =============================================================================
  const handlePermissionRequest = useCallback((request: PermissionRequestPayload) => {
    if (activeSessionIdRef.current && request.sessionId !== activeSessionIdRef.current) {
      return;
    }
    console.log("[ChatInterface] Permission request:", request);

    setEntries((prev) => {
      // Find matching tool call (search from end)
      const toolCallIndex = findToolCallIndex(prev, request.toolCall.toolCallId);

      if (toolCallIndex >= 0) {
        // Update existing tool call's status
        return prev.map((entry, index) => {
          if (index !== toolCallIndex) return entry;
          if (entry.type !== "tool_call") return entry;
          if (entry.toolCall.status !== "running") return entry;

          return {
            type: "tool_call",
            toolCall: {
              ...entry.toolCall,
              status: "waiting_for_confirmation" as const,
              permissionRequest: {
                requestId: request.requestId,
                options: request.options,
              },
            },
          };
        });
      } else {
        // No matching tool call - create standalone permission request as new entry
        console.log("[ChatInterface] No matching tool call, creating standalone permission request");

        const permissionToolCall: ToolCallEntry = {
          type: "tool_call",
          toolCall: {
            id: request.toolCall.toolCallId,
            title: request.toolCall.title || "Permission Request",
            status: "waiting_for_confirmation",
            permissionRequest: {
              requestId: request.requestId,
              options: request.options,
            },
            isStandalonePermission: true,
          },
        };

        return [...prev, permissionToolCall];
      }
    });
  }, []);

  // =============================================================================
  // Session Update Handler (Zed-style: check last entry type)
  // 支持子 agent 嵌套：带 parentToolUseId 的 update 路由到父工具调用的 subEntries
  // =============================================================================

  const handleSessionUpdate = useCallback((sessionId: string, update: SessionUpdate) => {
    if (activeSessionIdRef.current && sessionId !== activeSessionIdRef.current) {
      return;
    }

    // 拦截 todowrite 工具调用 → 更新 Todo 面板（仅顶层）
    if (update.sessionUpdate === "tool_call" && isTodoWriteToolCall(update.title, update.rawInput)) {
      const todos = parseTodosFromRawInput(update.rawInput!);
      if (todos.length > 0) {
        setTodoItems(todos);
      }
    } else if (
      update.sessionUpdate === "tool_call_update" &&
      update.rawInput &&
      isTodoWriteToolCall(update.title || "", update.rawInput)
    ) {
      const todos = parseTodosFromRawInput(update.rawInput);
      if (todos.length > 0) {
        setTodoItems(todos);
      }
    }

    // 检测子 agent 关联 — 有 parentToolUseId 时路由到嵌套处理
    const parentToolUseId = getParentToolUseId(update);
    if (parentToolUseId) {
      setEntries((prev) => {
        const parentIndex = findToolCallIndex(prev, parentToolUseId);
        if (parentIndex < 0) {
          console.warn(`[ChatInterface] Parent tool call not found: ${parentToolUseId}, skipping sub-agent update`);
          return prev;
        }

        const parentEntry = prev[parentIndex];
        if (parentEntry.type !== "tool_call") return prev;

        const subEntries = parentEntry.toolCall.subEntries ?? [];
        const newSubEntries = applySessionUpdateToEntries(subEntries, update);

        // 如果父工具调用完成（来自子 agent 的 tool_call_update 匹配 parentToolUseId），更新父状态
        if (
          update.sessionUpdate === "tool_call_update" &&
          "toolCallId" in update &&
          update.toolCallId === parentToolUseId
        ) {
          const newStatus = update.status ? mapToolStatus(update.status) : parentEntry.toolCall.status;
          return prev.map((entry, i) => {
            if (i !== parentIndex || entry.type !== "tool_call") return entry;
            return {
              ...entry,
              toolCall: {
                ...entry.toolCall,
                status: newStatus,
                subEntries: newSubEntries,
              },
            };
          });
        }

        return prev.map((entry, i) => {
          if (i !== parentIndex || entry.type !== "tool_call") return entry;
          return {
            ...entry,
            toolCall: {
              ...entry.toolCall,
              subEntries: newSubEntries,
            },
          };
        });
      });
      return;
    }

    // 顶级消息 — 正常处理
    setEntries((prev) => applySessionUpdateToEntries(prev, update));
  }, []);

  // =============================================================================
  // Setup Effect
  // =============================================================================
  useEffect(() => {
    client.setSessionCreatedHandler((sessionId) => {
      console.log("[ChatInterface] Session created:", sessionId);
      activateSession(sessionId);
      onSessionCreated?.(sessionId);
    });

    client.setSessionLoadedHandler((sessionId) => {
      console.log("[ChatInterface] Session loaded/resumed:", sessionId);
      activateSession(sessionId, { resetEntries: false });
      // WS 重连 resume：恢复断连前的 loading 状态（agent 可能仍在执行）
      if (wasLoadingBeforeDisconnect.current) {
        console.log("[ChatInterface] Restoring isLoading=true after reconnect resume");
        setIsLoading(true);
        wasLoadingBeforeDisconnect.current = false;
      }
    });

    client.setSessionSwitchingHandler((sessionId) => {
      console.log("[ChatInterface] Switching to session:", sessionId);
      setActiveSessionId(sessionId);
      resetThreadState();
    });

    // 连接断开时强制退出 loading 状态，防止卡死
    const connectionStateHandler = (state: string) => {
      if (state === "error" || state === "disconnected") {
        setIsLoading((prev) => {
          if (prev) {
            console.log("[ChatInterface] Connection lost while loading, forcing isLoading=false");
            wasLoadingBeforeDisconnect.current = true;
          }
          return false;
        });
      }
    };
    client.setConnectionStateHandler(connectionStateHandler);

    client.setSessionUpdateHandler((sessionId: string, update: SessionUpdate) => {
      handleSessionUpdate(sessionId, update);
    });

    client.setPromptCompleteHandler((stopReason, usage) => {
      console.log("[ChatInterface] Prompt complete:", stopReason, usage);
      // Always set isLoading=false when prompt completes
      // This includes stopReason="cancelled" (which is the expected response after client.cancel())
      // Note: Tool calls are already marked as "canceled" in handleCancel before this fires
      setIsLoading(false);

      // 用户主动取消时跳过错误提示，避免误导用户
      if (userCancelledRef.current) {
        userCancelledRef.current = false;
      } else {
        // inputTokens === 0 indicates the prompt was not processed (error)
        if (usage && usage.inputTokens === 0) {
          setErrorMessage("请求未能正常处理，请检查 Agent 或大模型状态后重试");
          if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
          errorTimerRef.current = setTimeout(() => setErrorMessage(null), 8000);
        }
      }

      onPromptComplete?.();
    });

    client.setPermissionRequestHandler(handlePermissionRequest);

    client.setErrorMessageHandler((msg) => {
      console.error("[ChatInterface] Agent error:", msg);
      // 用户主动取消后，忽略服务端回传的错误消息
      if (userCancelledRef.current) return;
      setErrorMessage(msg);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(() => setErrorMessage(null), 5000);
    });

    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      client.removeConnectionStateHandler(connectionStateHandler);
      client.setSessionCreatedHandler(() => {});
      client.setSessionLoadedHandler(() => {});
      client.setSessionSwitchingHandler(null);
      client.setSessionUpdateHandler(() => {});
      client.setPromptCompleteHandler(() => {});
      client.setPermissionRequestHandler(() => {});
      client.setErrorMessageHandler(() => {});
    };
  }, [
    activateSession,
    client,
    handlePermissionRequest,
    handleSessionUpdate,
    resetThreadState,
    onSessionCreated,
    onPromptComplete,
  ]);

  // Broadcast stats to AgentAppShell via custom event (for top-level StatusHeader)
  useEffect(() => {
    const modelName = client.modelState
      ? (client.modelState.availableModels.find((m) => m.modelId === client.modelState!.currentModelId)?.name ??
        client.modelState.currentModelId)
      : undefined;
    window.dispatchEvent(
      new CustomEvent("chat:stats", {
        detail: { agentName: agentId, modelName, entries },
      }),
    );
  }, [entries, agentId, client.modelState]);

  // =============================================================================
  // User Actions
  // =============================================================================

  // Reference: Zed's ConnectionView.reset() + set_server_state() + _external_thread()
  // Creates a new session by clearing current state and calling new_session
  // This is the core of Zed's NewThread action
  const handleNewSession = useCallback(() => {
    console.log("[ChatInterface] Creating new session...");

    // Reference: Zed's set_server_state() calls close_all_sessions() before setting new state
    // Cancel any ongoing request before creating new session
    if (isLoading) {
      client.cancel();
    }

    // 1. Clear all entries (like Zed's set_server_state which creates new view)
    resetThreadState();
    setActiveSessionId(null);

    // 3. Create new session (like Zed's initial_state -> connection.new_session())
    // The session_created handler will set sessionReady=true when ready
    requestCreateSession();
  }, [isLoading, resetThreadState, requestCreateSession, client.cancel]);

  useImperativeHandle(
    ref,
    () => ({
      newSession: handleNewSession,
    }),
    [handleNewSession],
  );

  // Cancel handler - matches Zed's cancel() logic in acp_thread.rs
  // 1. Mark all pending/running/waiting_for_confirmation tool calls as canceled
  // 2. Send cancel notification to agent
  // 3. Do NOT set isLoading=false here - wait for prompt_complete with stopReason="cancelled"
  // 4. Safety: if prompt_complete never arrives (agent dead), force isLoading=false after timeout
  const handleCancel = useCallback(() => {
    console.log("[ChatInterface] Cancel requested");

    // 标记为用户主动取消，后续 promptComplete/errorMessage 不弹出错误提示
    userCancelledRef.current = true;
    // Like Zed: iterate all entries, mark Pending/WaitingForConfirmation/InProgress tool calls as Canceled
    setEntries((prev) =>
      prev.map((entry) => {
        if (entry.type !== "tool_call") return entry;

        // Check if status should be canceled (matches Zed's logic)
        const shouldCancel =
          entry.toolCall.status === "running" || entry.toolCall.status === "waiting_for_confirmation";

        if (!shouldCancel) return entry;

        console.log("[ChatInterface] Marking tool call as canceled:", entry.toolCall.id);
        return {
          type: "tool_call",
          toolCall: {
            ...entry.toolCall,
            status: "canceled" as ToolCallStatus,
            permissionRequest: undefined, // Clear any pending permission request
          },
        };
      }),
    );

    // Send cancel notification to server (which forwards to agent)
    client.cancel();
    // Note: Do NOT set isLoading=false here!
    // Wait for prompt_complete with stopReason="cancelled" from the agent
    // Safety: if agent is dead and prompt_complete never arrives, force after 3s
    setTimeout(() => {
      setIsLoading((prev) => {
        if (prev) {
          console.log("[ChatInterface] Cancel timeout - forcing isLoading=false");
        }
        return false;
      });
    }, 3000);
  }, [client]);

  const handlePermissionResponse = useCallback(
    (requestId: string, optionId: string | null, optionKind: PermissionOption["kind"] | null) => {
      console.log("[ChatInterface] Permission response:", { requestId, optionId, optionKind });
      client.respondToPermission(requestId, optionId);

      // Determine new status based on option kind
      const isRejected = optionKind === "reject_once" || optionKind === "reject_always" || optionId === null;

      // Update the tool call status in entries
      setEntries((prev) =>
        prev.map((entry) => {
          if (entry.type !== "tool_call") return entry;
          if (entry.toolCall.permissionRequest?.requestId !== requestId) return entry;

          // For standalone permission requests, mark as complete immediately when approved
          // For regular tool calls, mark as running (agent will update to complete later)
          let newStatus: ToolCallStatus;
          if (isRejected) {
            newStatus = "rejected";
          } else if (entry.toolCall.isStandalonePermission) {
            newStatus = "complete";
          } else {
            newStatus = "running";
          }

          return {
            type: "tool_call",
            toolCall: {
              ...entry.toolCall,
              status: newStatus,
              permissionRequest: undefined,
              isStandalonePermission: undefined,
            },
          };
        }),
      );
    },
    [client],
  );

  // =============================================================================
  // Render
  // =============================================================================

  // Collect pending permissions from tool call entries
  const pendingPermissions: PendingPermission[] = entries
    .filter(
      (e): e is ToolCallEntry =>
        e.type === "tool_call" && e.toolCall.status === "waiting_for_confirmation" && !!e.toolCall.permissionRequest,
    )
    .map((e) => ({
      requestId: e.toolCall.permissionRequest!.requestId,
      toolName: e.toolCall.title,
      toolInput: e.toolCall.rawInput || {},
      description: e.toolCall.title,
      options: e.toolCall.permissionRequest!.options,
    }));

  // Handle permission respond for unified PermissionPanel
  const handlePermissionPanelRespond = useCallback(
    (requestId: string, approved: boolean) => {
      // Find the matching permission request to get the real optionId
      const perm = pendingPermissions.find((p) => p.requestId === requestId);
      let optionId: string | null = null;
      let optionKind: PermissionOption["kind"] | null = null;

      if (perm?.options && perm.options.length > 0) {
        if (approved) {
          // Pick the first allow option (prefer allow_once, then allow_always)
          const allowOpt =
            perm.options.find((o) => o.kind === "allow_once") ?? perm.options.find((o) => o.kind === "allow_always");
          if (allowOpt) {
            optionId = allowOpt.optionId;
            optionKind = allowOpt.kind;
          }
        } else {
          // Pick the first reject option
          const rejectOpt =
            perm.options.find((o) => o.kind === "reject_once") ?? perm.options.find((o) => o.kind === "reject_always");
          if (rejectOpt) {
            optionId = rejectOpt.optionId;
            optionKind = rejectOpt.kind;
          }
        }
      }

      // Fallback: if no matching option found, use null (cancelled)
      if (!optionId) {
        optionKind = approved ? "allow_once" : "reject_once";
      }

      handlePermissionResponse(requestId, optionId, optionKind);
    },
    [handlePermissionResponse, pendingPermissions],
  );

  // Handle ChatInput submit — convert ChatInputMessage to ContentBlock[]
  const handleChatInputSubmit = useCallback(
    async (message: ChatInputMessage) => {
      const text = message.text.trim();
      const images = message.images || [];

      if ((!text && images.length === 0) || isLoading || !sessionReady) return;

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
        } catch (error) {
          console.error("[ChatInterface] Failed to process image:", error);
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

      // Add user message entry
      const userEntry: UserMessageEntry = {
        type: "user_message",
        id: `user-${Date.now()}`,
        content: text,
        images: userImages.length > 0 ? userImages : undefined,
      };
      setEntries((prev) => [...prev, userEntry]);
      setIsLoading(true);

      userCancelledRef.current = false;
      try {
        await client.sendPrompt(contentBlocks);
      } catch (error) {
        console.error("[ChatInterface] Failed to send prompt:", error);
        setIsLoading(false);
      }
    },
    [isLoading, sessionReady, client, scenePrompt],
  );

  return (
    <div className="flex h-full">
      <div className="flex flex-col flex-1 min-w-0">
        {/* Chat messages — unified ChatView */}
        <ChatView
          entries={entries}
          isLoading={isLoading && !sessionReady ? false : isLoading}
          onPermissionRespond={(requestId, optionId, optionKind) => {
            handlePermissionResponse(requestId, optionId, optionKind as PermissionOption["kind"] | null);
          }}
          emptyTitle={sessionReady ? "开始对话" : undefined}
          emptyDescription={sessionReady ? "输入消息开始与 ACP agent 聊天" : undefined}
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

        {/* Model selector + New thread + ChatInput */}
        {!readonly && (
          <div className="flex-shrink-0">
            <div className="max-w-3xl mx-auto w-full px-4 sm:px-8 pb-1 flex items-center justify-between">
              <div className="flex items-center gap-1">
                <SessionModeSelector modes={availableModes} currentModeId={currentModeId} onModeChange={setMode} />
                <ModelSelectorPopover client={client} />
              </div>
              {entries.length > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-text-muted hover:text-brand font-display gap-1"
                      onClick={handleNewSession}
                    >
                      <Plus className="h-3 w-3" />
                      新会话
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("chatInterface.newThread")}</TooltipContent>
                </Tooltip>
              )}
            </div>
            <ChatInput
              onSubmit={handleChatInputSubmit}
              isLoading={isLoading}
              onInterrupt={handleCancel}
              disabled={!sessionReady}
              placeholder={sessionReady ? t("chatInterface.agentPlaceholder") : t("chatInterface.waitingSession")}
              supportsImages={supportsImages}
              commands={availableCommands.length > 0 ? availableCommands : undefined}
              envId={agentId}
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
          entries={entries}
          agentName={agentId}
          modelName={
            client.modelState
              ? (client.modelState.availableModels.find((m) => m.modelId === client.modelState!.currentModelId)?.name ??
                client.modelState.currentModelId)
              : undefined
          }
          collapsed={!contextPanelOpen}
          onToggle={() => setContextPanelOpen(!contextPanelOpen)}
        />
      )}
    </div>
  );
});
