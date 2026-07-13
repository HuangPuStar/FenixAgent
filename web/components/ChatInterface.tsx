import { getParentToolUseId } from "acp-link/types";
import imageCompression from "browser-image-compression";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ACPClient } from "../src/acp/client";
import type {
  ContentBlock,
  ImageContent,
  PermissionOption,
  PermissionRequestPayload,
  PromptUsage,
  SessionUpdate,
} from "../src/acp/types";
import { useCommands } from "../src/hooks/useCommands";
import { useModes } from "../src/hooks/useModes";
import { flushContext, isVisibleContentBlock } from "../src/lib/context-queue";
import { computeStats, type TokenStats } from "../src/lib/token-stats";
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
import { ChatComposer } from "./chat/ChatComposer";
import { ChatView } from "./chat/ChatView";
import { extractDisplayMeta, resolveToolCardKind } from "./chat/narrators/helpers";
import { PermissionPanel } from "./chat/PermissionPanel";
import type { TodoItem } from "./chat/TodoPanel";
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

/** modulesConfig 中单个模块配置 */
export interface ChatModuleConfig {
  enabled?: boolean;
  [key: string]: unknown;
}

/** ProdView 模块显隐配置 */
export interface ChatModulesConfig {
  chatHeader?: ChatModuleConfig;
  sessionSidebar?: ChatModuleConfig;
  chatView?: ChatModuleConfig;
  chatComposer?: ChatModuleConfig;
  permissionPanel?: ChatModuleConfig;
  todoPanel?: ChatModuleConfig;
  contextPanel?: ChatModuleConfig;
  toolCallRow?: ChatModuleConfig;
  /** 右侧面板 — 文件 */
  filesPanel?: ChatModuleConfig;
  /** 右侧面板 — 站点 */
  sitesPanel?: ChatModuleConfig;
  /** 右侧面板 — 定时任务 */
  tasksPanel?: ChatModuleConfig;
  /** 右侧面板 — 发布视图 */
  viewsPanel?: ChatModuleConfig;
}

/** 判断模块是否应该渲染。未传 config 默认 true，传了则按 enabled 判断（enabled 缺省为 true） */
export function isModuleEnabled(config: ChatModuleConfig | undefined): boolean {
  if (!config) return true;
  return config.enabled !== false;
}

