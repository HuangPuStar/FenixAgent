// packages/chat-channel/src/__tests__/user-input-queue-attack.test.ts
// 对抗性验证用例：只针对高风险点写「最小可失败」用例，不复述既有测试。
// 1) enqueue 真路径（SessionChannel.handleAction → relay 出站帧）是否产出 peri 的
//    {type:'image', source:{type:'base64', media_type, data}}，且浏览器多余字段不进出站；
// 2) 打断注入的 turn 衔接：wire 规范化事件（不带 turnId）下旧 turn 收敛、新 turn 承接
//    增量与终态、旧 turn 迟到终态不误伤新 turn、loading 能回到 null；
// 3) 双写：enqueue 路径不写 Chat Doc；delivered 重复到达只写一条用户消息；
// 4) 跨会话隔离：一个会话的队列快照不落到另一个会话的投影。

import { describe, expect, test } from "bun:test";
import type * as Y from "yjs";
import { createSharedRelay } from "../channel/connection-test-helpers";
import type { SharedRelay } from "../channel/connection-types";
import { SessionChannel, type SessionConnection } from "../channel/session-channel";
import type { ActionAck, ActionError } from "../channel/types";
import { registerUserInputRequest } from "../channel/user-input-pending";
import { settleUserInputQueueResponse } from "../channel/user-input-queue-wire";
import { normalizeAcpMessage } from "../protocol/acp-channel";
import { toPeriMessageContent } from "../protocol/translator";
import type { NormalizedEvent } from "../schema";
import { applyNormalizedEvent, type DocPair } from "../state/aggregator";
import { getEntriesMap, getEntry, getSessionInfo, getSessionRoot, setUserInputQueueState } from "../state/chat-writer";
import { DocManager } from "../state/doc-manager";
import { createChatDoc, createSessionDoc } from "../state/factory";
import { readUserInputQueue } from "../state/user-input-queue";

interface RelayRecord {
  jsonrpc: string;
  id: number;
  method: string;
  params: Record<string, unknown>;
}

interface Harness {
  channel: SessionChannel;
  docManager: DocManager;
  sessionDoc: Y.Doc;
  chatDoc: Y.Doc;
  shared: SharedRelay;
  relayMessages: RelayRecord[];
  acks: ActionAck[];
  errorFrames: ActionError[];
}

/** 轮询等待条件成立（替代固定 sleep） */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

/** 构造带真实 DocManager 与登记型 SharedRelay 的 SessionChannel（出站帧全量记录） */
async function createHarness(
  options: { generation?: string } = {},
): Promise<Harness & { connection: SessionConnection }> {
  const docManager = new DocManager({ onError: () => {}, onLog: () => {} });
  const chatDoc = (await docManager.openChat("rcs-1")).ydoc;
  const sessionDoc = (await docManager.openSession("user-1", "agent-1", "rcs-1")).ydoc;
  if (options.generation) setUserInputQueueState(sessionDoc, { generation: options.generation, revision: 1 });

  const relayMessages: RelayRecord[] = [];
  const shared = createSharedRelay({
    rcsSessionId: "rcs-1",
    handle: {
      state: "open",
      send: (message) => {
        relayMessages.push(message as unknown as RelayRecord);
      },
      close: () => {},
    },
  });
  let nextRpcId = 0;
  const connection: SessionConnection = {
    userId: "user-1",
    ownerUserId: "user-1",
    agentId: "agent-1",
    instanceId: "instance-1",
    rcsSessionId: "rcs-1",
    acpSessionId: "ses-1",
    agentStatusReceived: true,
    sessionLoaded: false,
    workspacePath: "/workspace/org-1/user-1/env-1",
    sendToRelay: (message) => {
      relayMessages.push(message as unknown as RelayRecord);
    },
    getNextRpcId: () => ++nextRpcId,
    awaitUserInputRequest: (rpcId, kind, timeoutMs) => registerUserInputRequest(shared, { rpcId, kind, timeoutMs }),
  };

  const acks: ActionAck[] = [];
  const errorFrames: ActionError[] = [];
  const channel = new SessionChannel({
    docManager,
    refreshInstanceEnvironment: async () => {},
    replaceProjection: () => {},
    syncSessionId: () => {},
    reportError: () => {},
  });
  const sinks = {
    sendAck: (ack: ActionAck) => acks.push(ack),
    sendError: (error: ActionError) => errorFrames.push(error),
  };
  return {
    channel,
    docManager,
    sessionDoc,
    chatDoc,
    shared,
    relayMessages,
    acks,
    errorFrames,
    sinks,
    connection,
  } as Harness & {
    connection: SessionConnection;
  };
}

