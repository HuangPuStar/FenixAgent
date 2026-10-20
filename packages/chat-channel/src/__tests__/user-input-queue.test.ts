// packages/chat-channel/src/__tests__/user-input-queue.test.ts
// Peri 待发送队列（steer）投影测试：事件规范化（未知类型仍丢弃）、快照收敛
// （换代清空 / revision 单调）、delivered 摘除与用户 entry 写入、重复应用幂等、
// 能力未协商回退（enabled=false）。

import { beforeEach, expect, test } from "bun:test";
import * as Y from "yjs";
import { normalizeAcpMessage } from "../protocol/acp-channel";
import {
  type NormalizedEvent,
  type NormalizedUserInputQueueEvent,
  USER_INPUT_IMAGE_PLACEHOLDER,
  USER_INPUT_QUEUE_MAX_ITEMS,
  type UserInputQueueSnapshot,
} from "../schema";
import { applyNormalizedEvent, type DocPair } from "../state/aggregator";
import { getAgentStatus, getEntriesMap, getEntry, getEntryOrder, getSessionRoot } from "../state/chat-writer";
import { createChatDoc, createSessionDoc } from "../state/factory";
import {
  applyUserInputQueueEvent,
  readUserInputQueue,
  resetUserInputQueue,
  setUserInputQueueEnabled,
} from "../state/user-input-queue";

let pair: DocPair;

beforeEach(() => {
  pair = {
    chat: createChatDoc("rcs_steer", null).ydoc,
    session: createSessionDoc("rcs_steer", null).ydoc,
  };
});

/** 构造 peri/agent_event 帧（event_json 为 JSON 字符串，serde tag/content 结构） */
function periAgentEventFrame(type: string, value: Record<string, unknown>): unknown {
  return {
    jsonrpc: "2.0",
    method: "peri/agent_event",
    params: { sessionId: "ses_steer", event_json: JSON.stringify({ type, value }) },
  };
}

/** 规范化帧并按类型收窄（未规范化时抛错，避免测试在 null 上静默通过） */
function normalizeFrame<T extends NormalizedEvent["type"]>(
  frame: unknown,
  expected: T,
): Extract<NormalizedUserInputQueueEvent, { type: T }> {
  const normalized = normalizeAcpMessage(frame);
  expect(normalized?.type).toBe(expected);
  return normalized as Extract<NormalizedUserInputQueueEvent, { type: T }>;
}

/** 构造队列事件（绕过 wire 层，直接驱动投影） */
function queueEvent(snapshot: Partial<UserInputQueueSnapshot> & { generation: string }): NormalizedEvent {
  return {
    type: "user_input_queue_changed",
    update: {},
    content: null,
    snapshot: {
      revision: 1,
      activeRequestId: null,
      items: [],
      ...snapshot,
    },
  } as NormalizedEvent;
}

/** 构造 delivered 规范化事件（wire 帧不带 turnId，由控制面注入） */
function deliveredEvent(inputId: string, text: string, turnId: string | null = null): NormalizedEvent {
  return {
    type: "user_input_delivered",
    update: {},
    content: { type: "text", text },
    generation: "gen_1",
    input_id: inputId,
    turnId,
  } as NormalizedEvent;
}

// 三个待发送队列事件经 peri/agent_event 规范化为扁平字段事件（snapshot / generation / request_id / input_id）
test("normalizes the three peri user input queue events with flat fields", () => {
  const changed = normalizeFrame(
    periAgentEventFrame("user_input_queue_changed", {
      snapshot: {
        session_id: "ses_steer",
        generation: "gen_1",
        revision: 3,
        active_request_id: "req_1",
        items: [
          { input_id: "in_1", content: "hello", original_draft: "hello draft", state: "queued" },
          { input_id: "in_2", content: "world", original_draft: "", state: "dispatching" },
        ],
      },
    }),
    "user_input_queue_changed",
  );
  expect(changed.acpSessionId).toBe("ses_steer");
  expect(changed.snapshot).toEqual({
    generation: "gen_1",
    revision: 3,
    activeRequestId: "req_1",
    items: [
      { inputId: "in_1", content: "hello", originalDraft: "hello draft", state: "queued" },
      { inputId: "in_2", content: "world", originalDraft: "", state: "dispatching" },
    ],
  });

  const started = normalizeFrame(
    periAgentEventFrame("user_input_run_started", { generation: "gen_1", request_id: "req_1" }),
    "user_input_run_started",
  );
  expect(started.generation).toBe("gen_1");
  expect(started.request_id).toBe("req_1");

  const delivered = normalizeFrame(
    periAgentEventFrame("user_input_delivered", { generation: "gen_1", input_id: "in_1", content: "hello" }),
    "user_input_delivered",
  );
  expect(delivered.input_id).toBe("in_1");
  expect(delivered.generation).toBe("gen_1");
  // 展示文本走基类 content（与 user_message 同形）
  expect(delivered.content).toEqual({ type: "text", text: "hello" });
});

