// packages/chat-channel/src/__tests__/doc-schema.test.ts
// 新 schema（文档 5.2/5.3）结构测试：初始化结构、projectionVersion 演进、
// tombstone 清理、Doc 职责错位纠正（Chat Doc 无状态字段、Session Doc 无时间线字段）。

import { beforeEach, expect, test } from "bun:test";
import * as Y from "yjs";
import { CHAT_DOC_SCHEMA_VERSION, type NormalizedEvent, SESSION_DOC_SCHEMA_VERSION } from "../schema";
import { applyNormalizedEvent, type DocPair } from "../state/aggregator";
import {
  clearChatDocContent,
  clearSessionDocContent,
  getChatRoot,
  getEntryOrder,
  getSessionInfo,
  getSessionRoot,
  setActiveTurn,
} from "../state/chat-writer";
import { createChatDoc, createSessionDoc } from "../state/factory";

let pair: DocPair;

beforeEach(() => {
  pair = {
    chat: createChatDoc("rcs_test", null).ydoc,
    session: createSessionDoc("rcs_test", null).ydoc,
  };
});

/** 构造规范化事件（测试辅助） */
function event(type: NormalizedEvent["type"], update: Record<string, unknown> = {}, turnId?: string): NormalizedEvent {
  return {
    type,
    update,
    content: (update.content as Record<string, unknown>) ?? null,
    turnId,
  };
}

/** 读取 Chat Doc 根键集合（验证职责边界） */
function chatRootKeys(): string[] {
  return Array.from(getChatRoot(pair.chat).keys()).sort();
}

/** 读取 Session Doc 根键集合 */
function sessionRootKeys(): string[] {
  return Array.from(getSessionRoot(pair.session).keys()).sort();
}

// Chat Doc 初始化后根键只有时间线与投影世代字段
// （schemaVersion/projectionVersion/projectionGeneration/entryOrder/entries/toolCalls）
test("chat doc root contains only timeline fields", () => {
  expect(chatRootKeys()).toEqual([
    "entries",
    "entryOrder",
    "projectionGeneration",
    "projectionVersion",
    "schemaVersion",
    "toolCalls",
  ]);
  expect(getChatRoot(pair.chat).get("schemaVersion")).toBe(CHAT_DOC_SCHEMA_VERSION);
  expect(getChatRoot(pair.chat).get("projectionVersion")).toBe(1);
});

// Session Doc 初始化后根键只有元信息字段（session/agent/pendingPermissions/pendingQuestions/sessions）
test("session doc root contains only metadata fields", () => {
  expect(sessionRootKeys()).toEqual([
    "agent",
    "pendingPermissions",
    "pendingQuestions",
    "projectionGeneration",
    "projectionVersion",
    "schemaVersion",
    "session",
    "sessions",
  ]);
  expect(getSessionRoot(pair.session).get("schemaVersion")).toBe(SESSION_DOC_SCHEMA_VERSION);
});

// Doc 职责错位纠正：Chat Doc 不存在任何旧状态字段（agentInfo/sessions/chatMeta/connection/permissions 等）
test("chat doc has no legacy state fields", () => {
  const legacy = [
    "agentInfo",
    "sessions",
    "chatMeta",
    "connection",
    "permissions",
    "capabilities",
    "modelState",
    "modeState",
    "availableCommands",
    "tokenUsage",
    "messages",
    "streaming",
    "tools",
    "artifacts",
    "structuredMessages",
  ];
  for (const field of legacy) {
    expect(chatRootKeys()).not.toContain(field);
    expect(pair.chat.getMap(field).size).toBe(0);
  }
});

// Doc 职责错位纠正：Session Doc 不存在任何时间线字段
test("session doc has no timeline fields", () => {
  const legacy = ["messages", "streaming", "tools", "artifacts", "structuredMessages", "meta"];
  for (const field of legacy) {
    expect(sessionRootKeys()).not.toContain(field);
    expect(pair.session.getMap(field).size).toBe(0);
  }
});