/** peri/agent_event 帧（event_json 为 JSON 字符串，serde tag/content 结构） */
function periAgentEventFrame(type: string, value: Record<string, unknown>): unknown {
  return {
    jsonrpc: "2.0",
    method: "peri/agent_event",
    params: { sessionId: "ses-1", event_json: JSON.stringify({ type, value }) },
  };
}

/** 经真实规范化器生成事件（未规范化时抛错，避免测试在 null 上静默通过） */
function normalizeFrame(frame: unknown, expected: NormalizedEvent["type"]): NormalizedEvent {
  const normalized = normalizeAcpMessage(frame);
  if (!normalized || normalized.type !== expected) {
    throw new Error(`expected ${expected}, got ${normalized?.type ?? "null"}`);
  }
  return normalized;
}

/** 助手文本增量（wire 上无 turnId：按 active turn 归位） */
function chunk(text: string): NormalizedEvent {
  return {
    type: "message_delta",
    update: {},
    content: { type: "text", text },
  } as NormalizedEvent;
}

/** 终态事件（turnId 为 undefined 表示「无归属」，与历史/回放兼容形态一致） */
function terminal(type: "turn_completed" | "turn_cancelled", turnId?: string): NormalizedEvent {
  return { type, update: {}, content: null, ...(turnId ? { turnId } : {}) } as NormalizedEvent;
}

/**
 * peri TurnDone transport 通知帧（peri/agent_event_done，params 平铺而非 event_json 包裹）。
 * steer run 由 peri 内部队列驱动、不经过 session/prompt，这是它唯一的终态来源；
 * requestId 与 user_input_run_started 的 request_id 同源。
 */
function turnDoneFrame(stopReason: string, requestId?: string): unknown {
  return {
    jsonrpc: "2.0",
    method: "peri/agent_event_done",
    params: { sessionId: "ses-1", stopReason, ...(requestId ? { requestId } : {}) },
  };
}

/** Session Doc 的 active turn 与 loading 投影（前端 loading 的唯一读取来源） */
function activeTurnState(session: Y.Doc): { turnId: string | null; status: string | null; loading: unknown } {
  const info = getSessionInfo(session);
  return {
    turnId: (info.get("activeTurnId") as string | null) ?? null,
    status: (info.get("activeTurnStatus") as string | null) ?? null,
    loading: info.get("loading") ?? null,
  };
}