interface ChatInterfaceProps {
  client: ACPClient;
  agentId?: string;
  readonly?: boolean;
  hideContextPanel?: boolean;
  modulesConfig?: ChatModulesConfig;
  rcsSessionId?: string;
  onSessionCreated?: (sessionId: string) => void;
  scenePrompt?: string;
  onPromptComplete?: () => void;
  /** 上下文标识：变化时自动触发 newSession（如工作流 ID 变化） */
  contextKey?: string;
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

/**
 * 一轮 prompt 结束时的兜底：把仍为 running 的 tool_call 标记为 complete。
 *
 * 远程 agent（如 claude --acp）有时不在工具执行完成时推送
 * status="completed" 的 session/update，导致 tool_call 永久卡在 running，
 * UI 一直转圈。这里在 prompt_complete 时统一兜底，让 UI 终止 loading。
 *
 * 处理范围：
 * - 顶层与 subEntries 中的所有 tool_call 都递归处理
 * - 只改 status==="running" 的条目；其他状态（含 waiting_for_confirmation、
 *   canceled、rejected、error、complete）保持不动
 * - 没有任何 running 工具时返回原数组引用，避免无意义重渲染
 */
export function finalizeRunningToolCalls(entries: ThreadEntry[]): ThreadEntry[] {
  let changed = false;

  const mapEntry = (entry: ThreadEntry): ThreadEntry => {
    if (entry.type !== "tool_call") return entry;

    let nextToolCall = entry.toolCall;
    if (entry.toolCall.status === "running") {
      changed = true;
      nextToolCall = { ...entry.toolCall, status: "complete" as ToolCallStatus };
    }

    // 递归处理子 agent 嵌套条目
    if (entry.toolCall.subEntries && entry.toolCall.subEntries.length > 0) {
      const nextSubEntries = entry.toolCall.subEntries.map(mapEntry);
      // 仅在本次递归改动了子层、或顶层状态变化时才生成新对象
      if (nextSubEntries !== entry.toolCall.subEntries || nextToolCall !== entry.toolCall) {
        return { type: "tool_call", toolCall: { ...nextToolCall, subEntries: nextSubEntries } };
      }
      return entry;
    }

    return nextToolCall === entry.toolCall ? entry : { type: "tool_call", toolCall: nextToolCall };
  };

  const next = entries.map(mapEntry);
  return changed ? next : entries;
}

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
    // ① 顶层 display（opencode 风格，可能不在 ACP ToolCallUpdate 标准类型中，需转型访问）
    const topLevelDisplay = (update as unknown as Record<string, unknown>).display as
      | Record<string, unknown>
      | undefined;
    const display = extractDisplayMeta(update.rawOutput, update._meta, topLevelDisplay);
    // 构造临时 tool 对象用于 resolveToolCardKind
    const tempTool = { display, rawInput: update.rawInput, rawOutput: update.rawOutput };
    const kind = resolveToolCardKind(tempTool, update._meta);
    const toolCallData: ToolCallData = {
      id: update.toolCallId,
      title: update.title,
      status: mapToolStatus(update.status),
      kind,
      content: update.content,
      // 条件展开避免 undefined 覆盖已有值（rawInput 可能是空对象 {}，用 != null 而非 &&）
      ...(update.rawInput != null ? { rawInput: update.rawInput } : {}),
      ...(update.rawOutput != null ? { rawOutput: update.rawOutput } : {}),
      ...(display && { display }),
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
      // tool_call_update 先于 tool_call 到达时创建占位 entry，
      // 尽可能保留 update 中已有的 rawInput/rawOutput/display，避免数据被后续 UPSERT 覆盖丢弃
      const topLevelDisplay = (update as unknown as Record<string, unknown>).display as
        | Record<string, unknown>
        | undefined;
      const fallbackDisplay = extractDisplayMeta(update.rawOutput, update._meta, topLevelDisplay);
      const tempTool = { display: fallbackDisplay, rawInput: update.rawInput, rawOutput: update.rawOutput };
      const kind = resolveToolCardKind(tempTool, update._meta);
      const failedEntry: ToolCallEntry = {
        type: "tool_call",
        toolCall: {
          id: update.toolCallId,
          title: update.title || "Tool call not found",
          status: "error",
          kind,
          content: [{ type: "content", content: { type: "text", text: "Tool call not found" } }],
          ...(update.rawInput != null ? { rawInput: update.rawInput } : {}),
          ...(update.rawOutput != null ? { rawOutput: update.rawOutput } : {}),
          ...(fallbackDisplay && { display: fallbackDisplay }),
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
      const topLevelDisplay = (update as unknown as Record<string, unknown>).display as
        | Record<string, unknown>
        | undefined;
      // extractDisplayMeta 可能返回 undefined（metadata 结构异常），
      // 此时应保留旧 display 值，避免 display 丢失
      const display = update.rawOutput
        ? (extractDisplayMeta(update.rawOutput, update._meta, topLevelDisplay) ?? entry.toolCall.display)
        : entry.toolCall.display;
      // kind 同步更新（rawInput/output 变化可能导致 kind 变化）
      const tempTool = {
        display,
        rawInput: update.rawInput ?? entry.toolCall.rawInput,
        rawOutput: update.rawOutput ?? entry.toolCall.rawOutput,
      };
      const kind = resolveToolCardKind(tempTool, update._meta);

      return {
        type: "tool_call",
        toolCall: {
          ...entry.toolCall,
          status: newStatus,
          kind,
          ...(update.title && { title: update.title }),
          content: mergedContent,
          ...(update.rawInput && { rawInput: update.rawInput }),
          ...(update.rawOutput && { rawOutput: update.rawOutput }),
          ...(display && { display }),
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
  {
    client,
    agentId,
    readonly,
    hideContextPanel,
    modulesConfig,
    rcsSessionId,
    onSessionCreated,
    scenePrompt,
    contextKey,
    onPromptComplete,
  },
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
  // 追踪 errorMessageHandler 是否已设置后端错误，避免 promptCompleteHandler 的通用错误覆盖具体报错
  const backendErrorRef = useRef(false);
  // 追踪一轮 prompt 中是否收到 agent 输出（agent_message/tool_call 等），用于检测空响应
  const hasAssistantOutputRef = useRef(false);
  // Todo 面板状态 — 每次 todowrite 调用替换
  const [todoItems, setTodoItems] = useState<TodoItem[]>([]);
  // Reference: Zed's supports_images() checks prompt_capabilities.image
  const [supportsImages, setSupportsImages] = useState(false);
  const [contextPanelOpen, setContextPanelOpen] = useState(true);
  // ACP 返回的真实 token 用量（prompt/complete 响应），用于 ContextPanel 优先展示
  const [promptUsage, setPromptUsage] = useState<PromptUsage | null>(null);
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
    backendErrorRef.current = false;
    wasLoadingBeforeDisconnect.current = false;
    hasAssistantOutputRef.current = false;
    setPromptUsage(null);
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
            kind: resolveToolCardKind({
              rawInput: (request.toolCall as Record<string, unknown>).rawInput as Record<string, unknown>,
            }),
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

    // 记录本轮 prompt 中出现了 agent 输出，用于 promptComplete 时检测空响应
    if (
      update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
    ) {
      hasAssistantOutputRef.current = true;
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
          // 提取 display 元数据，避免子 agent 父 entry 的 display/rawOutput 丢失
          const parentDisplay = update.rawOutput ? extractDisplayMeta(update.rawOutput, update._meta) : undefined;
          return prev.map((entry, i) => {
            if (i !== parentIndex || entry.type !== "tool_call") return entry;
            return {
              ...entry,
              toolCall: {
                ...entry.toolCall,
                status: newStatus,
                subEntries: newSubEntries,
                ...(update.rawOutput != null ? { rawOutput: update.rawOutput } : {}),
                ...(parentDisplay && { display: parentDisplay }),
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

      // 存储 ACP 真实 token 用量，供 ContextPanel 优先展示
      setPromptUsage(usage ?? null);

      // 兜底：远程 agent（如 claude --acp）有时不在工具完成时推送 status="completed"
      // 的 session_update，导致 tool_call 永久卡在 running。一轮 prompt 结束后，
      // 把仍为 running 的工具调用统一标记为 complete，避免 UI 持续 loading。
      // 已是终态（canceled/rejected/error/complete）的不动；handleCancel 已经把
      // 取消的工具改成 canceled，这里只兜底未通知完成的 running 调用。
      setEntries((prev) => finalizeRunningToolCalls(prev));

      // 用户主动取消时跳过错误提示，避免误导用户
      if (userCancelledRef.current) {
        userCancelledRef.current = false;
      } else {
        // 如果后端已通过 errorMessageHandler 报告了具体错误，不再用通用错误覆盖
        if (backendErrorRef.current) {
          backendErrorRef.current = false;
        }
        // inputTokens === 0 且 outputTokens === 0 说明 prompt 未被处理（真错误）
        // 仅 inputTokens === 0 可能是 prompt caching 导致的正常情况（CCB/OC 引擎常见）
        else if (usage && usage.inputTokens === 0 && (usage.outputTokens ?? 0) === 0) {
          setErrorMessage(
            t("chatInterface.processingErrorDetail", {
              stopReason,
              inputTokens: String(usage.inputTokens),
              outputTokens: String(usage.outputTokens ?? 0),
            }),
          );
          if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
          errorTimerRef.current = setTimeout(() => setErrorMessage(null), 8000);
        }
        // 检测空响应：prompt 正常结束但 agent 没有产生任何输出
        // 典型场景：opencode 返回 {stopReason:"end_turn","_meta":{}} 无 usage 无内容
        else if (!hasAssistantOutputRef.current) {
          console.warn("[ChatInterface] Prompt completed with no assistant output");
          setErrorMessage(
            t("chatInterface.processingErrorDetail", {
              stopReason,
              inputTokens: String(usage?.inputTokens ?? "N/A"),
              outputTokens: String(usage?.outputTokens ?? "N/A"),
            }),
          );
          if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
          errorTimerRef.current = setTimeout(() => setErrorMessage(null), 8000);
        }
      }

      onPromptComplete?.();
    });

    client.setPermissionRequestHandler(handlePermissionRequest);

    // InteractiveQuestion handler — 当 CC 使用 AskUserQuestion 等交互工具时触发
    client.setInteractiveQuestionHandler((iq) => {
      console.log("[ChatInterface] Interactive question:", iq);
      // 将问题转为 pending permission 格式，复用 PermissionPanel 渲染
      const question = iq.questions[0];
      if (!question) return;
      setEntries((prev) => [
        ...prev,
        {
          type: "tool_call" as const,
          id: `iq-${iq.questionId}`,
          toolCall: {
            id: iq.questionId,
            title: question.header || iq.toolName,
            status: "waiting_for_confirmation" as ToolCallStatus,
            kind: "question" as const,
            rawInput: { questions: iq.questions },
            permissionRequest: {
              requestId: iq.questionId,
              options: question.options.map((opt, i) => ({
                kind: (i === 0 ? "allow_always" : "allow_once") as PermissionOption["kind"],
                name: `${opt.label}${opt.description ? ` — ${opt.description}` : ""}`,
                optionId: opt.label,
              })),
            },
            isStandalonePermission: true,
          },
        },
      ]);
    });

    client.setErrorMessageHandler((msg) => {
      console.error("[ChatInterface] Agent error:", msg);
      // 用户主动取消后，忽略服务端回传的错误消息
      if (userCancelledRef.current) return;
      // 标记后端已报错，避免 promptCompleteHandler 用通用错误覆盖具体报错
      backendErrorRef.current = true;
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
    t,
  ]);

  // 计算 token 统计，传给 ChatComposer 元信息条
  // 复用 entries 派生结果，避免重复遍历；chat:stats dispatch 仍独立维护以便外部监听
  const tokenStats: TokenStats = useMemo(() => computeStats(entries), [entries]);

  // Broadcast entries via custom event（路由层 chat.$agentId.tsx 据此派生 changedFiles 给 ArtifactsPanel）
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
      // 重置 agent 输出追踪和错误标记，用于本轮 prompt 检测
      hasAssistantOutputRef.current = false;
      backendErrorRef.current = false;

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
        {isModuleEnabled(modulesConfig?.chatView) && (
          <ChatView
            entries={entries}
            isLoading={isLoading && !sessionReady ? false : isLoading}
            onPermissionRespond={(requestId, optionId, optionKind) => {
              handlePermissionResponse(requestId, optionId, optionKind as PermissionOption["kind"] | null);
            }}
            emptyTitle={sessionReady ? t("chatEmpty.startConversation") : undefined}
            emptyDescription={
              sessionReady
                ? (modulesConfig?.chatView?.welcomeMessage as string) || t("chatEmpty.startConversationDesc")
                : undefined
            }
            sessionId={rcsSessionId ?? activeSessionId ?? undefined}
            envId={agentId}
            hideToolCallRows={!isModuleEnabled(modulesConfig?.toolCallRow)}
          />
        )}

        {/* Permission panel — fixed above input */}
        {isModuleEnabled(modulesConfig?.permissionPanel) && (
          <PermissionPanel requests={pendingPermissions} onRespond={handlePermissionPanelRespond} />
        )}

        {/* Todo panel — 显示在输入框上方 */}
        {isModuleEnabled(modulesConfig?.todoPanel) && <TodoPanel todos={todoItems} />}

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
            {isModuleEnabled(modulesConfig?.chatComposer) && (
              <ChatComposer
                onSubmit={handleChatInputSubmit}
                isLoading={isLoading}
                onInterrupt={handleCancel}
                disabled={!sessionReady}
                placeholder={
                  (modulesConfig?.chatComposer?.placeholder as string) ||
                  (sessionReady ? t("chatInterface.agentPlaceholder") : t("chatInterface.waitingSession"))
                }
                supportsImages={supportsImages}
                commands={availableCommands.length > 0 ? availableCommands : undefined}
                envId={agentId}
                client={client}
                availableModes={availableModes}
                currentModeId={currentModeId}
                onModeChange={setMode}
                tokenStats={tokenStats}
                onNewSession={handleNewSession}
                showNewSession={entries.length > 0}
              />
            )}
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
      {!readonly && !hideContextPanel && isModuleEnabled(modulesConfig?.contextPanel) && (
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
          acpUsage={promptUsage}
        />
      )}
    </div>
  );
});
