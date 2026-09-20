/**
 * Demo 会话正文样本（静态数据，mock-fixtures 的内部实现）。
 *
 * 仅供 `../mock-fixtures` re-export，不属于对外模块。
 * 拆分原因：会话正文需要覆盖全部渲染形态，体量超过单文件 500 行红线，按「正文数据 / 其它样本」拆开。
 *
 * 来源：字段形状来自 `web/chat/types.ts`；文案与工具入参按真实会话形态编写，
 * 使组件在 demo 中呈现与产品一致的结构、密度与文案。
 */

import type {
  AssistantChunk,
  AssistantMessage,
  PermissionOption,
  PlanEntryData,
  PlanMessage,
  PublicErrorInfo,
  StructuredMessage,
  StructuredToolCallContentBlock,
  ThreadEntry,
  TodoItem,
  ToolCallMessage,
  UserMessage,
} from "../../types";
import { projectMockEntries } from "../mock-project-entries";

/** 权限选项样本（一次性 / 本会话 / 拒绝）。 */
export const MOCK_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: "allow_once", name: "允许一次", kind: "allow_once" },
  { optionId: "allow_session", name: "本会话始终允许", kind: "allow_always" },
  { optionId: "deny", name: "拒绝", kind: "reject_once" },
];

/**
 * 样本图片地址（真实远程图，picsum 按 seed 稳定返回同一张）。
 *
 * 纯化取舍：demo 与其它示例都需要一张「看起来像真的」图片，而包内不宜内联大体积 base64，
 * 故这里用远程 URL；离线时该图会退化为 alt 文案，不影响其余示例（其余示例仍全部离线可渲染）。
 * 统一收在 mocks 里，避免每个 demo 分区各写一份 URL。
 */
export const MOCK_USER_IMAGE_URL = "https://picsum.photos/seed/fenix-ui-components/640/400.jpg";

/** 构造助手结构化消息。 */
function assistantMessage(
  id: string,
  chunks: AssistantChunk[],
  seq: number,
  ts: number,
  error?: PublicErrorInfo,
): AssistantMessage {
  return { type: "assistant_message", id, chunks, seq, ts, error };
}

/** 构造用户结构化消息。 */
function userMessage(id: string, content: string, seq: number, ts: number): UserMessage {
  return { type: "user_message", id, content, seq, ts };
}

/** 构造计划消息（标准 ACP plan 快照）。 */
function planMessage(id: string, turnId: string, entries: PlanEntryData[]): PlanMessage {
  return { type: "plan", id, turnId, entries };
}

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

/** 首轮待办快照（TodoWrite 入参，首次提交故全部条目都会被投影为 added）。 */
const FIRST_TODO_SNAPSHOT: TodoItem[] = [
  { content: "梳理会话投影的纯函数边界", status: "completed" },
  { content: "把投影抽成可注入的 projectEntries", status: "in_progress", activeForm: "抽取 projectEntries" },
  { content: "补多标签页隔离的边界测试", status: "pending" },
  { content: "运行 precheck 与前端生产构建", status: "pending" },
];

/** 首轮用户消息里的隐藏引用上下文（与宿主 `serializeChatQuotes` 同格式）。 */
const USER_QUOTES_REMINDER =
  '<system-reminder>Chat quotes for this turn (JSON): [{"text":"rcsSessionId 必须确定性生成，否则刷新后旧 Y.Doc 不可达。","omittedCharacterCount":0}]</system-reminder>';

/**
 * demo 主会话的结构化消息时间线（`SessionStateSnapshot.structuredMessages` 的渲染输入）。
 *
 * 来源：`StructuredMessage` / `ToolCallMessage` / `PlanMessage` 字段形状来自 `web/chat/types.ts`
 * （由 `@fenix/chat-channel` 与 `packages/acp-link` 逐字复制），文案与工具入参按真实会话形态编写。
 * 纯化改动点：无网络与 YJS，时间为相对调用时刻的时间戳，故以工厂函数导出。
 *
 * 覆盖形态：带引用与 system-reminder 的用户消息、助手正文与推理块、read / grep / glob / edit /
 * write / bash / todo-write / task（含子 Agent 轨迹）/ web-search / web-fetch 工具卡片、
 * 等待确认的工具调用、AskUserQuestion、待办计划、工具错误与 turn 级错误。
 */
