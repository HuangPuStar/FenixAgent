/**
 * Demo 用内存态会话驱动：`useMockChatSession()`。
 *
 * 职责：把 `internal/mock-reducer` 的状态机接到 React 上——派生与 `web/chat/types.ts` 中
 * `ChatStateSnapshot` / `SessionStateSnapshot` 同构的两份快照，并以定时器回放流式脚本，
 * 使 Chat UI 能在零网络、零 YJS 的条件下完整跑起来。
 *
 * 来源：状态字段与动作签名来自 `packages/agent-runtime/web/components/chat/chat-interface-types.ts`
 * 与 `packages/chat-channel/web/components/ChatInterface.tsx`（宿主如何把 YJS 投影喂给组件）。
 * 纯化改动点：**不复制传输内核**（agent-runtime 的 ChatPanel / yjs doc-hub / hooks/use-chat-state /
 * hooks/use-session-state / session-mutation-refresh 一律未复制），因此不存在 relay、Doc、重连与
 * 多标签页语义；`projectEntries` 由包内 mock 投影提供，等价于宿主注入的 `structuredToThreadEntries`。
 *
 * 已知取舍：`createSession` 立即就绪，不模拟 `session/new` 往返（无定时器，卸载安全）；
 * 定时器只由流式回放 effect 持有，卸载与依赖变化都会在清理函数里清除。
 */

import { useCallback, useEffect, useMemo, useReducer } from "react";
import type { McpOption } from "../composer/CommandMenu";
import type {
  AvailableCommand,
  ChatStateSnapshot,
  ContentBlock,
  PeriTaskViewProjection,
  QuestionProjection,
  SessionMode,
  SessionStateSnapshot,
  StructuredMessage,
  ThreadEntry,
  TokenUsage,
} from "../types";
import { activeRecord, createInitialMockState, mockReducer } from "./internal/mock-reducer";
import type { MockStreamStep } from "./internal/mock-stream-script";
import {
  MOCK_AVAILABLE_COMMANDS,
  MOCK_AVAILABLE_MODES,
  MOCK_BOUND_MCPS,
  MOCK_CAPABILITIES,
  MOCK_MODEL_NAME,
} from "./mock-fixtures";
import { projectMockEntries } from "./mock-project-entries";

/** demo 会话的 model 状态（与 fixtures 的模型名保持一致）。 */
const MOCK_MODEL_STATE: ChatStateSnapshot["modelState"] = {
  currentModelId: "claude-sonnet-4-5",
  availableModels: [{ modelId: "claude-sonnet-4-5", name: MOCK_MODEL_NAME }],
};

/** 各步骤的默认回放间隔（毫秒）；未声明的类型回退 {@link DEFAULT_STEP_DELAY_MS}。 */
const STEP_DELAY_MS: Partial<Record<MockStreamStep["kind"], number>> = {
  "assistant-open": 160,
  thought: 260,
  text: 160,
  "tool-open": 420,
  "tool-close": 520,
  plan: 260,
  "peri-task": 200,
  permission: 200,
  "await-permission": 0,
  "await-question": 0,
  question: 200,
  usage: 120,
  loading: 120,
};

/** 未在 {@link STEP_DELAY_MS} 声明的步骤的默认间隔。 */
const DEFAULT_STEP_DELAY_MS = 200;

/** `useMockChatSession` 的可选配置。 */
export interface UseMockChatSessionOptions {
  /** 统一覆盖流式步骤间隔（毫秒）；缺省按步骤类型取值，便于 demo 调快/调慢。 */
  stepDelayMs?: number;
}

/** `useMockChatSession` 的返回值：两份快照 + 可直接展开给 ChatInterface 的 props 片段与出站动作。 */
export interface MockChatSession {
  /** Chat Doc 级快照（会话列表、权限、能力、模式、用量）。 */
  chatState: ChatStateSnapshot;
  /** Session Doc 级快照（时间线、待答问题、turn 展示态）。 */
  sessionState: SessionStateSnapshot;
  /** `StructuredMessage[]` → `ThreadEntry[]` 投影（demo 侧的宿主投影替身）。 */
  projectEntries: (messages: readonly StructuredMessage[]) => ThreadEntry[];
  availableCommands: AvailableCommand[];
  availableModes: SessionMode[];
  currentModeId: string;
  supportsModeSelection: boolean;
  supportsImages: boolean;
  modelName: string;
  /** 当前会话用量（会话未产生用量时为 null）。 */
  tokenUsage: TokenUsage | null;
  periTasks: PeriTaskViewProjection[];
  periTasksLoaded: boolean;
  connectionState: string;
  boundMcps: readonly McpOption[];
  /** 提交一轮用户输入；返回 Promise 以满足 `onSendPrompt` 契约。 */
  sendPrompt: (blocks: ContentBlock[]) => Promise<void>;
  /** 取消当前 turn：停止脚本回放并把在途工具置为 canceled。 */
  cancel: () => void;
  /** 应答权限请求；`optionId` 为 null 表示直接拒绝。 */
  respondPermission: (requestId: string, optionId: string | null) => void;
  /** 应答 AskUserQuestion（按问题顺序，单选 string / 多选 string[]）。 */
  respondQuestion: (questionId: string, answers: Array<string | string[]>) => void;
  /** 切换会话模式。 */
  setSessionMode: (modeId: string) => void;
  /** 新建空会话并切换过去。 */
  createSession: () => Promise<void>;
  /** 切换活跃会话（内容按记录恢复；未产生过消息的会话呈现空状态）。 */
  selectSession: (sessionId: string) => void;
  /** 恢复初始样本（demo 的重置入口）。 */
  reset: () => void;
}