describe("steer 高风险点：图片内容形状（真路径）", () => {
  // enqueue 的 content 必须是 peri 内部 MessageContent：图片块为 base64 source（snake_case），
  // ACP 的 mimeType 形状不得出站（否则被拒绝或静默丢图）；浏览器多余字段不得进入 params。
  test("handleAction 出站的 enqueue 帧携带 peri 图片形状且丢弃浏览器多余字段", async () => {
    const harness = await createHarness({ generation: "gen-1" });
    const action = harness.channel.handleAction(
      harness.connection,
      {
        action: "enqueue_user_input",
        commandId: "cmd-img",
        inputId: "in-img",
        content: [
          { type: "text", text: "看图" },
          { type: "image", mimeType: "image/png", data: "QUJD" },
          { type: "image", mimeType: "image/jpeg", data: "REVG" },
        ],
        originalDraft: "看图",
        // 浏览器伪造 / 越界字段：不得进入出站 params（peri 侧 deny_unknown_fields）
        sessionId: "ses-evil",
        generation: "gen-evil",
        extra: { injected: true },
      },
      harness.sinks,
    );
    await waitFor(() => harness.relayMessages.length === 1);
    expect(harness.relayMessages[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "session/input/enqueue",
      params: {
        sessionId: "ses-1",
        generation: "gen-1",
        commandId: "cmd-img",
        inputId: "in-img",
        content: [
          { type: "text", text: "看图" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "REVG" } },
        ],
        originalDraft: "看图",
      },
    });
    // ACP 形状的 mimeType 键不得残留在出站帧里
    expect(JSON.stringify(harness.relayMessages[0])).not.toContain("mimeType");

    settleUserInputQueueResponse({
      shared: harness.shared,
      rpcId: 1,
      rpcCheck: { id: 1, result: { generation: "gen-1", revision: 2, items: [] } },
      docManager: harness.docManager,
      reportError: () => {},
    });
    await action;
    // 双写防线：入队路径只入队，不写 Chat Doc（用户气泡唯一来源是 delivered 信号）
    expect(getEntriesMap(harness.chatDoc).size).toBe(0);
    expect(harness.acks.map((ack) => ack.status)).toEqual(["accepted", "committed"]);
  });

  // 负向对照：把转换退化成「原样透传」时本用例必须失败——锁定图片形状转换不可省。
  test("负向对照：未转换的 ACP 图片形状不等于出站形状", () => {
    const acpShape = { type: "image", mimeType: "image/png", data: "QUJD" };
    const outbound = toPeriMessageContent([acpShape]);
    expect(outbound).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }]);
    expect(outbound).not.toEqual([acpShape]);
  });

  // 纯文本入队后 peri 回传的快照项 content 为裸字符串：取回方向的展示文本必须还原，
  // 不得因形状不同把已入队内容渲染成空（用户取回时看到空草稿）。
  test("快照项为 peri 形状时投影出可展示文本（含图片占位）", async () => {
    const harness = await createHarness({ generation: "gen-1" });
    const action = harness.channel.handleAction(
      harness.connection,
      { action: "enqueue_user_input", commandId: "cmd-2", inputId: "in-2", content: "hello" },
      harness.sinks,
    );
    await waitFor(() => harness.relayMessages.length === 1);
    settleUserInputQueueResponse({
      shared: harness.shared,
      rpcId: 1,
      rpcCheck: {
        id: 1,
        result: {
          snapshot: {
            generation: "gen-1",
            revision: 2,
            items: [
              { inputId: "in-2", content: "hello", originalDraft: "hello", state: "queued" },
              {
                inputId: "in-3",
                content: [
                  { type: "text", text: "图" },
                  { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
                ],
                originalDraft: "",
                state: "queued",
              },
            ],
          },
        },
      },
      docManager: harness.docManager,
      reportError: () => {},
    });
    await action;
    const items = readUserInputQueue(harness.sessionDoc).items;
    expect(items.map((item) => item.content)).toEqual(["hello", "图\n[image]"]);
    // base64 不得进入 Session Doc（首帧整体同步的体积）
    expect(JSON.stringify(items)).not.toContain("QUJD");
  });
});