// session_updated 携带 models/modes（session/new、load 响应）→ Session Doc session map
// 投影 modelState/modeState（会话级元数据：前端模型名与模式选择器的数据源）
test("session_updated with models/modes projects model and mode state", () => {
  applyNormalizedEvent(pair, {
    type: "session_updated",
    update: {
      sessionId: "ses_1",
      status: "ready",
      modelState: {
        currentModelId: "model-b",
        availableModels: [
          { modelId: "model-a", name: "Model A" },
          { modelId: "model-b", name: "Model B" },
        ],
      },
      modeState: {
        currentModeId: "code",
        availableModes: [{ id: "code", name: "Code" }],
      },
    },
    content: null,
  });

  const session = getSessionRoot(pair.session).get("session") as Y.Map<unknown>;
  const modelState = session.get("modelState") as Y.Map<unknown>;
  expect(modelState.get("currentModelId")).toBe("model-b");
  const models = modelState.get("availableModels") as Y.Array<Y.Map<unknown>>;
  expect(models.length).toBe(2);
  expect(models.get(0)?.get("modelId")).toBe("model-a");
  expect(models.get(1)?.get("name")).toBe("Model B");
  const modeState = session.get("modeState") as Y.Map<unknown>;
  expect(modeState.get("currentModeId")).toBe("code");
  const modes = modeState.get("availableModes") as Y.Array<Y.Map<unknown>>;
  expect(modes.length).toBe(1);
  expect(modes.get(0)?.get("id")).toBe("code");

  // 切换会话（clearSessionDocContent）清空 session map：model/mode 随会话重建，不留旧值
  clearSessionDocContent(pair.session);
  expect((getSessionRoot(pair.session).get("session") as Y.Map<unknown>).get("modelState")).toBeUndefined();
});

// available_commands_update（agent 启动后下发）→ Session Doc session map 投影，
// 切换会话时随 session map 清空，不留旧会话的命令
test("session_updated with availableCommands projects commands and clears on session switch", () => {
  applyNormalizedEvent(pair, {
    type: "session_updated",
    update: {
      sessionId: "ses_1",
      status: "ready",
      availableCommands: [
        { name: "help", description: "Show help", input: { hint: "command name" } },
        { name: "clear", description: "Clear chat" },
      ],
    },
    content: null,
  });

  const session = getSessionRoot(pair.session).get("session") as Y.Map<unknown>;
  const availableCommands = session.get("availableCommands") as Y.Array<Y.Map<unknown>>;
  expect(availableCommands.length).toBe(2);
  expect(availableCommands.get(0)?.get("name")).toBe("help");
  expect(availableCommands.get(0)?.get("input")).toEqual({ hint: "command name" });
  expect(availableCommands.get(1)?.get("description")).toBe("Clear chat");

  // 切换会话（clearSessionDocContent）清空 session map：命令随会话重建，不留旧值
  clearSessionDocContent(pair.session);
  expect((getSessionRoot(pair.session).get("session") as Y.Map<unknown>).get("availableCommands")).toBeUndefined();
});

