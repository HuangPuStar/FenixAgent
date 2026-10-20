import { describe, expect, test } from "bun:test";
import type * as Y from "yjs";
import { DocManager } from "../state/doc-manager";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import { createBoundDocs, createClient, createRelayEvents } from "./connection-test-helpers";
import type { RelayMessage } from "./connection-types";
import { relayOn } from "./relay-event-test-helpers";

describe("RelayEventHandler replay window", () => {
  const future = Date.now() + 60_000;
  /** reasoning_delta 等批次化事件在 16ms 合并窗口后 flush，断言前等待 flush */
  const waitFlush = () => new Promise((resolve) => setTimeout(resolve, 30));

  /** 读取指定 role 的全部 Entry 文本（text + reasoning 块拼接） */
  function entriesText(chatDoc: Y.Doc, role: "user" | "assistant"): string {
    const entries = chatDoc.getMap("root").get("entries") as Y.Map<Y.Map<unknown>>;
    let out = "";
    for (const entry of entries.values()) {
      if (entry.get("role") !== role) continue;
      const blocks = entry.get("blocks") as Y.Map<Y.Map<unknown>>;
      for (const block of blocks.values()) {
        const text = block.get("text") as { toString?: () => string } | undefined;
        if (text?.toString) out += text.toString();
      }
    }
    return out;
  }

  /** 统计指定 role 的 Entry 数量（验证双写防护：用户消息不得重复） */
  function countEntriesByRole(chatDoc: Y.Doc, role: "user" | "assistant"): number {
    const entries = chatDoc.getMap("root").get("entries") as Y.Map<Y.Map<unknown>>;
    let count = 0;
    for (const entry of entries.values()) {
      if (entry.get("role") === role) count++;
    }
    return count;
  }

  // load_session JSON-RPC 成功响应必须开启回放窗口，后续历史回放才有投影机会。
  test("load_session result opens the replay window", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    const shared = relayOn("rcs-1");
    // 会话同步分支只放行请求出口登记过的在途请求（id → 会话同步身份）
    shared.pendingSessionSyncIds = new Set([1]);

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      id: 1,
      result: { sessionId: "ses-loaded" },
    } as unknown as RelayMessage);

    expect(shared.replayWindowUntil).not.toBeNull();
    expect(shared.replayWindowUntil!).toBeGreaterThan(Date.now());
  });

  // 回放窗口一开就写入 replaying（不等首个回放事件）：慢启动回放不会落回 idle 被客户端提前放行。
  test("replay window starts a replaying placeholder before events", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, sessionDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    const shared = relayOn("rcs-1");

    handler.openReplayWindow(shared);
    const session = sessionDoc.getMap("root").get("session") as Y.Map<unknown>;
    expect(session.get("presenting")).toBe("replaying");
    expect(shared.replayTurnId).toMatch(/^turn_replay_/);

    handler.convergeReplayWindow(shared);
    expect(session.get("presenting")).not.toBe("replaying");
  });

  // 回放事件（含工具）不得 fanout 到新协议 live ingress；回放后的实时事件必须正常进入。
  test("回放 1 万条事件不进新协议，回放后的实时事件进入", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const logs: string[] = [];
    const docManager = new DocManager({ onLog: (message) => logs.push(message), onError: () => {} });
    await docManager.openChat("rcs-1");
    await docManager.openSession("user-1", "agent-1", "rcs-1");
    const forwarded: Array<{ type: string; turnId?: string | null }> = [];
    const handler = createRelayEvents(registry, broadcaster, [], {
      docManager,
      onNormalizedEvent: (_rcsSessionId, event) => forwarded.push({ type: event.type, turnId: event.turnId }),
    });
    const shared = relayOn("rcs-1");
    handler.openReplayWindow(shared);
    const handle = handler.createMessageHandler(shared);

    for (let index = 0; index < 10_000; index += 1) {
      await handle({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "ses-1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "历史" } },
        },
      } as unknown as RelayMessage);
    }
    await handle({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read", status: "running" },
      },
    } as unknown as RelayMessage);

    expect(forwarded).toHaveLength(0);
    expect(logs.some((message) => message.includes("tool_call without writable turn"))).toBe(false);

    handler.convergeReplayWindow(shared);
    await docManager.registerUserMessage(shared.rcsSessionId, "实时消息");
    await handle({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "实时回答" } },
      },
    } as unknown as RelayMessage);

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.turnId?.startsWith("turn_replay_")).toBe(false);
  }, 30_000);

  // 宿主在 load/resume 响应后显式通知回放结束（含零历史）：立即收敛，不等 10s 窗口。
  test("session/replay_complete converges the window immediately", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, sessionDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    const shared = relayOn("rcs-1");

    handler.openReplayWindow(shared);
    const session = sessionDoc.getMap("root").get("session") as Y.Map<unknown>;
    expect(session.get("presenting")).toBe("replaying");

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      method: "session/replay_complete",
      params: { sessionId: "ses-1" },
    } as unknown as RelayMessage);

    expect(shared.replayWindowUntil).toBeNull();
    expect(session.get("presenting")).not.toBe("replaying");
    expect(session.get("replayState")).toBe("complete");
  });

  // 判定「是否跳过回放合成」只在窗口开启时捕获一次：回放流本身会写 Chat Doc，
  // result 分支幂等重开窗口时若重新判定，会把回放自己写入的内容当作「重连前已有内容」，
  // 切换后剩余回放轮次全被拒绝（历史消息消失）。
  test("reopening the replay window keeps the synthesis decision captured at open time", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    const shared = relayOn("rcs-1");
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-1" }));

    // 窗口开启时 doc 为空 → 允许合成
    handler.openReplayWindow(shared);
    expect(shared.replaySkipSynthesis).toBe(false);

    // 回放首帧写入时间线后，会话同步 result 分支重开窗口（真实时序：result 晚于回放流）
    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "历史用户消息" } },
      },
    } as unknown as RelayMessage);
    handler.openReplayWindow(shared);

    expect(shared.replaySkipSynthesis).toBe(false);
    expect(shared.replayTurnId).toBeTruthy();
  });

  // 窗口开启时 doc 已有时间线内容（重连复用持久化投影）→ 保持跳过合成，
  // 迟到的回放帧不得重复投影历史；重开窗口同样不得解除该判定。
  test("reopening the replay window does not clear a cached skip decision", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, chatDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    await docManager.registerUserMessage("rcs-1", "上一轮已投影的消息");
    const shared = relayOn("rcs-1");
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-1" }));

    handler.openReplayWindow(shared);
    expect(shared.replaySkipSynthesis).toBe(true);
    handler.openReplayWindow(shared);

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "重复回放的历史消息" } },
      },
    } as unknown as RelayMessage);

    expect(shared.replaySkipSynthesis).toBe(true);
    expect(countEntriesByRole(chatDoc, "user")).toBe(1);
    expect(entriesText(chatDoc, "user")).toBe("上一轮已投影的消息");
  });

  // 中断 turn 的无头回放（无 user_message 开头）：窗口内增量到达且无活动 turn 可写时，
  // 先合成回放 turn，增量才能投影为时间线（无持久化快照时历史恢复的唯一来源）。
  test("headless replay deltas inside the window are projected via a synthesized turn", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, chatDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-1" }));
    const shared = relayOn("rcs-1");
    shared.replayWindowUntil = future;

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "回放思考" } },
      },
    } as unknown as RelayMessage);
    await waitFlush();

    // 合成空文本 user_message（创建 turn）+ 增量投影成功
    expect(countEntriesByRole(chatDoc, "user")).toBe(1);
    expect(countEntriesByRole(chatDoc, "assistant")).toBe(1);
    expect(entriesText(chatDoc, "assistant")).toBe("回放思考");
  });

  // 全量回放开头（user_message 无 turnId）：窗口内分配回放 turnId，用户历史可投影。
  test("turn-less user_message inside the window is assigned a replay turnId", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, chatDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-1" }));
    const shared = relayOn("rcs-1");
    shared.replayWindowUntil = future;

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "历史用户消息" } },
      },
    } as unknown as RelayMessage);

    expect(countEntriesByRole(chatDoc, "user")).toBe(1);
    expect(entriesText(chatDoc, "user")).toBe("历史用户消息");
  });

  // 窗口外（未开启窗口）的无头增量不得合成回放 turn：保持聚合层原语义（拒绝），
  // 避免实时流 agent 回显被错误投影。
  test("deltas outside the replay window are not synthesized", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, chatDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-1" }));

    await handler.createMessageHandler(relayOn("rcs-1"))({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "实时思考" } },
      },
    } as unknown as RelayMessage);

    expect(countEntriesByRole(chatDoc, "user")).toBe(0);
    expect(countEntriesByRole(chatDoc, "assistant")).toBe(0);
  });

  // 已过期的回放窗口不再合成回放 turn（窗口外语义恢复）。
  test("expired replay window does not synthesize turns", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, chatDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-1" }));
    const shared = relayOn("rcs-1");
    shared.replayWindowUntil = Date.now() - 1;

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "迟到增量" } },
      },
    } as unknown as RelayMessage);

    expect(countEntriesByRole(chatDoc, "user")).toBe(0);
  });

  // 实时流双写防护：窗口内用户已发消息（registerUserMessage 创建可写 turn），
  // agent 回显的 user_message（无 turnId）不得再次分配 turnId，用户消息不重复。
  test("turn-less user_message with a writable live turn is not assigned (live echo)", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, chatDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-1" }));
    const shared = relayOn("rcs-1");
    shared.replayWindowUntil = future;
    await docManager.registerUserMessage("rcs-1", "实时用户消息");

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "实时用户消息" } },
      },
    } as unknown as RelayMessage);

    expect(countEntriesByRole(chatDoc, "user")).toBe(1);
  });

  // 实时流增量防串扰：窗口内已有可写 turn（registerUserMessage 创建）时，
  // 到达的增量直接写入现有 turn，不得合成新回放 turn 造成双 turn 混乱。
  test("deltas with a writable live turn are written to the live turn, not synthesized", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, chatDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-1" }));
    const shared = relayOn("rcs-1");
    shared.replayWindowUntil = future;
    await docManager.registerUserMessage("rcs-1", "实时用户消息");

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "实时思考" } },
      },
    } as unknown as RelayMessage);
    await waitFlush();

    // 只有一个 user entry（无合成 turn 的第二个 user entry），增量进入实时 turn
    expect(countEntriesByRole(chatDoc, "user")).toBe(1);
    expect(entriesText(chatDoc, "assistant")).toBe("实时思考");
  });

  // 重连跳过回放语义：窗口内但 Chat Doc 已有时间线内容（prepareLoadSession 路径 1，
  // 不清空 doc 仍发 load RPC）时，不得合成新回放 turn——增量写入现有活动 turn
  // （恢复中断 turn 的补全增量），终态 turn 后的回放增量仍由聚合层拒绝（防重复）。
  test("replay is skipped when the chat doc already has timeline content", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry);
    const { docManager, chatDoc } = await createBoundDocs("rcs-1");
    const handler = createRelayEvents(registry, broadcaster, [], { docManager });
    registry.addClient("ws-1", createClient({ acpSessionId: "ses-1" }));
    const shared = relayOn("rcs-1");
    shared.replayWindowUntil = future;
    // 预写时间线内容（模拟重连场景 doc 已有历史与活动 turn）
    await docManager.registerUserMessage("rcs-1", "已有历史消息");

    await handler.createMessageHandler(shared)({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "回放增量" } },
      },
    } as unknown as RelayMessage);
    await waitFlush();

    // 不合成新 turn（user entry 保持 1 个），增量写入现有活动 turn
    expect(countEntriesByRole(chatDoc, "user")).toBe(1);
    expect(entriesText(chatDoc, "assistant")).toBe("回放增量");
  });
});