describe("steer 高风险点：打断注入后的 turn 衔接", () => {
  // 契约里 run_started / delivered 事件走 peri/agent_event，wire 不带 turnId；
  // dispatch 打断后旧 turn 必须收敛（不是卡在 running），新 turn 必须承接后续增量与终态，
  // 否则前端 loading 永不消失。
  test("旧 turn 收敛 + 新 turn 承接增量与终态，loading 回到 null", () => {
    const pair: DocPair = {
      chat: createChatDoc("rcs-1", null).ydoc,
      session: createSessionDoc("rcs-1", null).ydoc,
    };

    // ① 旧 turn 正在执行（用户已发 prompt）
    expect(
      applyNormalizedEvent(pair, {
        type: "user_message",
        update: {},
        content: { type: "text", text: "first" },
        turnId: "turn_1",
      } satisfies NormalizedEvent).applied,
    ).toBe(true);
    applyNormalizedEvent(pair, chunk("正在回答"));
    const before = activeTurnState(pair.session);
    expect(before).toMatchObject({ turnId: "turn_1", status: "running" });
    expect(before.loading).not.toBeNull();

    // ② 入队 → 快照（gen_1）
    expect(
      applyNormalizedEvent(
        pair,
        normalizeFrame(
          periAgentEventFrame("user_input_queue_changed", {
            snapshot: {
              session_id: "ses-1",
              generation: "gen_1",
              revision: 1,
              items: [{ input_id: "in_1", content: "steer me", original_draft: "steer me", state: "queued" }],
            },
          }),
          "user_input_queue_changed",
        ),
      ).applied,
    ).toBe(true);

    // ③ 派发：run_started（只记 activeRequestId）
    const started = normalizeFrame(
      periAgentEventFrame("user_input_run_started", { generation: "gen_1", request_id: "req_1" }),
      "user_input_run_started",
    );
    expect(applyNormalizedEvent(pair, started).applied).toBe(true);
    expect(readUserInputQueue(pair.session).activeRequestId).toBe("req_1");

    // ④ 投递：wire 事件无 turnId（真实形态），聚合层必须自行建立新 turn
    const delivered = normalizeFrame(
      periAgentEventFrame("user_input_delivered", {
        generation: "gen_1",
        input_id: "in_1",
        content: "steer me",
      }),
      "user_input_delivered",
    );
    expect(delivered.turnId ?? null).toBeNull();
    expect(applyNormalizedEvent(pair, delivered).applied).toBe(true);

    // 旧 turn 收敛为 cancelled（steer 已打断），其 assistant entry 不再 streaming
    expect(getEntry(pair.chat, "turn_1:assistant")?.get("status")).toBe("cancelled");
    // 新 turn 已接管：id 与旧 turn 不同，且处于可写状态（accepting/running），loading 保持"仍在响应"
    const afterDelivered = activeTurnState(pair.session);
    expect(afterDelivered.turnId).not.toBe("turn_1");
    expect(["accepting", "running"]).toContain(afterDelivered.status ?? "");
    expect(afterDelivered.loading).not.toBeNull();
    // 用户消息按 input_id 写入 Chat Doc（唯一写入点），队列项即时摘除
    expect(getEntry(pair.chat, "in_1")?.get("status")).toBe("completed");
    expect(readUserInputQueue(pair.session).items).toEqual([]);

    // ⑤ 旧 turn 的迟到终态（prompt 返回 stopReason=cancelled，带旧 turnId）必须被拒，
    //    不得终结刚建立的新 turn
    const stale = applyNormalizedEvent(pair, terminal("turn_cancelled", "turn_1"));
    expect(stale.applied).toBe(false);
    expect(stale.reason).toBe("terminal for stale turn");
    const afterStale = activeTurnState(pair.session);
    expect(afterStale.turnId).toBe(afterDelivered.turnId);
    expect(afterStale.status).toBe(afterDelivered.status);

    // ⑥ 新 run 的增量按 active turn 归位
    expect(applyNormalizedEvent(pair, chunk("注入后的回答")).applied).toBe(true);
    expect(getEntry(pair.chat, `${afterDelivered.turnId}:assistant`)?.get("status")).toBe("streaming");

    // ⑦ 新 run 终态由 peri/agent_event_done 投递（requestId 与 run_started 配对）：
    //    ACP v1 没有 turn_done 的 SessionUpdate tag，steer run 不经 session/prompt，
    //    这条 transport 通知是它唯一的终态来源——收敛 active turn，loading 回到 null（不卡死）
    const done = normalizeFrame(turnDoneFrame("end_turn", "req_1"), "turn_completed");
    expect(applyNormalizedEvent(pair, done).applied).toBe(true);
    expect(activeTurnState(pair.session)).toMatchObject({ turnId: afterDelivered.turnId, status: "completed" });
    expect(activeTurnState(pair.session).loading).toBeNull();
    expect(getEntry(pair.chat, `${afterDelivered.turnId}:assistant`)?.get("status")).toBe("completed");
  });

  // steer run 进行中，无 requestId 的终态不得终结它：该 run 的终态必然由带 requestId 的
  // peri/agent_event_done 到达，其余无归属终态（被打断的旧 prompt 响应在 relay 重连后
  // 丢失 pendingPromptTurns 映射时正是此形态）一律拒绝，否则新 turn 被提前终结、回答不显示。
  test("steer run 进行中无 requestId 的终态被拒，requestId 不匹配同样被拒", () => {
    const pair: DocPair = {
      chat: createChatDoc("rcs-1", null).ydoc,
      session: createSessionDoc("rcs-1", null).ydoc,
    };
    applyNormalizedEvent(pair, {
      type: "user_message",
      update: {},
      content: { type: "text", text: "first" },
      turnId: "turn_1",
    } satisfies NormalizedEvent);
    applyNormalizedEvent(pair, {
      type: "user_message",
      update: {},
      content: { type: "text", text: "steer" },
      turnId: "turn_2",
    } satisfies NormalizedEvent);
    setUserInputQueueState(pair.session, { activeRequestId: "req_1" });

    // 无 requestId：即使是「看起来正常」的完成终态也被拒（steer run 的终态必带 requestId）
    const withoutId = applyNormalizedEvent(pair, terminal("turn_completed"));
    expect(withoutId.applied).toBe(false);
    expect(withoutId.reason).toBe("terminal without requestId during steer run");
    // requestId 不匹配：旧 run 的迟到 done，不得终结当前 run
    const mismatched = applyNormalizedEvent(pair, normalizeFrame(turnDoneFrame("end_turn", "req_0"), "turn_completed"));
    expect(mismatched.applied).toBe(false);
    expect(mismatched.reason).toBe("terminal requestId mismatch");
    expect(activeTurnState(pair.session)).toMatchObject({ turnId: "turn_2", status: "accepting" });

    // 匹配的 done 才是唯一合法终态，且消费后清空 run 身份（否则下一个普通 turn 会被误拒）
    expect(
      applyNormalizedEvent(pair, normalizeFrame(turnDoneFrame("end_turn", "req_1"), "turn_completed")).applied,
    ).toBe(true);
    expect(activeTurnState(pair.session).status).toBe("completed");
    expect(readUserInputQueue(pair.session).activeRequestId).toBeNull();
  });

  // delivered 重复到达（重连重放 / 历史回放）不得写出第二条用户消息，也不得再新建 turn
  test("delivered 重复到达幂等，不新建 turn 也不写第二条用户消息", () => {
    const pair: DocPair = {
      chat: createChatDoc("rcs-1", null).ydoc,
      session: createSessionDoc("rcs-1", null).ydoc,
    };
    applyNormalizedEvent(pair, {
      type: "user_message",
      update: {},
      content: { type: "text", text: "first" },
      turnId: "turn_1",
    } satisfies NormalizedEvent);
    const delivered = normalizeFrame(
      periAgentEventFrame("user_input_delivered", { generation: "gen_1", input_id: "in_1", content: "steer" }),
      "user_input_delivered",
    );
    expect(applyNormalizedEvent(pair, delivered).applied).toBe(true);
    const firstTurn = activeTurnState(pair.session).turnId;
    const entryCountAfterFirst = getEntriesMap(pair.chat).size;

    const replay = applyNormalizedEvent(pair, delivered);
    expect(replay.applied).toBe(false);
    expect(getEntriesMap(pair.chat).size).toBe(entryCountAfterFirst);
    expect(activeTurnState(pair.session).turnId).toBe(firstTurn);
    // 用户消息只出现一次（按 input_id 键控；另一条是首轮的 turn_1:user）
    expect(getEntry(pair.chat, "in_1")?.get("role")).toBe("user");
    expect(Array.from(getEntriesMap(pair.chat).keys()).filter((entryId) => entryId === "in_1")).toHaveLength(1);
  });

  // 风险记录（红队实证，非期望行为）：旧 prompt 的迟到终态若**不带 turnId**（relay 重连后
  // pendingPromptTurns 丢失、或回放路径），聚合层按 active turn 归位会把 delivered 刚建立的新 turn
  // 误终结——新 run 的真实回答增量随后被 canWriteToTurn 丢弃，用户看到回答刚起就中断。
  // 该行为由 aggregator 的无 turnId 兼容分支决定；真实 peri 是否始终能被附加旧 turnId 尚未在真机验证。
  test("无 turnId 的迟到终态会误终结新 turn（风险实证，修复后应改为被拒）", () => {
    const pair: DocPair = {
      chat: createChatDoc("rcs-1", null).ydoc,
      session: createSessionDoc("rcs-1", null).ydoc,
    };
    // 旧 turn 执行中 → delivered 建立新 turn
    applyNormalizedEvent(pair, {
      type: "user_message",
      update: {},
      content: { type: "text", text: "first" },
      turnId: "turn_1",
    } satisfies NormalizedEvent);
    applyNormalizedEvent(pair, chunk("旧回答"));
    expect(
      applyNormalizedEvent(
        pair,
        normalizeFrame(
          periAgentEventFrame("user_input_delivered", { generation: "gen_1", input_id: "in_1", content: "steer" }),
          "user_input_delivered",
        ),
      ).applied,
    ).toBe(true);
    const newTurn = activeTurnState(pair.session).turnId;
    expect(newTurn).not.toBe("turn_1");
    expect(["accepting", "running"]).toContain(activeTurnState(pair.session).status ?? "");

    // 旧 prompt 的迟到终态（无 turnId）落到新 turn 上：当前实现直接接受
    const lateStale = applyNormalizedEvent(pair, terminal("turn_cancelled"));
    expect(lateStale.applied).toBe(true);
    expect(activeTurnState(pair.session)).toMatchObject({ turnId: newTurn, status: "cancelled" });
    expect(activeTurnState(pair.session).loading).toBeNull();

    // 后果：新 run 的真实增量已无可写 turn，全部被丢弃（回答不显示）
    expect(applyNormalizedEvent(pair, chunk("注入后的回答")).applied).toBe(false);
  });
});