// 每次成功投影后按「实际触碰的 Doc」递增 projectionVersion（SP-A2）：事件只
// 修改了哪份 Doc，哪份才 +1——流式稳态增量只触碰 Chat Doc，Session Doc 版本
// 不动（消除 session: 广播与 Redis 快照 CAS 的版本噪声）
test("projectionVersion bumps only on docs touched by the applied event", () => {
  // user_message：双 Doc（user/assistant entry 写 Chat；activeTurn accepting 写 Session）
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
  // 首个增量：双 Doc（文本追加写 Chat；accepting→running 迁移写 Session）
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "hello" } }));
  expect(getChatRoot(pair.chat).get("projectionVersion")).toBe(3);
  expect(getSessionRoot(pair.session).get("projectionVersion")).toBe(3);

  // 稳态增量：status 已 streaming、turn 已 running（同值短路零写入），只 Chat Doc +1
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: " world" } }));
  expect(getChatRoot(pair.chat).get("projectionVersion")).toBe(4);
  expect(getSessionRoot(pair.session).get("projectionVersion")).toBe(3);

  // 终态：双 Doc（entry 终态写 Chat；activeTurn 终态与收敛写 Session）
  applyNormalizedEvent(pair, event("turn_completed", { usage: { totalTokens: 10 } }));
  expect(getChatRoot(pair.chat).get("projectionVersion")).toBe(5);
  expect(getSessionRoot(pair.session).get("projectionVersion")).toBe(4);

  // 被拒绝的事件（终态后增量）不 bump 任何 Doc
  const chatBefore = getChatRoot(pair.chat).get("projectionVersion") as number;
  const sessionBefore = getSessionRoot(pair.session).get("projectionVersion") as number;
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "late" } }));
  expect(getChatRoot(pair.chat).get("projectionVersion")).toBe(chatBefore);
  expect(getSessionRoot(pair.session).get("projectionVersion")).toBe(sessionBefore);
});

// SP-A2 验收：流式稳态期间 N 条 message_delta 只产生 Chat Doc update，
// Session Doc 零 update——订阅 update 事件计数（对应广播帧 / Redis 快照 CAS 次数）
test("steady-state message deltas emit chat doc updates only, zero session doc updates", () => {
  let chatUpdates = 0;
  let sessionUpdates = 0;
  pair.chat.on("update", () => chatUpdates++);
  pair.session.on("update", () => sessionUpdates++);

  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
  expect(chatUpdates).toBe(1);
  expect(sessionUpdates).toBe(1);

  // 首个增量含 accepting→running 迁移：两份 Doc 各一次 update
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "h" } }));
  expect(chatUpdates).toBe(2);
  expect(sessionUpdates).toBe(2);

  // 稳态 N 条增量：Chat Doc 每条一次 update（真实文本内容），Session Doc 零 update
  for (let i = 0; i < 20; i++) {
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "x" } }));
  }
  expect(chatUpdates).toBe(22);
  expect(sessionUpdates).toBe(2);
});

// SP-A2 验收：session_list 重复相同响应（10s 空转轮询）零 doc update；
// 首个响应落 sessionListLoaded（前端 bootstrap「确认无会话」语义不受影响）
test("repeated identical session_list responses produce zero session doc updates", () => {
  let sessionUpdates = 0;
  pair.session.on("update", () => sessionUpdates++);

  const response = () =>
    event("session_list", { sessions: [{ sessionId: "ses_1", title: "A", updatedAt: "2026-08-05T00:00:00.000Z" }] });

  const first = applyNormalizedEvent(pair, response());
  expect(first.applied).toBe(true);
  expect(getSessionRoot(pair.session).get("sessionListLoaded")).toBe(true);
  expect(sessionUpdates).toBe(1); // 首响：sessions 条目 + sessionListLoaded + 版本 bump

  // 完全相同的响应：applied=false 且零 update（无广播帧、无快照 CAS）
  const second = applyNormalizedEvent(pair, response());
  expect(second.applied).toBe(false);
  expect(sessionUpdates).toBe(1);

  // 内容真实变化（新会话）时恢复写入
  const third = applyNormalizedEvent(
    pair,
    event("session_list", {
      sessions: [
        { sessionId: "ses_1", title: "A", updatedAt: "2026-08-05T00:00:00.000Z" },
        { sessionId: "ses_2", title: "B", updatedAt: "2026-08-05T00:02:00.000Z" },
      ],
    }),
  );
  expect(third.applied).toBe(true);
  expect(sessionUpdates).toBe(2);
});

