/**
 * Demo 用静态样本：覆盖 Chat UI 全部展示形态的内存态数据。
 *
 * 来源：字段形状来自 `web/chat/types.ts`（由 `apps/web/src/lib/types.ts`（旧路径，已于 2026-09-21 由 6679b4648 删除）、`@fenix/chat-channel`
 * 与 `packages/acp-link/src/types.ts` 逐字复制而来）；文案与工具入参按真实会话的形态编写，
 * 使组件在 demo 中呈现与产品一致的结构、密度与文案。
 *
 * 纯化改动点：
 * - 不含任何网络、YJS、路由、鉴权依赖；需要当前时刻的样本（60s 有效期的 AskUserQuestion、
 *   相对时间、用量）一律以工厂函数导出，避免静态常量在页面打开几分钟后失真。
 * - 已绑定 MCP 复用组件层 `McpOption`（与 `BoundMcpOption` 字段一致，不重复声明）。
 *
 * 数据边界：`StructuredMessage` 的 `user_message` 不承载图片附件（源 `UserMessage` 无该字段），
 * 图片形态由 `createMockChatEntries()` 在渲染条目层补充，仅供直接渲染 `ChatView` 的路径使用。
 *
 * 正文与流式脚本按体量拆到 `internal/`，此处只做 re-export，保持单一导入面。
 */

import type { McpOption } from "../composer/CommandMenu";
import type {
  AvailableCommand,
  CapabilitiesInfo,
  PeriTaskViewProjection,
  PermissionRequest,
  QuestionProjection,
  SessionMode,
  SessionSummary,
  TokenUsage,
} from "../types";
import {
  createMockChatEntries,
  createMockConversation,
  MOCK_PERMISSION_OPTIONS,
  MOCK_USER_IMAGE_URL,
} from "./internal/mock-conversation";
import { createMockStreamScript, type MockStreamStep } from "./internal/mock-stream-script";

export type { MockStreamStep };
export {
  createMockChatEntries,
  createMockConversation,
  createMockStreamScript,
  MOCK_PERMISSION_OPTIONS,
  MOCK_USER_IMAGE_URL,
};

/** demo 用的 agent/environment 标识（仅展示，不参与任何鉴权或持久化）。 */
export const MOCK_AGENT_ID = "env_demo_fenix";
/** demo 会话所属的确定性 RCS 会话 ID。 */
export const MOCK_RCS_SESSION_ID = "rcs_demo_ui_components";
/** demo 展示的模型名。 */
export const MOCK_MODEL_NAME = "claude-sonnet-4.5";
/** demo 初始会话模式。 */
export const MOCK_DEFAULT_MODE_ID = "default";

/** Agent 能力集（驱动 supportsImages 等能力展示）。 */
export const MOCK_CAPABILITIES: CapabilitiesInfo = {
  promptCapabilities: { image: true, embeddedContext: true },
  sessionCapabilities: { load: true, resume: true },
  mcpCapabilities: { http: true, sse: true },
  loadSession: true,
};

/** slash 命令样本。 */
export const MOCK_AVAILABLE_COMMANDS: AvailableCommand[] = [
  { name: "init", description: "初始化项目上下文", input: { hint: "可选：补充说明" } },
  { name: "review", description: "对当前改动做一次代码评审" },
  { name: "test", description: "运行与当前工作区相关的测试" },
  { name: "commit", description: "按仓库规范生成提交信息" },
];

/** 会话模式样本（对应 SessionModeSelector 与输入岛元信息条）。 */
export const MOCK_AVAILABLE_MODES: SessionMode[] = [
  { id: "default", name: "默认", description: "按需读写工作区" },
  { id: "plan", name: "计划", description: "只读分析，产出实施计划" },
  { id: "accept-edits", name: "自动接受编辑", description: "跳过文件编辑确认" },
];

/** 已绑定 MCP 样本（本轮上下文候选）。 */
export const MOCK_BOUND_MCPS: McpOption[] = [
  { id: "mcp_fs", name: "filesystem", description: "读写工作区文件" },
  { id: "mcp_chrome", name: "chrome-devtools", description: "浏览器调试与截图" },
];

/**
 * 初始会话列表（首条为 demo 默认活跃会话）。
 *
 * mock store 会在此基础上追加新建会话，因此以工厂函数导出。
 */