describe("steer 高风险点：跨会话隔离", () => {
  // 队列代号与待发送项属于单个 ACP 会话：一个会话的快照/投递事件不得写进另一个会话的投影，
  // 否则会出现跨会话串数据（用户 A 会话看到 B 会话的待发送项）。
  test("一个会话的队列事件不改动另一个会话的投影", async () => {
    const docManager = new DocManager({ onError: () => {}, onLog: () => {} });
    await docManager.openChat("rcs-1");
    await docManager.openChat("rcs-2");
    const first = (await docManager.openSession("user-1", "agent-1", "rcs-1")).ydoc;
    const second = (await docManager.openSession("user-1", "agent-1", "rcs-2")).ydoc;

    docManager.processNormalizedEvent(
      "rcs-1",
      normalizeFrame(
        periAgentEventFrame("user_input_queue_changed", {
          snapshot: {
            session_id: "ses-1",
            generation: "gen_1",
            revision: 1,
            items: [{ input_id: "in_1", content: "only in rcs-1", original_draft: "", state: "queued" }],
          },
        }),
        "user_input_queue_changed",
      ),
    );

    expect(readUserInputQueue(first).items.map((item) => item.inputId)).toEqual(["in_1"]);
    expect(readUserInputQueue(second)).toMatchObject({ generation: null, items: [] });

    // 会话 Doc 不在内存时事件被丢弃（不得重建旧 Doc，也不得写到别的会话）
    docManager.processNormalizedEvent(
      "rcs-missing",
      normalizeFrame(
        periAgentEventFrame("user_input_queue_changed", {
          snapshot: {
            session_id: "ses-x",
            generation: "gen_x",
            revision: 1,
            items: [{ input_id: "in_x", content: "ghost", original_draft: "", state: "queued" }],
          },
        }),
        "user_input_queue_changed",
      ),
    );
    expect(readUserInputQueue(first).items.map((item) => item.inputId)).toEqual(["in_1"]);
    expect(readUserInputQueue(second).items).toEqual([]);
    expect(docManager.getSessionYdoc("rcs-missing")).toBeUndefined();
  });
});

