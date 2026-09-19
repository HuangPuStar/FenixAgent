/**
 * Demo 内存态会话状态机（`../mock-chat-store` 的内部实现）。
 *
 * 仅供 `../mock-chat-store` 消费，不属于对外模块。拆分原因：状态机与 React 绑定（定时器、快照派生）
 * 是两件不同的事，分开也避免单文件超过 500 行红线。
 *
 * 来源：状态字段与动作语义来自 `packages/agent-runtime/web/components/chat/chat-interface-types.ts`
 * 与 `packages/chat-channel/web/components/ChatInterface.tsx`；纯化改动点：不复制传输内核，
 * 改为在内存里回放 `createMockStreamScript()` 的步骤表。
 *
 * 演示语义与真实系统的对齐点：
 * - 阻塞型交互未应答前不推进 turn（`await-permission` / `await-question` 暂停点）；
 * - `loading` / `canCancel` 与 turn 展示态同步（输出中 loading 非空、停止按钮可用）；
 * - 待办由 `plan` 快照推进（取最后一条计划），与 `deriveTodoItems` 的语义一致。
 */

import type {
  ContentBlock,
  LoadingState,
  PeriTaskViewProjection,
  PermissionRequest,
  QuestionProjection,
  SessionDocStatus,
  SessionStatus,
  SessionSummary,
  StructuredMessage,
  TokenUsage,
} from "../../types";
import {
  createMockPeriTasks,
  createMockPermissions,
  createMockQuestions,
  createMockSessionSummaries,
  createMockTokenUsage,
  MOCK_DEFAULT_MODE_ID,
  MOCK_RCS_SESSION_ID,
} from "../mock-fixtures";
import { createMockConversation } from "./mock-conversation";
import { createMockStreamScript, type MockStreamStep } from "./mock-stream-script";

/** 流式脚本所属的 turn 标识（仅用于计划消息归属展示）。 */
const STREAM_TURN_ID = "turn-stream";

/** 单个会话的内存态记录，等价于真实系统的 Session Doc + Chat Doc 投影。 */
export interface MockSessionRecord {
  acpSessionId: string;
  summary: SessionSummary;
  messages: StructuredMessage[];
  permissions: PermissionRequest[];
  /** 只保留未应答的问题（与上游投影语义一致，避免面板渲染已决议问题）。 */
  questions: Map<string, QuestionProjection>;
  status: SessionStatus;
  sessionStatus: SessionDocStatus | null;
  loading: LoadingState | null;
  canCancel: boolean;
  tokenUsage: TokenUsage | null;
  /** 待回放的流式脚本；空数组表示空闲。 */
  script: MockStreamStep[];
  /** 下一个待回放步骤下标。 */
  cursor: number;
  /** 脚本暂停点：阻塞型交互未应答时不推进。 */
  awaiting: { kind: "permission" | "question"; id: string } | null;
  /** 当前流式段落所属助手消息 id；`thought` / `text` 步骤追加到它上面。 */
  streamingAssistantId: string | null;
}

/** mock store 的完整内存状态。 */
export interface MockState {
  records: MockSessionRecord[];
  activeSessionId: string;
  periTasks: PeriTaskViewProjection[];
  connectionState: string;
  currentModeId: string;
}

/** 出站动作（对应真实宿主 client 的写操作）。 */
export type MockAction =
  | { type: "send-prompt"; blocks: ContentBlock[] }
  | { type: "tick" }
  | { type: "cancel" }
  | { type: "respond-permission"; requestId: string; optionId: string | null }
  | { type: "respond-question"; questionId: string; answers: Array<string | string[]> }
  | { type: "set-mode"; modeId: string }
  | { type: "create-session" }
  | { type: "select-session"; sessionId: string }
  | { type: "reset" };

/** 取下一个消息序号（`seq` 只影响排序展示，mock 用消息数近似）。 */
function nextSeq(messages: readonly StructuredMessage[]): number {
  return messages.length + 1;
}