// 完整消息时间线投影：user entry + assistant entry（含 Y.Text 流式块）
test("user message creates user and assistant entries with text blocks", () => {
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "Hello" } }));
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: " world" } }));

  const order = getEntryOrder(pair.chat).toArray();
  expect(order).toEqual(["turn_1:user", "turn_1:assistant"]);

  const entries = getChatRoot(pair.chat).get("entries") as Y.Map<Y.Map<unknown>>;
  const user = entries.get("turn_1:user")!;
  expect(user.get("kind")).toBe("message");
  expect(user.get("role")).toBe("user");
  expect(user.get("status")).toBe("completed");

  const assistant = entries.get("turn_1:assistant")!;
  expect(assistant.get("status")).toBe("streaming");
  const blocks = assistant.get("blocks") as Y.Map<Y.Map<unknown>>;
  const textBlock = blocks.get("text") as Y.Map<unknown>;
  expect(textBlock.get("type")).toBe("text");
  // 流式文本使用 Y.Text 累积，而非整串替换
  const ytext = textBlock.get("text") as Y.Text;
  expect(ytext.toString()).toBe("Hello world");
});

// 思考块按 summary 可见性投影到 assistant entry
test("reasoning delta appends to reasoning block with summary visibility", () => {
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "q" } }, "turn_1"));
  applyNormalizedEvent(pair, event("reasoning_delta", { content: { type: "text", text: "think..." } }));

  const entries = getChatRoot(pair.chat).get("entries") as Y.Map<Y.Map<unknown>>;
  const assistant = entries.get("turn_1:assistant")!;
  const blocks = assistant.get("blocks") as Y.Map<Y.Map<unknown>>;
  const reasoning = blocks.get("reasoning") as Y.Map<unknown>;
  expect(reasoning.get("type")).toBe("reasoning");
  expect(reasoning.get("visibility")).toBe("summary");
  expect((reasoning.get("text") as Y.Text).toString()).toBe("think...");
});

// 工具调用投影：toolCalls 收敛在 Chat Doc 根，entry 内挂 tool_call block
test("tool call projects to toolCalls map and entry block", () => {
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "q" } }, "turn_1"));
  applyNormalizedEvent(
    pair,
    event("tool_call_started", { toolCallId: "t1", title: "read_file", rawInput: { path: "/a" } }),
  );
  applyNormalizedEvent(pair, event("tool_call_completed", { toolCallId: "t1", rawOutput: { text: "ok" } }));

  const toolCalls = getChatRoot(pair.chat).get("toolCalls") as Y.Map<Y.Map<unknown>>;
  const tool = toolCalls.get("t1")!;
  expect(tool.get("name")).toBe("read_file");
  expect(tool.get("status")).toBe("completed");
  expect(tool.get("turnId")).toBe("turn_1");

  const entries = getChatRoot(pair.chat).get("entries") as Y.Map<Y.Map<unknown>>;
  const assistant = entries.get("turn_1:assistant")!;
  const blocks = assistant.get("blocks") as Y.Map<Y.Map<unknown>>;
  expect(blocks.get("tool:t1")?.get("type")).toBe("tool_call");
});

// 权限请求投影到 Session Doc pendingPermissions（pending 状态）
test("permission request projects to session doc pendingPermissions", () => {
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "q" } }, "turn_1"));
  applyNormalizedEvent(
    pair,
    event("permission_requested", {
      permissionId: "p1",
      title: "Run command",
      options: ["allow_once", "reject_always"],
      toolCallId: "t1",
    }),
  );

  const pending = getSessionRoot(pair.session).get("pendingPermissions") as Y.Map<Y.Map<unknown>>;
  const permission = pending.get("p1")!;
  expect(permission.get("status")).toBe("pending");
  expect(permission.get("title")).toBe("Run command");
  expect(permission.get("options")).toEqual(["allow_once", "deny"]);
  expect(permission.get("turnId")).toBe("turn_1");
  expect(permission.get("toolCallId")).toBe("t1");
  // 请求时刻无决议：decision 必须为 null（CAS 迁移成功后由 permission.ts 写入）
  expect(permission.get("decision")).toBeNull();
});

