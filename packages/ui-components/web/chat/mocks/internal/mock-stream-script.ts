/**
 * Demo 流式回复脚本（mock-fixtures 的内部实现）。
 *
 * 仅供 `../mock-fixtures` re-export，不属于对外模块。
 * 拆分原因：脚本与正文样本同属「静态样本」，但职责不同（正文是已完成的时间线，脚本是可回放的
 * 增量步骤），分开也避免单文件超过 500 行红线。
 *
 * 设计取舍：不复制真实传输内核（会话状态机 / YJS 投影），而是把「一轮回复」表达成线性步骤表，
 * 由 mock store 用定时器逐条回放；`await-permission` / `await-question` 是暂停点，等用户应答后继续，
 * 与真实系统「阻塞型交互未应答前不推进 turn」的语义一致。
 */

import type {
  ContentBlock,
  LoadingState,
  PeriTaskViewProjection,
  PermissionRequest,
  PlanEntryData,
  QuestionProjection,
  SessionStateSnapshot,
  StructuredToolCallContentBlock,
  TodoItem,
  TokenUsage,
  ToolCallMessage,
} from "../../types";
import { MOCK_PERMISSION_OPTIONS } from "./mock-conversation";

/**
 * 流式脚本步骤。
 *
 * `assistant-open` 之后的 `thought` / `text` 追加到该条助手消息上，模拟分片到达；
 * `tool-open` → `tool-close` 模拟工具状态流转；`plan` 驱动待办面板与状态面板推进。
 */
export type MockStreamStep =
  | { kind: "loading"; loading: LoadingState | null; status: SessionStateSnapshot["status"]; canCancel: boolean }
  /** 新建一段助手消息（后续 thought/text 步骤追加到它上面）。 */
  | { kind: "assistant-open"; id: string }
  | { kind: "thought"; text: string }
  | { kind: "text"; text: string }
  /** 追加一个 running 状态的工具调用。 */
  | { kind: "tool-open"; message: ToolCallMessage }
  /** 更新已有工具调用（状态流转 / 补齐输出）。 */
  | { kind: "tool-close"; id: string; patch: Partial<Omit<ToolCallMessage, "type" | "id">> }
  | { kind: "plan"; entries: PlanEntryData[] }
  /** 新增一个 Peri 任务到状态面板。 */
  | { kind: "peri-task"; task: PeriTaskViewProjection }
  /** 产生权限请求，并把对应工具置为 waiting_for_confirmation。 */
  | { kind: "permission"; request: PermissionRequest; tool: ToolCallMessage }
  | { kind: "await-permission"; requestId: string }
  | { kind: "question"; question: QuestionProjection }
  | { kind: "await-question"; questionId: string }
  | { kind: "usage"; usage: TokenUsage }
  /** 用户提交的原始内容块（mock 用于生成回显，不进入时间线）。 */
  | { kind: "echo"; blocks: ContentBlock[] };

/** 工具调用的文本内容块。 */
function textBlock(text: string): StructuredToolCallContentBlock {
  return { type: "content", content: { type: "text", text } };
}

/** 构造工具调用消息：`content` 缺省为空数组。 */
function toolCall(
  seed: Omit<ToolCallMessage, "type" | "content"> & { content?: StructuredToolCallContentBlock[] },
): ToolCallMessage {
  const { content, ...rest } = seed;
  return { type: "tool_call", content: content ?? [], ...rest };
}

/** 首条流式回复中的待办快照（推进到全部完成）。 */
const STREAM_TODO_ITEMS: TodoItem[] = [
  { content: "定位 glob 匹配范围", status: "in_progress", activeForm: "定位 glob 匹配范围" },
  { content: "跑一次前端生产构建", status: "pending" },
];

/** 全部完成后的待办快照。 */
const STREAM_TODO_DONE: TodoItem[] = STREAM_TODO_ITEMS.map((item) => ({ ...item, status: "completed" as const }));

/** 全部完成后的计划条目（驱动 ChatStatusPanel 的待办 Tab）。 */
const STREAM_PLAN_DONE: PlanEntryData[] = STREAM_TODO_DONE.map((item, index) => ({
  content: item.content,
  priority: index === 0 ? "high" : "medium",
  status: "completed" as const,
}));

/**
 * 构造一轮可回放的助手回复脚本。
 *
 * 来源：一轮真实回复的形态（`SessionStateSnapshot` 的 loading / canCancel / structuredMessages
 * 与 Chat Doc 的 permissions / pendingQuestions 同步推进），非逐字复制任何宿主实现。
 * 纯化改动点：以线性步骤表 + 定时器替代传输内核。
 *
 * 覆盖：推理块 → 分片正文 → 工具调用状态流转（running → complete）→ 待办推进 →
 * 权限请求（暂停）→ 问答（暂停）→ 用量更新 → 收尾。
 */