// 未知 event type 仍然丢弃；未放行的既有 subagent 事件不受本次扩展影响
test("still drops unknown peri agent events and keeps subagent normalization working", () => {
  expect(normalizeAcpMessage(periAgentEventFrame("user_input_takeback", { generation: "gen_1" }))).toBeNull();
  expect(normalizeAcpMessage(periAgentEventFrame("something_else", { snapshot: { generation: "gen_1" } }))).toBeNull();
  // 缺 generation 的队列快照无法判定换代 → 丢弃，不生成半成品事件
  expect(
    normalizeAcpMessage(periAgentEventFrame("user_input_queue_changed", { snapshot: { revision: 1 } })),
  ).toBeNull();
  // 缺 input_id 的 delivered → 丢弃
  expect(
    normalizeAcpMessage(periAgentEventFrame("user_input_delivered", { generation: "gen_1", content: "hi" })),
  ).toBeNull();

  const subagent = normalizeAcpMessage(
    periAgentEventFrame("subagent_started", { instance_id: "inst_1", agent_name: "reviewer" }),
  );
  expect(subagent?.type).toBe("peri_task_started");
});

// MessageContent 归一化：图片块只留占位标记（base64 绝不进 Y.Doc），文本块与纯字符串照常展示
test("normalizes MessageContent images into a placeholder without base64 payload", () => {
  const changed = normalizeFrame(
    periAgentEventFrame("user_input_queue_changed", {
      snapshot: {
        generation: "gen_1",
        revision: 1,
        items: [
          {
            input_id: "in_img",
            content: [
              { type: "text", text: "look" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "AAAABBBBCCCC" },
              },
            ],
            original_draft: "look",
            state: "queued",
          },
        ],
      },
    }),
    "user_input_queue_changed",
  );
  expect(changed.snapshot.items[0].content).toBe(`look\n${USER_INPUT_IMAGE_PLACEHOLDER}`);
  expect(JSON.stringify(changed.snapshot)).not.toContain("AAAABBBBCCCC");
});

// 快照内 inputId 重复时按键去重（重复项会让前端渲染两个同名待发送气泡）
test("deduplicates snapshot items by inputId", () => {
  const changed = normalizeFrame(
    periAgentEventFrame("user_input_queue_changed", {
      snapshot: {
        generation: "gen_1",
        revision: 1,
        items: [
          { input_id: "in_1", content: "a", original_draft: "", state: "queued" },
          { input_id: "in_1", content: "a", original_draft: "", state: "queued" },
          // 缺 inputId 的项无法键控，直接丢弃
          { content: "no id", original_draft: "", state: "queued" },
        ],
      },
    }),
    "user_input_queue_changed",
  );
  expect(changed.snapshot.items.map((item) => item.inputId)).toEqual(["in_1"]);
});

// 队列快照应用后 items 顺序与字段与快照一致；超量项按 PENDING_CAPACITY 截断
test("applies snapshot items in order and truncates over capacity", () => {
  applyUserInputQueueEvent(
    pair.session,
    queueEvent({
      generation: "gen_1",
      revision: 1,
      items: [
        { inputId: "in_1", content: "a", originalDraft: "a", state: "queued" },
        { inputId: "in_2", content: "b", originalDraft: "", state: "claimed" },
      ],
    }),
  );
  const view = readUserInputQueue(pair.session);
  expect(view.generation).toBe("gen_1");
  expect(view.revision).toBe(1);
  expect(view.items.map((item) => item.inputId)).toEqual(["in_1", "in_2"]);
  expect(view.items[1].state).toBe("claimed");

  // 超量项按上限截断（首帧同步必须硬性有界）
  const many = Array.from({ length: USER_INPUT_QUEUE_MAX_ITEMS + 5 }, (_unused, index) => ({
    inputId: `in_${index}`,
    content: "x",
    originalDraft: "",
    state: "queued" as const,
  }));
  applyUserInputQueueEvent(pair.session, queueEvent({ generation: "gen_1", revision: 2, items: many }));
  expect(readUserInputQueue(pair.session).items.length).toBe(USER_INPUT_QUEUE_MAX_ITEMS);
});