// Agent 状态与能力投影到 Session Doc agent
test("agent status projects to session doc agent", () => {
  applyNormalizedEvent(
    pair,
    event("agent_status", {
      instanceId: "inst_1",
      acpSessionId: "ses_1",
      status: "ready",
      capabilities: { loadSession: true, promptCapabilities: { image: true } },
    }),
  );

  const agent = getSessionRoot(pair.session).get("agent") as Y.Map<unknown>;
  expect(agent.get("instanceId")).toBe("inst_1");
  expect(agent.get("acpSessionId")).toBe("ses_1");
  expect(agent.get("status")).toBe("ready");
  const caps = agent.get("capabilities") as Y.Map<boolean>;
  expect(caps.get("loadSession")).toBe(true);
});

// tombstone 清理：切换会话时清空两份 Doc 但保留 schema 骨架，projectionVersion 提升
test("clear resets docs keeping schema skeleton and bumping projectionVersion", () => {
  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "hi" } }, "turn_1"));
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "hello" } }));

  pair.chat.transact(() => {
    getChatRoot(pair.chat).set("planSeq", 1);
  });

  const chatVersionBefore = getChatRoot(pair.chat).get("projectionVersion") as number;
  // 使用与 doc-manager 相同的清理原语（领域 tombstone：清内容、留骨架、升版本）
  clearChatDocContent(pair.chat);
  clearSessionDocContent(pair.session);

  // 骨架保留
  expect(getChatRoot(pair.chat).get("schemaVersion")).toBe(CHAT_DOC_SCHEMA_VERSION);
  expect(chatRootKeys()).toEqual([
    "entries",
    "entryOrder",
    "projectionGeneration",
    "projectionVersion",
    "schemaVersion",
    "toolCalls",
  ]);
  expect(getEntryOrder(pair.chat).length).toBe(0);
  expect((getChatRoot(pair.chat).get("entries") as Y.Map<unknown>).size).toBe(0);
  expect((getChatRoot(pair.chat).get("toolCalls") as Y.Map<unknown>).size).toBe(0);
  // planSeq 是投影派生的临时序号，随清理一并移除
  expect(getChatRoot(pair.chat).get("planSeq")).toBeUndefined();
  // projectionVersion 演进
  expect(getChatRoot(pair.chat).get("projectionVersion")).toBeGreaterThan(chatVersionBefore);
  // sessions 是 agent 级投影，清理后保留（键集不变）；内容断言见 session_list 用例
  expect(sessionRootKeys()).toEqual([
    "agent",
    "pendingPermissions",
    "pendingQuestions",
    "projectionGeneration",
    "projectionVersion",
    "schemaVersion",
    "session",
    "sessions",
  ]);
});