export function createMockConversation(): StructuredMessage[] {
  const now = Date.now();
  const minute = 60_000;
  return [
    userMessage(
      "user-1",
      [
        USER_QUOTES_REMINDER,
        "<system-reminder>Selected MCP servers for this turn: filesystem, chrome-devtools</system-reminder>",
        "按 @./src/lib/context-queue.ts 的既有风格，把会话状态投影改成纯函数，",
        "并补一个覆盖多标签页场景的测试。",
      ].join("\n"),
      1,
      now - minute * 14,
    ),
    assistantMessage(
      "assistant-1",
      [
        {
          type: "thought",
          text: "先确认 rcsSessionId 的确定性生成逻辑，再看投影里哪些是纯函数、哪些持有会话级可变状态。",
        },
        { type: "message", text: "我先读一遍现有的投影与上下文队列实现，确认可纯化的边界。" },
      ],
      2,
      now - minute * 14 + 2_000,
    ),
    toolCall({
      id: "tool-read-1",
      title: "Read",
      status: "complete",
      rawInput: { filePath: "src/lib/structured-to-thread.ts" },
      display: { type: "file", path: "src/lib/structured-to-thread.ts", lineStart: 92, lineEnd: 178, totalLines: 532 },
      content: [
        textBlock("export function structuredToThreadEntries(messages: StructuredMessage[]): ThreadEntry[] { … }"),
      ],
      rawOutput: { content: [{ type: "text", text: "导出 1 个投影函数，依赖 tool-semantic 与 todo 两个纯模块。" }] },
    }),
    toolCall({
      id: "tool-grep-1",
      title: "Grep",
      status: "complete",
      rawInput: { pattern: "derivePendingPermissions", path: "packages/ui-components/web/chat" },
      rawOutput: { count: 8 },
      content: [
        textBlock(
          "packages/ui-components/web/chat/shell/ChatInterface.tsx:238\npackages/ui-components/web/chat/lib/chat-derived-state.ts:41",
        ),
      ],
    }),
    toolCall({
      id: "tool-glob-1",
      title: "Glob",
      status: "complete",
      rawInput: { pattern: "**/chat-derived-state.ts" },
      rawOutput: {
        files: [
          "web/chat/lib/chat-derived-state.ts",
          "apps/server/src/lib/chat-derived-state.ts",
          "src/lib/chat-derived-state.ts",
        ],
      },
    }),
    assistantMessage(
      "assistant-2",
      [
        { type: "thought", text: "投影确实是纯的：只有 flushContext 持有会话级队列，它已在纯化时被移出包外。" },
        {
          type: "message",
          text: "确认了：`structuredToThreadEntries` 是纯函数，持有可变状态的只有 `flushContext`。\n\n我按这个结论拆分任务。",
        },
      ],
      3,
      now - minute * 12,
    ),
    toolCall({
      id: "tool-todo-1",
      title: "TodoWrite",
      status: "complete",
      rawInput: { todos: FIRST_TODO_SNAPSHOT },
      rawOutput: { ok: true },
    }),
    toolCall({
      id: "tool-task-1",
      title: "Task",
      status: "complete",
      rawInput: {
        subagent_type: "general-purpose",
        description: "排查多标签页状态串号",
        prompt: "确认同一 instanceId 下多标签页共享 relay handle 时，Y.Doc 名称是否按 rcsSessionId 隔离。",
      },
      content: [
        textBlock("子 Agent 结论：Y.Doc 名称使用 chat:{rcsSessionId} / session:{rcsSessionId}，未发现全局广播。"),
      ],
      rawOutput: { ok: true },
      subMessages: [
        userMessage("sub-user-1", "确认 Y.Doc 名称与广播范围是否按 rcsSessionId 隔离。", 1, now - minute * 11),
        assistantMessage(
          "sub-assistant-1",
          [
            { type: "thought", text: "先搜 rcsSessionId 的生成与使用点。" },
            { type: "message", text: "我从生成函数入手，再核对广播过滤条件。" },
          ],
          2,
          now - minute * 11 + 1_000,
        ),
        toolCall({
          id: "sub-tool-grep-1",
          title: "Grep",
          status: "complete",
          rawInput: { pattern: "createDeterministicRcsSessionId", path: "packages/chat-channel/src" },
          rawOutput: { count: 3 },
        }),
        toolCall({
          id: "sub-tool-bash-1",
          title: "Bash",
          status: "complete",
          rawInput: { command: "bun test packages/chat-channel/src/__tests__/yjs-store.test.ts" },
          content: [textBlock("3 pass, 0 fail, 12 expect() calls")],
          rawOutput: { exitCode: 0 },
        }),
      ],
    }),
    toolCall({
      id: "tool-edit-1",
      title: "Edit",
      status: "complete",
      rawInput: {
        file_path: "web/chat/lib/chat-derived-state.ts",
        old_string: 'classifyToolSemantic({ name: tool }) === "ask-user-question"',
        new_string: "options?.shouldSuppress?.(tool)",
      },
      display: { type: "diff", path: "web/chat/lib/chat-derived-state.ts" },
      content: [
        {
          type: "diff",
          path: "web/chat/lib/chat-derived-state.ts",
          oldText:
            'permission.status === "pending" && classifyToolSemantic({ name: permission.tool }) !== "ask-user-question",',
          newText: 'permission.status === "pending" && !options?.shouldSuppress?.(permission.tool),',
        },
      ],
      rawOutput: { ok: true },
    }),
    toolCall({
      id: "tool-write-1",
      title: "Write",
      status: "complete",
      rawInput: { path: "web/chat/mocks/mock-chat-store.ts", content: "export function useMockChatSession() { … }" },
      display: { type: "file", path: "web/chat/mocks/mock-chat-store.ts" },
      content: [textBlock("已写入 214 行。")],
      rawOutput: { ok: true },
    }),
    toolCall({
      id: "tool-bash-1",
      title: "Bash",
      status: "complete",
      rawInput: { command: "bun run precheck" },
      content: [textBlock("$ bun run precheck\nformat … ok\nlint … ok\ntsc … ok\n3 tests passed")],
      rawOutput: { exitCode: 0, stdout: "all checks passed" },
    }),
    toolCall({
      id: "tool-websearch-1",
      title: "WebSearch",
      status: "complete",
      rawInput: { query: "Yjs doc name isolation multi-tab awareness" },
      rawOutput: { count: 5 },
      content: [textBlock("5 results: yjs docs / discuss.yjs.dev / github issues 各 1–3 条。")],
    }),
    toolCall({
      id: "tool-webfetch-1",
      title: "WebFetch",
      status: "complete",
      rawInput: { url: "https://docs.yjs.dev" },
      content: [textBlock("Document Updates：同一 Doc 名称下的更新只广播给订阅该名称的客户端。")],
    }),
    assistantMessage(
      "assistant-3",
      [
        {
          type: "message",
          text: "投影已纯化完成，`precheck` 全绿。改动集中在两处：\n\n- `chat-derived-state.ts` 的权限过滤改为注入判定；\n- mock 驱动新增 `projectEntries` 直供路径。\n\n多标签页用例已按 Y.Doc 名称隔离补齐。",
        },
      ],
      4,
      now - minute * 8,
    ),
    planMessage("plan-1", "turn-1", [
      { content: "梳理会话投影的纯函数边界", priority: "high", status: "completed" },
      { content: "把投影抽成可注入的 projectEntries", priority: "high", status: "in_progress" },
      { content: "补多标签页隔离的边界测试", priority: "medium", status: "pending" },
      { content: "运行 precheck 与前端生产构建", priority: "medium", status: "pending" },
    ]),
    userMessage("user-2", "顺手把这个包相关的测试跑一下，失败的话把原因贴出来。", 5, now - minute * 6),
    assistantMessage(
      "assistant-4",
      [
        { type: "thought", text: "先定位这个包的测试入口，再决定跑哪些文件。" },
        { type: "message", text: "我先找一下包内的测试文件。" },
      ],
      6,
      now - minute * 6 + 1_500,
    ),
    toolCall({
      id: "tool-glob-2",
      title: "Glob",
      status: "complete",
      rawInput: { pattern: "packages/ui-components/web/__tests__/*.test.tsx" },
      rawOutput: { files: ["chat-composer.test.tsx", "barrel-exports.test.ts"] },
    }),
    toolCall({
      id: "tool-bash-2",
      title: "Bash",
      status: "error",
      rawInput: { command: "bun test packages/ui-components/web/__tests__/chat-shell.test.tsx" },
      content: [
        textBlock("$ bun test packages/ui-components/web/__tests__/chat-shell.test.tsx\n(no matching test files)"),
      ],
      rawOutput: { exitCode: 1, stderr: "No tests found matching the filter." },
      publicError: {
        type: "AGENT_RUNTIME.REQUEST_FAILED",
        id: "err_demo_tool_5f2a",
        message: "工具执行失败，命令以非零状态退出。",
      },
    }),
    assistantMessage(
      "assistant-5",
      [
        {
          type: "message",
          text: "这个测试入口还不存在（包内目前只有 composer 与 barrel 两个用例），所以我先停在这里等你确认。",
        },
      ],
      7,
      now - minute * 5,
      {
        type: "AGENT_RUNTIME.LLM_API_RATE_LIMITED",
        id: "err_demo_turn_9c41",
        message: "模型网关返回 429，本轮回复被截断，请稍后重试。",
      },
    ),
    toolCall({
      id: "tool-bash-3",
      title: "Bash",
      status: "waiting_for_confirmation",
      rawInput: { command: "bun run build:web" },
      permissionRequest: { requestId: "perm-demo-1", options: MOCK_PERMISSION_OPTIONS },
    }),
    toolCall({
      id: "question-demo-1",
      title: "AskUserQuestion",
      status: "waiting_for_confirmation",
      rawInput: {
        questions: [
          {
            question: "接下来先补哪一块？",
            header: "下一步",
            multiSelect: false,
            options: [
              { label: "补测试入口", description: "新增 chat-shell 测试文件并覆盖权限/问答面板" },
              { label: "接 demo 分区", description: "在 demo 里加一个 Chat 分区，直接吃这套 mock" },
            ],
          },
        ],
      },
      rawOutput: { waiting: true },
    }),
  ];
}

/**
 * 直接供 `ChatView` 渲染的条目样本：投影结果 + 图片附件形态。
 *
 * 投影路径（`projectEntries`）无法承载图片（源 `UserMessage` 无 images 字段，宿主投影同样会丢），
 * 因此 demo 若要展示图片缩略图，需走本函数直供 `entries` 并自行传 `isLoading`。
 */
export function createMockChatEntries(): ThreadEntry[] {
  const entries = projectMockEntries(createMockConversation());
  return entries.map((entry) =>
    entry.type === "user_message" && entry.id === "user-1"
      ? {
          ...entry,
          images: [
            {
              mimeType: "image/png",
              // 1×1 透明 PNG：`data` 是发送路径（`prepareImageContent` → `atob`）要求的载荷，
              // 历史样本不会再次发送，这里仅作占位，渲染不会用到它。
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
              // 展示走真实远程图：demo 里能看到实际照片，而不是一块 1×1 像素拉成的纯色方块。
              url: MOCK_USER_IMAGE_URL,
            },
          ],
        }
      : entry,
  );
}