export function createMockStreamScript(): MockStreamStep[] {
  const now = Date.now();
  return [
    {
      kind: "loading",
      loading: { kind: "session/respond", label: "正在生成回复", since: now },
      status: "responding",
      canCancel: true,
    },
    { kind: "assistant-open", id: `stream-assistant-${now}` },
    { kind: "thought", text: "先确认要改的目录范围，再决定是否触发构建。" },
    { kind: "text", text: "我先把范围缩到这两块：" },
    { kind: "text", text: "\n\n1. 工具时间线的状态流转；" },
    { kind: "text", text: "\n2. 待办推进到全部完成。" },
    {
      kind: "tool-open",
      message: toolCall({
        id: "stream-glob-1",
        title: "Glob",
        status: "running",
        rawInput: { pattern: "packages/ui-components/web/chat/timeline/*.tsx" },
      }),
    },
    { kind: "text", text: "\n\n先看一下时间线层的文件分布。" },
    {
      kind: "tool-close",
      id: "stream-glob-1",
      patch: {
        status: "complete",
        rawOutput: { files: ["ToolCallRow.tsx", "ToolCallGroup.tsx", "SubAgentPanel.tsx"] },
      },
    },
    {
      kind: "plan",
      entries: [
        { content: "定位 glob 匹配范围", priority: "high", status: "completed" },
        { content: "跑一次前端生产构建", priority: "medium", status: "in_progress" },
      ],
    },
    {
      kind: "tool-open",
      message: toolCall({
        id: "stream-todo-1",
        title: "TodoWrite",
        status: "running",
        rawInput: { todos: STREAM_TODO_ITEMS },
      }),
    },
    {
      kind: "peri-task",
      task: {
        taskId: "task_stream_1",
        kind: "background",
        taskSubtype: "shell",
        title: "bun run build:web",
        summary: "构建进行中。",
        status: "running",
        turnId: "turn-stream",
        isBackground: true,
        startedAt: new Date(now).toISOString(),
        completedAt: null,
        updatedAt: new Date(now).toISOString(),
        detailAvailability: "preview",
      },
    },
    {
      kind: "permission",
      request: {
        id: "stream-perm-1",
        tool: "Bash",
        args: { command: "bun run build:web" },
        level: "ask",
        status: "pending",
        ts: now,
        options: MOCK_PERMISSION_OPTIONS,
      },
      tool: toolCall({
        id: "stream-bash-1",
        title: "Bash",
        status: "waiting_for_confirmation",
        rawInput: { command: "bun run build:web" },
        permissionRequest: { requestId: "stream-perm-1", options: MOCK_PERMISSION_OPTIONS },
      }),
    },
    { kind: "await-permission", requestId: "stream-perm-1" },
    {
      kind: "tool-close",
      id: "stream-bash-1",
      patch: {
        status: "complete",
        content: [textBlock("$ bun run build:web\nvite v8.3.0 building for production…\n✓ built in 6.42s")],
        rawOutput: { exitCode: 0 },
      },
    },
    { kind: "text", text: "\n\n生产构建通过，产物已落到 `apps/web/dist/`。" },
    {
      kind: "question",
      question: {
        questionId: "stream-question-1",
        status: "pending",
        description: "构建完成后需要确认下一步动作。",
        expiresAt: new Date(now + 60_000).toISOString(),
        answer: null,
        questions: [
          {
            question: "要不要顺带把待办标记为全部完成？",
            header: "收尾确认",
            multiSelect: false,
            options: [
              { label: "标记完成", description: "把本轮待办全部置为 completed" },
              { label: "先不标记", description: "保留进行中的待办，等我再确认" },
            ],
          },
        ],
      },
    },
    { kind: "await-question", questionId: "stream-question-1" },
    { kind: "plan", entries: STREAM_PLAN_DONE },
    {
      kind: "tool-close",
      id: "stream-todo-1",
      patch: { status: "complete", rawInput: { todos: STREAM_TODO_DONE }, rawOutput: { ok: true } },
    },
    { kind: "text", text: "\n\n待办已全部完成。" },
    {
      kind: "usage",
      usage: { totalTokens: 21_904, inputTokens: 19_260, outputTokens: 2_644, contextWindow: 200_000 },
    },
    { kind: "loading", loading: null, status: "done", canCancel: false },
  ];
}