// session_list 事件：全量同步到 Session Doc sessions 投影（字段、幂等、删除自愈、clear 保留）
test("session_list syncs sessions map with idempotent full sync", () => {
  const listResponse = (sessions: Array<Record<string, unknown>>) => event("session_list", { sessions });

  // 首次同步：两条会话
  applyNormalizedEvent(
    pair,
    listResponse([
      { sessionId: "ses_1", title: "A", updatedAt: "2026-08-05T00:00:00.000Z" },
      { sessionId: "ses_2", title: "B", cwd: "/tmp/b", updatedAt: "2026-08-05T00:01:00.000Z" },
    ]),
  );
  const sessions = getSessionRoot(pair.session).get("sessions") as Y.Map<Y.Map<unknown>>;
  expect(sessions.size).toBe(2);
  const ses1 = sessions.get("ses_1")!;
  expect(ses1.get("sessionId")).toBe("ses_1");
  expect(ses1.get("title")).toBe("A");
  expect(ses1.get("cwd")).toBeNull();
  expect(ses1.get("updatedAt")).toBe("2026-08-05T00:00:00.000Z");
  expect(sessions.get("ses_2")?.get("cwd")).toBe("/tmp/b");

  // 重放同一响应：幂等，不重复追加
  applyNormalizedEvent(
    pair,
    listResponse([
      { sessionId: "ses_1", title: "A", updatedAt: "2026-08-05T00:00:00.000Z" },
      { sessionId: "ses_2", title: "B", cwd: "/tmp/b", updatedAt: "2026-08-05T00:01:00.000Z" },
    ]),
  );
  expect(sessions.size).toBe(2);

  // 响应去掉 ses_2 → 全量同步删除旧条目（agent 侧删除自愈）
  applyNormalizedEvent(pair, listResponse([{ sessionId: "ses_1", title: "A" }]));
  expect(sessions.size).toBe(1);
  expect(sessions.has("ses_2")).toBe(false);

  // 缺失 sessionId 的条目被跳过
  applyNormalizedEvent(pair, listResponse([{ sessionId: "ses_1", title: "A" }, { title: "no-id" }]));
  expect(sessions.size).toBe(1);

  // clearSessionDocContent 保留 sessions（agent 级数据，跨会话切换不闪空）
  clearSessionDocContent(pair.session);
  expect(sessions.size).toBe(1);
  expect(sessionRootKeys()).toEqual([
    "agent",
    "pendingPermissions",
    "pendingQuestions",
    "projectionGeneration",
    "projectionVersion",
    "schemaVersion",
    "session",
    "sessionListLoaded",
    "sessions",
  ]);
});

// 空列表保护：agent 重启后列表尚未恢复或全部条目被 acp-link"空标题/New session"
// 过滤时，瞬时空响应不得清空已有条目（否则叠加当前会话 title 缺失，
// 侧边栏全部显示"新会话"）；真实删除由非空响应自愈
test("session_list 空列表不清空已有 sessions 条目", () => {
  applyNormalizedEvent(
    pair,
    event("session_list", {
      sessions: [
        { sessionId: "ses_1", title: "A" },
        { sessionId: "ses_2", title: "B" },
      ],
    }),
  );
  const sessions = getSessionRoot(pair.session).get("sessions") as Y.Map<Y.Map<unknown>>;
  expect(sessions.size).toBe(2);

  // 空响应：保留已有条目与标题
  applyNormalizedEvent(pair, event("session_list", { sessions: [] }));
  expect(sessions.size).toBe(2);
  expect(sessions.get("ses_1")?.get("title")).toBe("A");
  expect(sessions.get("ses_2")?.get("title")).toBe("B");

  // 非空响应仍正常删除（agent 侧删除自愈语义不受影响）
  applyNormalizedEvent(pair, event("session_list", { sessions: [{ sessionId: "ses_1", title: "A" }] }));
  expect(sessions.size).toBe(1);
  expect(sessions.has("ses_2")).toBe(false);
});

// 展示态三字段（presenting/loading/canCancel）是 session map 的平铺键：setActiveTurn
// 同步投影，turn 为 null 的清空分支同样投影（idle / null / false），前端只读
test("active turn presentation fields are flat keys on session map", () => {
  setActiveTurn(pair.session, "turn_1", "running");
  const running = getSessionInfo(pair.session);
  expect(running.get("presenting")).toBe("responding");
  expect(running.get("loading")).toEqual({ kind: "session/respond", since: running.get("activeTurnUpdatedAt") });
  expect(running.get("canCancel")).toBe(true);

  // 清空 turn（无活动 turn）：presenting=idle、loading=null、canCancel=false
  setActiveTurn(pair.session, null, null);
  const idle = getSessionInfo(pair.session);
  expect(idle.get("presenting")).toBe("idle");
  expect(idle.get("loading")).toBeNull();
  expect(idle.get("canCancel")).toBe(false);
});