export function createMockSessionSummaries(): SessionSummary[] {
  const now = Date.now();
  return [
    {
      sessionId: MOCK_RCS_SESSION_ID,
      title: "把会话投影改成纯函数",
      preview: "按 context-queue 的既有风格把会话状态投影成纯函数…",
      status: "active",
      lastMsgTs: now - 60_000 * 3,
      cwd: "/workspace/fenix-agent",
      updatedAt: new Date(now - 60_000 * 3).toISOString(),
    },
    {
      sessionId: "rcs_demo_ui_components_2",
      title: "多标签页状态隔离排查",
      preview: "确认 rcsSessionId 的确定性生成不会跨标签页串号。",
      status: "idle",
      lastMsgTs: now - 60_000 * 90,
      cwd: "/workspace/fenix-agent",
      updatedAt: new Date(now - 60_000 * 90).toISOString(),
    },
    {
      sessionId: "rcs_demo_ui_components_3",
      title: "补 precheck 的失败用例",
      preview: "把 precheck 里遗漏的边界用例补上。",
      status: "done",
      lastMsgTs: now - 60_000 * 60 * 26,
      cwd: "/workspace/fenix-agent",
      updatedAt: new Date(now - 60_000 * 60 * 26).toISOString(),
    },
  ];
}

/** Peri 任务样本（状态面板「任务」Tab；覆盖 running / completed / failed 三种状态）。 */
export function createMockPeriTasks(): PeriTaskViewProjection[] {
  const now = Date.now();
  return [
    {
      taskId: "task_subagent_1",
      kind: "subagent",
      taskSubtype: "agent",
      title: "排查多标签页状态串号",
      summary: "子 Agent 仍在比对 rcsSessionId 与 Y.Doc 名称的绑定关系。",
      status: "running",
      turnId: "turn-2",
      isBackground: false,
      startedAt: new Date(now - 60_000).toISOString(),
      completedAt: null,
      updatedAt: new Date(now - 5_000).toISOString(),
      detailAvailability: "preview",
    },
    {
      taskId: "task_background_1",
      kind: "background",
      taskSubtype: "shell",
      title: "bun run precheck",
      summary: "format / lint / tsc / 后端测试全部通过。",
      status: "completed",
      turnId: "turn-1",
      isBackground: true,
      startedAt: new Date(now - 60_000 * 12).toISOString(),
      completedAt: new Date(now - 60_000 * 11).toISOString(),
      updatedAt: new Date(now - 60_000 * 11).toISOString(),
      detailAvailability: "preview",
    },
    {
      taskId: "task_background_2",
      kind: "background",
      taskSubtype: "workflow",
      title: "生成迁移快照",
      summary: "数据库连接串缺失，任务已终止。",
      status: "failed",
      turnId: "turn-1",
      isBackground: true,
      startedAt: new Date(now - 60_000 * 9).toISOString(),
      completedAt: new Date(now - 60_000 * 9).toISOString(),
      updatedAt: new Date(now - 60_000 * 9).toISOString(),
      detailAvailability: "expired",
    },
  ];
}

/** 首屏待应答的权限请求（对应时间线里 waiting_for_confirmation 的 Bash 调用）。 */
export function createMockPermissions(): PermissionRequest[] {
  return [
    {
      id: "perm-demo-1",
      tool: "Bash",
      args: { command: "bun run build:web" },
      level: "ask",
      status: "pending",
      ts: Date.now() - 30_000,
      options: MOCK_PERMISSION_OPTIONS,
    },
  ];
}

/**
 * 首屏待应答的 AskUserQuestion 投影。
 *
 * 约定：问题 id 与时间线中 AskUserQuestion 工具调用的 `id` 相同，mock 应答时据此同步工具状态。
 * `expiresAt` 取调用时刻 +60s，与后端 60s 超时 CAS 一致（因此本样本必须由工厂函数生成）。
 */
export function createMockQuestions(): Map<string, QuestionProjection> {
  const now = Date.now();
  return new Map<string, QuestionProjection>([
    [
      "question-demo-1",
      {
        questionId: "question-demo-1",
        status: "pending",
        description: "Agent 在继续之前需要你选一个方向。",
        expiresAt: new Date(now + 60_000).toISOString(),
        answer: null,
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
    ],
  ]);
}

/** 会话用量样本（驱动输入岛上下文计与环形指示）。 */
export function createMockTokenUsage(): TokenUsage {
  return { totalTokens: 18_432, inputTokens: 16_220, outputTokens: 2_212, contextWindow: 200_000 };
}
