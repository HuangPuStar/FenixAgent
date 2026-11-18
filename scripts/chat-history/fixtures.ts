import type { ChatEntry, NormalizedEvent, PlanEntry, StructuredMessage, ToolCallProjection } from "@fenix/chat-channel";

/** 固定源条目附带实际存在的计划和用量字段。 */
export interface HistoryFixtureEntry extends ChatEntry {
  planEntries?: PlanEntry[];
  tokenUsage?: { totalTokens: number; contextWindow: number };
}
/** 性能样本共享的合成历史，预期可见字段独立于生产 mapper 编写。 */
export interface HistoryFixture {
  entries: readonly HistoryFixtureEntry[];
  tools: readonly ToolCallProjection[];
  events: readonly NormalizedEvent[];
  expectedTail: readonly FixtureExpectedMessage[];
}
/** 对照仅去掉随总历史位置变化的 seq，保留身份、顺序及完整可见内容。 */
export type FixtureExpectedMessage =
  | Omit<Extract<StructuredMessage, { type: "assistant_message" }>, "seq">
  | Omit<Extract<StructuredMessage, { type: "user_message" }>, "seq">
  | Extract<StructuredMessage, { type: "tool_call" | "plan" }>;

const CREATED_AT = "2026-11-01T00:00:00.000Z";
const TS = Date.parse(CREATED_AT);
const HISTORY_TEXT = "广州天气合成历史，验证分页下载与消息渲染。".repeat(12);

function entry(
  entryId: string,
  role: ChatEntry["role"],
  text: string,
  kind: ChatEntry["kind"] = "message",
): HistoryFixtureEntry {
  return {
    entryId,
    role,
    kind,
    turnId: entryId,
    status: "completed",
    authorUserId: null,
    createdAt: CREATED_AT,
    completedAt: CREATED_AT,
    error: null,
    blockOrder: ["text:1"],
    blocks: [{ blockId: "text:1", type: "text", text }],
  };
}

function tool(toolCallId: string): ToolCallProjection {
  return {
    toolCallId,
    turnId: "tail-special:assistant",
    name: "weather.query",
    status: "completed",
    arguments: { city: "广州" },
    result: { text: "晴，26℃", humidity: 60 },
    publicError: null,
    permissionId: null,
  };
}

/** 构造精确 N 个源条目；最后 100 个内容和身份不受总规模影响。 */
export function createHistoryFixture(entryCount: number): HistoryFixture {
  if (!Number.isSafeInteger(entryCount) || entryCount < 100) throw new Error("entryCount must be an integer >= 100");
  const entries: HistoryFixtureEntry[] = [];
  for (let index = 0; index < entryCount - 100; index++)
    entries.push(entry(`history:${index}`, index % 2 ? "assistant" : "user", HISTORY_TEXT));
  for (let index = 0; index < 92; index++)
    entries.push(entry(`tail:${index}`, index % 2 ? "assistant" : "user", `固定末页 ${index}：${HISTORY_TEXT}`));

  const assistant = entry("tail-special:assistant", "assistant", "正在查询");
  assistant.blockOrder = ["reasoning:1", "text:1", "tool:1", "text:2"];
  assistant.blocks = [
    { blockId: "reasoning:1", type: "reasoning", text: "检查天气来源", visibility: "summary" },
    { blockId: "text:1", type: "text", text: "正在查询" },
    { blockId: "tool:1", type: "tool_call", toolCallId: "tail-tool:weather" },
    { blockId: "text:2", type: "text", text: "广州晴，26℃" },
  ];
  assistant.tokenUsage = { totalTokens: 1200, contextWindow: 128000 };
  const pureTool = entry("tail-special:tool-only", "assistant", "");
  pureTool.blockOrder = ["tool:1"];
  pureTool.blocks = [{ blockId: "tool:1", type: "tool_call", toolCallId: "tail-tool:only" }];
  const plan = entry("tail-special:plan", "system", "", "system");
  plan.planEntries = [{ content: "查询广州天气", priority: "high", status: "completed" }];
  const failure = entry("tail-special:failure", "assistant", "");
  failure.blocks = [];
  failure.blockOrder = [];
  failure.status = "error";
  failure.error = {
    type: "AGENT_RUNTIME.REQUEST_FAILED",
    id: "err_00000000000000000000000000000001",
    message: "The Agent request failed.",
  };
  const resource = entry("tail-special:resource", "assistant", "天气文件已生成");
  resource.blockOrder.push("resource:1");
  resource.blocks.push({
    blockId: "resource:1",
    type: "resource",
    resourceId: "fixture-weather-file",
    mediaType: "text/plain",
    name: "天气.txt",
  });
  entries.push(
    entry("tail-special:user-a", "user", "广州天气？"),
    entry("tail-special:user-b", "user", "广州天气？"),
    assistant,
    pureTool,
    plan,
    failure,
    entry("tail-special:callback", "user", "后台任务结果"),
    resource,
  );
  const tools = [tool("tail-tool:weather"), tool("tail-tool:only")];
  const expectedTail: FixtureExpectedMessage[] = [
    { type: "user_message", id: "tail-special:user-a", content: "广州天气？", ts: TS },
    { type: "user_message", id: "tail-special:user-b", content: "广州天气？", ts: TS },
    {
      type: "assistant_message",
      id: "tail-special:assistant",
      chunks: [
        { type: "thought", text: "检查天气来源" },
        { type: "message", text: "正在查询" },
      ],
      ts: TS,
    },
    {
      type: "tool_call",
      id: "tail-tool:weather",
      title: "weather.query",
      status: "complete",
      content: [],
      rawInput: { city: "广州" },
      rawOutput: { text: "晴，26℃", humidity: 60 },
    },
    {
      type: "assistant_message",
      id: "tail-special:assistant#1",
      chunks: [{ type: "message", text: "广州晴，26℃" }],
      ts: TS,
    },
    {
      type: "tool_call",
      id: "tail-tool:only",
      title: "weather.query",
      status: "complete",
      content: [],
      rawInput: { city: "广州" },
      rawOutput: { text: "晴，26℃", humidity: 60 },
    },
    {
      type: "plan",
      id: "tail-special:plan",
      turnId: "tail-special:plan",
      entries: [{ content: "查询广州天气", priority: "high", status: "completed" }],
    },
    {
      type: "assistant_message",
      id: "tail-special:failure#error",
      chunks: [],
      ts: TS,
      error: {
        type: "AGENT_RUNTIME.REQUEST_FAILED",
        id: "err_00000000000000000000000000000001",
        message: "The Agent request failed.",
      },
    },
    { type: "user_message", id: "tail-special:callback", content: "后台任务结果", ts: TS },
    {
      type: "assistant_message",
      id: "tail-special:resource",
      chunks: [{ type: "message", text: "天气文件已生成" }],
      ts: TS,
    },
  ];
  const events: NormalizedEvent[] = [
    { type: "user_message", turnId: "fixture-live", update: {}, content: { type: "text", text: "继续查询" } },
    { type: "message_delta", turnId: "fixture-live", update: {}, content: { type: "text", text: "实时天气 🌤️" } },
    { type: "turn_completed", turnId: "fixture-live", update: {}, content: null },
  ];
  return { entries, tools, events, expectedTail };
}