/** 把用户提交的内容块拼成用户消息文本；图片块按宿主投影语义丢弃。 */
function contentBlocksToText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** 构造一个空会话记录。 */
function createEmptyRecord(sessionId: string, summary: Partial<SessionSummary> = {}): MockSessionRecord {
  const now = Date.now();
  return {
    acpSessionId: `ses_${sessionId}`,
    summary: {
      sessionId,
      title: summary.title ?? "新会话",
      preview: summary.preview ?? "",
      status: "active",
      lastMsgTs: now,
      cwd: summary.cwd ?? "/workspace/fenix-agent",
      updatedAt: new Date(now).toISOString(),
    },
    messages: [],
    permissions: [],
    questions: new Map(),
    status: "idle",
    sessionStatus: "ready",
    loading: null,
    canCancel: false,
    tokenUsage: null,
    script: [],
    cursor: 0,
    awaiting: null,
    streamingAssistantId: null,
  };
}

/** 初始状态：首条会话带完整样本，其余会话为空时间线（用于演示空状态与切换）。 */
export function createInitialMockState(): MockState {
  const summaries = createMockSessionSummaries();
  const records = summaries.map((summary, index): MockSessionRecord => {
    const record = createEmptyRecord(summary.sessionId, summary);
    if (index !== 0) return record;
    return {
      ...record,
      messages: createMockConversation(),
      permissions: createMockPermissions(),
      questions: createMockQuestions(),
      status: "waiting-user",
      tokenUsage: createMockTokenUsage(),
    };
  });
  return {
    records,
    activeSessionId: summaries[0].sessionId,
    periTasks: createMockPeriTasks(),
    connectionState: "connected",
    currentModeId: MOCK_DEFAULT_MODE_ID,
  };
}

/** 取当前活跃会话记录。 */
export function activeRecord(state: MockState): MockSessionRecord | undefined {
  return state.records.find((record) => record.summary.sessionId === state.activeSessionId);
}

/** 就地更新活跃会话记录。 */
function replaceActive(state: MockState, update: (record: MockSessionRecord) => MockSessionRecord): MockState {
  return {
    ...state,
    records: state.records.map((record) =>
      record.summary.sessionId === state.activeSessionId ? update(record) : record,
    ),
  };
}

/** Peri 任务按 taskId upsert（同一任务的状态更新覆盖前值）。 */
function upsertPeriTask(
  tasks: readonly PeriTaskViewProjection[],
  task: PeriTaskViewProjection,
): PeriTaskViewProjection[] {
  if (!tasks.some((item) => item.taskId === task.taskId)) return [...tasks, task];
  return tasks.map((item) => (item.taskId === task.taskId ? task : item));
}

/** 回放单个流式步骤；`peri-task` 由 reducer 在会话记录之外处理，故此处为 no-op。 */
function applyStep(record: MockSessionRecord, step: MockStreamStep): MockSessionRecord {
  switch (step.kind) {
    case "assistant-open":
      return {
        ...record,
        streamingAssistantId: step.id,
        messages: [
          ...record.messages,
          { type: "assistant_message", id: step.id, chunks: [], seq: nextSeq(record.messages), ts: Date.now() },
        ],
      };
    case "thought":
    case "text": {
      const chunkType = step.kind === "thought" ? "thought" : "message";
      return {
        ...record,
        messages: record.messages.map((message) =>
          message.type === "assistant_message" && message.id === record.streamingAssistantId
            ? { ...message, chunks: [...message.chunks, { type: chunkType, text: step.text }] }
            : message,
        ),
      };
    }
    case "tool-open":
      return { ...record, messages: [...record.messages, step.message] };
    case "tool-close":
      return {
        ...record,
        messages: record.messages.map((message) =>
          message.type === "tool_call" && message.id === step.id ? { ...message, ...step.patch } : message,
        ),
      };
    case "plan":
      return {
        ...record,
        messages: [
          ...record.messages,
          { type: "plan", id: `mock-plan-${record.messages.length}`, turnId: STREAM_TURN_ID, entries: step.entries },
        ],
      };
    case "permission":
      return {
        ...record,
        messages: [...record.messages, step.tool],
        permissions: [...record.permissions, step.request],
      };
    case "await-permission":
      return { ...record, awaiting: { kind: "permission", id: step.requestId } };
    case "question":
      return { ...record, questions: new Map(record.questions).set(step.question.questionId, step.question) };
    case "await-question":
      return { ...record, awaiting: { kind: "question", id: step.questionId } };
    case "usage":
      return { ...record, tokenUsage: step.usage };
    case "loading":
      return { ...record, loading: step.loading, status: step.status, canCancel: step.canCancel };
    default:
      return record;
  }
}