// 同一 snapshot 重复应用幂等：revision 未递增即丢弃，items 不翻倍
test("re-applying the same snapshot is idempotent", () => {
  const event = queueEvent({
    generation: "gen_1",
    revision: 4,
    items: [{ inputId: "in_1", content: "a", originalDraft: "a", state: "queued" }],
  });
  expect(applyUserInputQueueEvent(pair.session, event).applied).toBe(true);
  const again = applyUserInputQueueEvent(pair.session, event);
  expect(again.applied).toBe(false);
  expect(again.reason).toBe("stale revision");
  expect(readUserInputQueue(pair.session).items.length).toBe(1);
  expect(readUserInputQueue(pair.session).revision).toBe(4);
});

// revision 乱序/回退丢弃：迟到的低 revision 快照不得回退 UI 状态
test("drops out-of-order snapshots with non-increasing revision", () => {
  applyUserInputQueueEvent(
    pair.session,
    queueEvent({
      generation: "gen_1",
      revision: 5,
      items: [{ inputId: "in_2", content: "b", originalDraft: "", state: "queued" }],
    }),
  );
  const stale = applyUserInputQueueEvent(
    pair.session,
    queueEvent({
      generation: "gen_1",
      revision: 3,
      items: [{ inputId: "in_1", content: "a", originalDraft: "", state: "queued" }],
    }),
  );
  expect(stale.applied).toBe(false);
  expect(stale.reason).toBe("stale revision");
  const view = readUserInputQueue(pair.session);
  expect(view.revision).toBe(5);
  expect(view.items.map((item) => item.inputId)).toEqual(["in_2"]);
});

// generation 换代整体清空：新代号的空快照不得残留旧代号的待发送项。
// revision 计数器随代号重置，因此新代号即使 revision 更小也必须重建。
test("clears and rebuilds the queue when generation changes", () => {
  applyUserInputQueueEvent(
    pair.session,
    queueEvent({
      generation: "gen_1",
      revision: 9,
      items: [
        { inputId: "in_1", content: "a", originalDraft: "", state: "queued" },
        { inputId: "in_2", content: "b", originalDraft: "", state: "queued" },
      ],
    }),
  );
  const rebuilt = applyUserInputQueueEvent(pair.session, queueEvent({ generation: "gen_2", revision: 0 }));
  expect(rebuilt.applied).toBe(true);
  const view = readUserInputQueue(pair.session);
  expect(view.generation).toBe("gen_2");
  expect(view.revision).toBe(0);
  expect(view.items).toEqual([]);

  // 会话切换 / Agent 重启由控制面主动清空（generation 置 null 使下一个快照无条件重建）
  resetUserInputQueue(pair.session);
  const reset = readUserInputQueue(pair.session);
  expect(reset.generation).toBeNull();
  expect(reset.items).toEqual([]);
});

// run_started 记录 activeRequestId；旧代号的迟到事件丢弃（不得覆盖当前 activeRequestId）
test("run_started records activeRequestId and rejects stale generation", () => {
  applyUserInputQueueEvent(pair.session, queueEvent({ generation: "gen_1", revision: 1 }));
  const started = applyUserInputQueueEvent(pair.session, {
    type: "user_input_run_started",
    update: {},
    content: null,
    generation: "gen_1",
    request_id: "req_1",
  } as NormalizedEvent);
  expect(started.applied).toBe(true);
  expect(readUserInputQueue(pair.session).activeRequestId).toBe("req_1");

  const stale = applyUserInputQueueEvent(pair.session, {
    type: "user_input_run_started",
    update: {},
    content: null,
    generation: "gen_0",
    request_id: "req_old",
  } as NormalizedEvent);
  expect(stale.applied).toBe(false);
  expect(stale.reason).toBe("stale generation");
  expect(readUserInputQueue(pair.session).activeRequestId).toBe("req_1");
});