describe("steer 高风险点：旧 schema 快照（v4）兼容", () => {
  // Session Doc 结构版本 4 → 5 只有幂等补结构这一条升级路径：旧快照（无 userInputQueue 子树）
  // 恢复后读取不得抛错，事件写入必须先把结构补齐再落投影，否则投影写在 undefined 上。
  test("无队列子树的旧快照可读可写，写入后结构补齐且版本升到 5", () => {
    const ydoc = createSessionDoc("rcs-1", null).ydoc;
    const root = getSessionRoot(ydoc);
    // 模拟 v4 快照：删掉 v5 新增的投影位并回退版本号
    root.delete("userInputQueue");
    root.set("schemaVersion", 4);
    expect(root.get("userInputQueue")).toBeUndefined();

    // 读取路径：结构缺失按「能力未协商」返回，不抛错（前端回退直发 prompt）
    expect(readUserInputQueue(ydoc)).toEqual({
      enabled: false,
      generation: null,
      revision: 0,
      activeRequestId: null,
      items: [],
    });

    // 写入路径：幂等补建结构后落投影
    expect(
      applyNormalizedEvent(
        { chat: createChatDoc("rcs-1", null).ydoc, session: ydoc },
        normalizeFrame(
          periAgentEventFrame("user_input_queue_changed", {
            snapshot: {
              session_id: "ses-1",
              generation: "gen_1",
              revision: 1,
              items: [{ input_id: "in_1", content: "after upgrade", original_draft: "", state: "queued" }],
            },
          }),
          "user_input_queue_changed",
        ),
      ).applied,
    ).toBe(true);
    expect(readUserInputQueue(ydoc).items.map((item) => item.inputId)).toEqual(["in_1"]);
    expect(root.get("schemaVersion")).toBe(5);
  });
});