/** 步骤回放间隔：显式配置优先，其次按步骤类型，未声明类型回退默认值。 */
function resolveStepDelay(step: MockStreamStep, override?: number): number {
  if (override !== undefined) return override;
  return STEP_DELAY_MS[step.kind] ?? DEFAULT_STEP_DELAY_MS;
}

/**
 * 内存态会话驱动 hook。
 *
 * 来源：`packages/agent-runtime/web/components/chat/chat-interface-types.ts` 的 `ChatInterfaceProps`
 * 与 `packages/chat-channel/web/components/ChatInterface.tsx` 的宿主接线方式。
 * 纯化改动点：以 `useReducer` + 定时器回放替代 YJS 订阅与 relay 客户端，状态机见 `./internal/mock-reducer`。
 *
 * @param options 回放节奏等可选配置
 * @returns 两份快照、投影函数、props 片段与出站动作
 */
export function useMockChatSession(options: UseMockChatSessionOptions = {}): MockChatSession {
  const { stepDelayMs } = options;
  const [state, dispatch] = useReducer(mockReducer, undefined, createInitialMockState);

  const active = activeRecord(state) ?? state.records[0];
  const script = active?.script;
  const cursor = active?.cursor ?? 0;
  const awaiting = active?.awaiting ?? null;

  // 流式回放：effect 的清理函数负责在卸载或依赖变化时清除定时器，无需额外 ref。
  useEffect(() => {
    if (!script || awaiting) return;
    const step = script[cursor];
    if (!step) return;
    const timer = setTimeout(() => dispatch({ type: "tick" }), resolveStepDelay(step, stepDelayMs));
    return () => clearTimeout(timer);
  }, [script, cursor, awaiting, stepDelayMs]);

  const chatState = useMemo<ChatStateSnapshot>(
    () => ({
      sessions: state.records.map((record) => record.summary),
      activeSessionId: state.activeSessionId,
      permissions: active?.permissions ?? [],
      capabilities: MOCK_CAPABILITIES,
      modelState: MOCK_MODEL_STATE,
      modeState: { currentModeId: state.currentModeId, availableModes: MOCK_AVAILABLE_MODES },
      availableCommands: MOCK_AVAILABLE_COMMANDS,
      sessionListLoaded: true,
      tokenUsage: active?.tokenUsage ?? null,
    }),
    [state.records, state.activeSessionId, state.currentModeId, active],
  );

  const sessionState = useMemo<SessionStateSnapshot>(
    () => ({
      acpSessionId: active?.acpSessionId ?? "",
      sessionStatus: active?.sessionStatus ?? null,
      status: active?.status ?? "idle",
      loading: active?.loading ?? null,
      canCancel: active?.canCancel ?? false,
      structuredMessages: active?.messages ?? [],
      pendingQuestions: active?.questions ?? new Map<string, QuestionProjection>(),
      agentPublicError: null,
    }),
    [active],
  );

  const projectEntries = useCallback((messages: readonly StructuredMessage[]) => projectMockEntries(messages), []);

  const sendPrompt = useCallback(async (blocks: ContentBlock[]) => {
    dispatch({ type: "send-prompt", blocks });
  }, []);
  const cancel = useCallback(() => dispatch({ type: "cancel" }), []);
  const respondPermission = useCallback((requestId: string, optionId: string | null) => {
    dispatch({ type: "respond-permission", requestId, optionId });
  }, []);
  const respondQuestion = useCallback((questionId: string, answers: Array<string | string[]>) => {
    dispatch({ type: "respond-question", questionId, answers });
  }, []);
  const setSessionMode = useCallback((modeId: string) => dispatch({ type: "set-mode", modeId }), []);
  const createSession = useCallback(async () => {
    dispatch({ type: "create-session" });
  }, []);
  const selectSession = useCallback((sessionId: string) => dispatch({ type: "select-session", sessionId }), []);
  const reset = useCallback(() => dispatch({ type: "reset" }), []);

  return {
    chatState,
    sessionState,
    projectEntries,
    availableCommands: MOCK_AVAILABLE_COMMANDS,
    availableModes: MOCK_AVAILABLE_MODES,
    currentModeId: state.currentModeId,
    supportsModeSelection: true,
    supportsImages: true,
    modelName: MOCK_MODEL_NAME,
    tokenUsage: active?.tokenUsage ?? null,
    periTasks: state.periTasks,
    periTasksLoaded: true,
    connectionState: state.connectionState,
    boundMcps: MOCK_BOUND_MCPS,
    sendPrompt,
    cancel,
    respondPermission,
    respondQuestion,
    setSessionMode,
    createSession,
    selectSession,
    reset,
  };
}