// delivered：待发送项即时摘除，用户消息按 inputId 写入 Chat Doc；重复投递（回放）幂等
test("delivered removes the queued item and writes the user entry keyed by inputId", () => {
  applyUserInputQueueEvent(
    pair.session,
    queueEvent({
      generation: "gen_1",
      revision: 1,
      items: [
        { inputId: "in_1", content: "steer me", originalDraft: "draft", state: "queued" },
        { inputId: "in_2", content: "later", originalDraft: "", state: "queued" },
      ],
    }),
  );
  // 旧 turn 尚在执行：delivered 应把它收敛为 cancelled（steer 已打断）
  applyNormalizedEvent(pair, {
    type: "user_message",
    update: {},
    content: { type: "text", text: "first" },
    turnId: "turn_prev",
  });

  const applied = applyNormalizedEvent(pair, deliveredEvent("in_1", "steer me", "turn_new"));
  expect(applied.applied).toBe(true);

  // 队列侧：只摘除命中项，其余保留
  expect(readUserInputQueue(pair.session).items.map((item) => item.inputId)).toEqual(["in_2"]);
  // Chat 侧：entryId = inputId，用户 entry 直接 completed 并归属新 turn
  const entry = getEntry(pair.chat, "in_1");
  expect(entry?.get("role")).toBe("user");
  expect(entry?.get("status")).toBe("completed");
  expect(entry?.get("turnId")).toBe("turn_new");
  expect(getEntry(pair.chat, "turn_new:assistant")).not.toBeNull();
  expect(getEntry(pair.chat, "turn_prev:assistant")?.get("status")).toBe("cancelled");

  // 重复投递（历史回放 / 重连重放）幂等：不产生第二条用户消息
  const replay = applyNormalizedEvent(pair, deliveredEvent("in_1", "steer me", "turn_new"));
  expect(replay.applied).toBe(false);
  expect(
    getEntryOrder(pair.chat)
      .toArray()
      .filter((entryId) => entryId === "in_1").length,
  ).toBe(1);
  expect(getEntriesMap(pair.chat).size).toBe(4);
});

// 未携带 turnId 时由 state 层生成新 turn（控制面未接线也能完成投影）
test("delivered without turnId mints a new turn for the assistant response", () => {
  applyUserInputQueueEvent(
    pair.session,
    queueEvent({
      generation: "gen_1",
      revision: 1,
      items: [{ inputId: "in_9", content: "queued text", originalDraft: "", state: "queued" }],
    }),
  );
  expect(applyNormalizedEvent(pair, deliveredEvent("in_9", "queued text")).applied).toBe(true);
  const entry = getEntry(pair.chat, "in_9");
  const turnId = entry?.get("turnId") as string;
  expect(turnId.startsWith("turn_")).toBe(true);
  expect(getEntry(pair.chat, `${turnId}:assistant`)).not.toBeNull();
});

// 能力未协商：结构初始化后 enabled 仍为 false（前端回退旧路径）；协商落库与显式 false 均可读
test("reports enabled=false until the capability is negotiated", () => {
  expect(readUserInputQueue(pair.session).enabled).toBe(false);

  // 协商通过：peri 把 clientCapabilities._meta 原样回显到 agentCapabilities._meta，
  // agent_status 投影把它扁平化为顶层能力键（`caps["peri.userInputQueue"]` 是前端与
  // enabled 兜底共同读取的键）
  applyNormalizedEvent(pair, {
    type: "agent_status",
    update: { status: "ready", capabilities: { loadSession: true, _meta: { "peri.userInputQueue": true } } },
    content: null,
  });
  expect((getAgentStatus(pair.session).get("capabilities") as Y.Map<unknown>).get("peri.userInputQueue")).toBe(true);
  expect(readUserInputQueue(pair.session).enabled).toBe(true);

  // 显式写入优先（协商失败必须压回 false）
  setUserInputQueueEnabled(pair.session, false);
  expect(readUserInputQueue(pair.session).enabled).toBe(false);
  setUserInputQueueEnabled(pair.session, true);
  expect(readUserInputQueue(pair.session).enabled).toBe(true);

  // 结构缺失（旧快照 / 未装配）读取不抛错，按未协商返回
  const bare = new Y.Doc();
  expect(readUserInputQueue(bare)).toEqual({
    enabled: false,
    generation: null,
    revision: 0,
    activeRequestId: null,
    items: [],
  });
  // 投影写入会幂等补结构，不落在 undefined 上
  applyUserInputQueueEvent(bare, queueEvent({ generation: "gen_x", revision: 1 }));
  expect((getSessionRoot(bare).get("userInputQueue") as Y.Map<unknown>).get("generation")).toBe("gen_x");
});