/** 状态机：所有出站动作与流式回放都收敛在此。 */
export function mockReducer(state: MockState, action: MockAction): MockState {
  switch (action.type) {
    case "tick": {
      const record = activeRecord(state);
      const step = record?.script[record.cursor];
      if (!record || !step) return state;
      // 游标推进由回放器负责，步骤本身只做数据变更（便于单步重放与测试）。
      const next: MockState = {
        ...state,
        records: state.records.map((item) =>
          item.summary.sessionId === state.activeSessionId
            ? { ...applyStep(item, step), cursor: item.cursor + 1 }
            : item,
        ),
      };
      return step.kind === "peri-task" ? { ...next, periTasks: upsertPeriTask(next.periTasks, step.task) } : next;
    }

    case "send-prompt": {
      const now = Date.now();
      return replaceActive(state, (record) => ({
        ...record,
        messages: [
          ...record.messages,
          {
            type: "user_message",
            id: `mock-user-${now}`,
            content: contentBlocksToText(action.blocks),
            seq: nextSeq(record.messages),
            ts: now,
          },
        ],
        // 立即置为输出中：与真实系统一致，首帧即可见 loading 指示与停止按钮。
        status: "responding",
        loading: { kind: "session/respond", label: "正在生成回复", since: now },
        canCancel: true,
        script: createMockStreamScript(),
        cursor: 0,
        awaiting: null,
        streamingAssistantId: null,
      }));
    }

    case "cancel":
      return replaceActive(state, (record) => ({
        ...record,
        messages: record.messages.map((message) =>
          message.type === "tool_call" &&
          (message.status === "running" || message.status === "waiting_for_confirmation")
            ? { ...message, status: "canceled" as const }
            : message,
        ),
        permissions: record.permissions.map((permission) =>
          permission.status === "pending" ? { ...permission, status: "denied" as const } : permission,
        ),
        script: [],
        cursor: 0,
        awaiting: null,
        status: "idle",
        loading: null,
        canCancel: false,
      }));

    case "respond-permission": {
      // 与后端 CAS 语义一致：deny / reject 前缀视为拒绝，其余选项视为授权。
      const approved =
        action.optionId !== null && !action.optionId.startsWith("deny") && !action.optionId.startsWith("reject");
      return replaceActive(state, (record) => ({
        ...record,
        permissions: record.permissions.map((permission) =>
          permission.id === action.requestId
            ? { ...permission, status: approved ? ("approved" as const) : ("denied" as const) }
            : permission,
        ),
        messages: record.messages.map((message) =>
          message.type === "tool_call" && message.permissionRequest?.requestId === action.requestId
            ? { ...message, status: approved ? ("complete" as const) : ("rejected" as const) }
            : message,
        ),
        awaiting: record.awaiting?.id === action.requestId ? null : record.awaiting,
      }));
    }

    case "respond-question":
      return replaceActive(state, (record) => {
        // 上游投影只把 pending 未过期的问题放进快照，决议后即从 Map 移除，面板随之收起。
        const questions = new Map(record.questions);
        questions.delete(action.questionId);
        return {
          ...record,
          questions,
          messages: record.messages.map((message) =>
            message.type === "tool_call" && message.id === action.questionId
              ? { ...message, status: "complete" as const, rawOutput: { answers: action.answers } }
              : message,
          ),
          awaiting: record.awaiting?.id === action.questionId ? null : record.awaiting,
        };
      });

    case "set-mode":
      return { ...state, currentModeId: action.modeId };

    case "create-session": {
      const sessionId = `${MOCK_RCS_SESSION_ID}_new_${state.records.length + 1}`;
      return {
        ...state,
        records: [
          // 原活跃会话回到 idle，新会话成为唯一 active（与真实会话列表状态一致）。
          ...state.records.map((record) =>
            record.summary.sessionId === state.activeSessionId
              ? { ...record, summary: { ...record.summary, status: "idle" as const } }
              : record,
          ),
          createEmptyRecord(sessionId),
        ],
        activeSessionId: sessionId,
      };
    }

    case "select-session": {
      if (!state.records.some((record) => record.summary.sessionId === action.sessionId)) return state;
      return {
        ...state,
        activeSessionId: action.sessionId,
        records: state.records.map((record) => ({
          ...record,
          summary: { ...record.summary, status: record.summary.sessionId === action.sessionId ? "active" : "idle" },
        })),
      };
    }

    case "reset":
      return createInitialMockState();

    default:
      return state;
  }
}
