// packages/chat-channel/src/channel/session-switch-client-visibility.test.ts
// 会话切换（侧边栏点击历史会话）的端到端可见性测试：真实 Gateway + SessionChannel +
// RelayEventHandler + DocManager + YjsBroadcaster，fake 只有 relay handle 与 WS。
//
// 覆盖用户报告的真实路径：用户在 Chat 界面点击侧边栏历史项 → 前端发 load_session →
// 服务端换代投影并转发 session/load → Agent 回放历史。断言视角是「客户端最终看到什么」，
// 因此测试内部按浏览器客户端的语义消费 WS 帧（generation 门禁 + replace 帧换代），
// 任何「服务端写了但客户端收不到/收错世代」的缺陷都会在此暴露。

import { describe, expect, test } from "bun:test";
import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";
import * as Y from "yjs";
import { decodeYjsSyncFrame, encodeYjsStateVectorFrame } from "../protocol/update-frame";
import { getEntriesMap, getSessionInfo, setSessionInfo } from "../state/chat-writer";
import { DocManager } from "../state/doc-manager";
import { YjsBroadcaster } from "./broadcaster";
import { ConnectionRegistry } from "./connection-registry";
import type { WsConnection } from "./connection-types";
import { Gateway } from "./gateway";
import { RelayEventHandler } from "./relay-event-handler";
import { SessionChannel } from "./session-channel";

const RCS_SESSION_ID = "rcs-1";

/** 记录型最小 WS：文本帧与二进制帧都留在 sent 里，供客户端语义消费 */
class FakeWs implements WsConnection {
  readonly sent: Array<string | Uint8Array> = [];
  readonly closed: Array<{ code?: number; reason?: string }> = [];
  readyState = 1;
  onSend: ((data: string | Uint8Array) => void) | undefined;

  send(data: string | Uint8Array): void {
    this.sent.push(data);
    this.onSend?.(data);
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
    this.readyState = 3;
  }
}

/** 双向 fake relay：send 记录出站请求，emit 注入入站帧 */
class FakeRelay implements EngineRelayHandle {
  readonly state = "open" as const;
  readonly sent: Record<string, unknown>[] = [];
  private listener: ((message: EngineRelayMessage) => Promise<void>) | undefined;

  onMessage(listener: (message: EngineRelayMessage) => void): () => void {
    this.listener = listener as (message: EngineRelayMessage) => Promise<void>;
    return () => {
      this.listener = undefined;
    };
  }

  send(message: unknown): void {
    this.sent.push(message as Record<string, unknown>);
  }

  close(): void {}

  async emit(message: Record<string, unknown>): Promise<void> {
    await this.listener?.(message as unknown as EngineRelayMessage);
  }

  /** 最后一个出站请求（会话同步请求按序到达，取最后一个即为当前切换） */
  lastRequestOf(method: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((message) => message.method === method);
  }
}

/**
 * 浏览器侧视图：按 `transport/ws.ts` 的 generation 门禁与 `doc-hub` 的
 * chat/session 成对换代语义消费服务端帧。
 */
class ClientView {
  chat = new Y.Doc();
  session = new Y.Doc();
  readonly generations = new Map<string, string>();
  private readonly staged = new Map<string, { generation: string; chat?: Y.Doc; session?: Y.Doc }>();

  apply(data: string | Uint8Array): void {
    if (typeof data === "string") return;
    const frame = decodeYjsSyncFrame(data);
    if (!frame || frame.type === "state-vector") return;
    if (frame.type === "replace") {
      this.generations.set(frame.docName, frame.generation);
      this.applyReplacement(frame.docName, frame.generation, frame.update);
      return;
    }
    if (frame.type === "legacy-update") {
      // 无世代信息的旧帧：仅在尚未持有该 doc 世代时应用（与 transport/ws.ts 一致）
      if (!this.generations.has(frame.docName)) Y.applyUpdate(this.docFor(frame.docName), frame.update);
      return;
    }
    const current = this.generations.get(frame.docName);
    if (current && current !== frame.generation) return;
    this.generations.set(frame.docName, frame.generation);
    Y.applyUpdate(this.docFor(frame.docName), frame.update);
  }

  private docFor(docName: string): Y.Doc {
    return docName.startsWith("chat:") ? this.chat : this.session;
  }

  /** replace 帧按「同一 RCS 会话 + 同一世代」成对提交：只收到一份时保持旧副本（doc-hub 语义） */
  private applyReplacement(docName: string, generation: string, update: Uint8Array): void {
    const rcsSessionId = docName.slice(docName.indexOf(":") + 1);
    let staged = this.staged.get(rcsSessionId);
    if (!staged || staged.generation !== generation) {
      staged = { generation };
      this.staged.set(rcsSessionId, staged);
    }
    const replacement = new Y.Doc();
    Y.applyUpdate(replacement, update);
    if (docName.startsWith("chat:")) staged.chat = replacement;
    else staged.session = replacement;
    if (!staged.chat || !staged.session) return;
    this.staged.delete(rcsSessionId);
    this.chat.destroy();
    this.session.destroy();
    this.chat = staged.chat;
    this.session = staged.session;
  }

  /** 时间线上可见的非空文本（空 assistant 占位 entry 不计入用户可见内容） */
  timelineTexts(): string[] {
    return Array.from(getEntriesMap(this.chat).values())
      .map((entry) => {
        const blocks = entry.get("blocks") as Y.Map<Y.Map<unknown>> | undefined;
        return (blocks?.get("text")?.get("text") as Y.Text | undefined)?.toString() ?? "";
      })
      .filter((text) => text.length > 0);
  }

  sessionId(): string | null {
    const value = getSessionInfo(this.session).get("sessionId");
    return typeof value === "string" ? value : null;
  }
}

interface Harness {
  gateway: Gateway;
  docManager: DocManager;
  relay: FakeRelay;
  client: ClientView;
  ws: FakeWs;
  reports: Array<[string, unknown]>;
  /** 消费 ws 收到的全部帧（客户端语义），返回后帧被清空以避免重复消费 */
  pump(): void;
}

function createHarness(): Harness {
  const registry = new ConnectionRegistry();
  const broadcaster = new YjsBroadcaster(registry);
  const reports: Array<[string, unknown]> = [];
  const docManager = new DocManager({
    acpBatchWindowMs: 0,
    onLog: (message) => reports.push([message, null]),
    onError: (context, err) => reports.push([context, err]),
  });
  const relay = new FakeRelay();

  // 装配与宿主 controller.ts 逐项对齐（仅错误/日志 sink 收敛为记录数组）
  const sessionChannel = new SessionChannel({
    docManager,
    replaceProjection: (projection) => {
      const chatName = `chat:${projection.rcsSessionId}`;
      const sessionName = `session:${projection.rcsSessionId}`;
      broadcaster.registerYjsDocListener(projection.chat.ydoc, chatName, projection.generation);
      broadcaster.registerYjsDocListener(projection.session.ydoc, sessionName, projection.generation);
      broadcaster.broadcastReplacement(projection.chat.ydoc, chatName, projection.generation);
      broadcaster.broadcastReplacement(projection.session.ydoc, sessionName, projection.generation);
    },
    syncSessionId: (connection, newSessionId) => {
      registry.forEachByRcsSession(connection.rcsSessionId, (other) => {
        other.acpSessionId = newSessionId;
        other.sessionLoaded = true;
      });
    },
    reportError: (message, error) => reports.push([message, error]),
  });

  const relayEvents = new RelayEventHandler({
    registry,
    broadcaster,
    docManager,
    registerYjsDocListener: (ydoc, docName, generation) =>
      broadcaster.registerYjsDocListener(ydoc, docName, generation),
    reportError: (message, error) => reports.push([message, error]),
    touchInstanceActivity: () => {},
    terminateLocalDeadInstance: () => {},
  });

  const gateway = new Gateway({
    registry,
    broadcaster,
    relayEvents,
    sessionChannel,
    docManager,
    getEnvironment: async () => ({ organizationId: "org-1", userId: "user-1" }),
    authorizeEnvironment: () => true,
    resolveWorkspacePath: () => "/trusted-workspace",
    ensureRunning: async () => "instance-1",
    connectAgentRelay: async () => relay,
    markRelayAttached: () => {},
    markRelayDetached: () => {},
    reportLog: () => {},
    reportError: (message, error) => reports.push([message, error]),
    maxClients: () => 8,
    isMachineOffline: () => false,
    classifyPermanentSpawnFailure: () => null,
  });

  const ws = new FakeWs();
  const client = new ClientView();
  ws.onSend = (data) => {
    // 客户端对初始同步握手立即回 state vector（浏览器 onopen 行为）
    if (typeof data === "string") {
      const message = JSON.parse(data) as { type?: string; docs?: Array<{ docName: string; generation: string }> };
      if (message.type !== "yjs:sync-request") return;
      for (const doc of message.docs ?? []) {
        void gateway.handleMessage(
          ws,
          "ws-1",
          encodeYjsStateVectorFrame(doc.docName, doc.generation, new Uint8Array()),
        );
      }
      return;
    }
    client.apply(data);
    ws.sent.pop();
  };
  return {
    gateway,
    docManager,
    relay,
    client,
    ws,
    reports,
    pump: () => {
      for (const frame of ws.sent.splice(0)) client.apply(frame);
    },
  };
}

/** 服务端处理链含微任务与批次定时器（batchWindowMs=0），等待其排空 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function openChat(harness: Harness): Promise<void> {
  await harness.gateway.handleOpen(harness.ws, "ws-1", "user-1", "agent-1", {
    instanceUid: "instance-1",
    rcsSessionId: RCS_SESSION_ID,
  });
  // agent 就绪 status（capabilities 非空才会标记 agentStatusReceived 并自动 list_sessions）
  await harness.relay.emit({
    type: "status",
    payload: { connected: true, capabilities: { loadSession: true } },
  });
  const listRequest = harness.relay.lastRequestOf("session/list");
  await harness.relay.emit({
    jsonrpc: "2.0",
    id: listRequest?.id,
    result: {
      sessions: [
        { sessionId: "ses-A", title: "会话 A", updatedAt: "2026-09-20T10:00:00.000Z" },
        { sessionId: "ses-B", title: "会话 B", updatedAt: "2026-09-19T10:00:00.000Z" },
      ],
    },
  });
  await settle();
}

/**
 * 模拟 Redis 恢复的持久化投影：Session Doc 记录目标 ACP 会话、Chat Doc 已有时间线。
 * 必须在 handleOpen 之前调用（gateway 打开连接时会读取 Session Doc 的 sessionId 作为
 * 连接初始绑定，这也是「刷新后首个 load 直接复用投影」的真实前提）。
 */
async function seedPersistedProjection(harness: Harness, sessionId: string, text: string): Promise<void> {
  const sessionDoc = (await harness.docManager.openSession("user-1", "agent-1", RCS_SESSION_ID)).ydoc;
  await harness.docManager.openChat(RCS_SESSION_ID);
  harness.docManager.registerUserMessage(RCS_SESSION_ID, text);
  setSessionInfo(sessionDoc, { sessionId, title: "持久化会话", status: "ready" });
}

/** 模拟用户点击侧边栏历史项：前端发 load_session，返回该请求的 rpcId */
async function startSwitch(harness: Harness, sessionId: string): Promise<number | undefined> {
  await harness.gateway.handleMessage(
    harness.ws,
    "ws-1",
    JSON.stringify({
      action: "load_session",
      commandId: `cmd-${sessionId}-${harness.relay.sent.length}`,
      sessionId,
    }),
  );
  await settle();
  harness.pump();
  return harness.relay.lastRequestOf("session/load")?.id as number | undefined;
}

/** Agent 回放一条历史用户消息（同 rcsSessionId，携带目标 ACP sessionId） */
async function emitUserMessage(harness: Harness, sessionId: string, text: string): Promise<void> {
  await harness.relay.emit({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } } },
  });
  await settle();
  harness.pump();
}

/** Agent 回放一段助手输出增量 */
async function emitAssistantDelta(harness: Harness, sessionId: string, text: string): Promise<void> {
  await harness.relay.emit({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  });
  await settle();
  harness.pump();
}

/** session/load 的 JSON-RPC result（acp-link 在 agent 回放完成后才发送） */
async function emitLoadResult(harness: Harness, sessionId: string, rpcId: number | undefined): Promise<void> {
  await harness.relay.emit({ jsonrpc: "2.0", id: rpcId, result: { sessionId } });
  await settle();
  harness.pump();
}

describe("会话切换后客户端可见性", () => {
  // 用户点击侧边栏历史项切换到另一会话后，必须看到目标会话的历史消息（而非空白）。
  test("切换历史会话后客户端可见目标会话历史", async () => {
    const harness = createHarness();
    await openChat(harness);

    const firstLoad = await startSwitch(harness, "ses-A");
    await emitUserMessage(harness, "ses-A", "来自会话 A 的历史消息");
    await emitAssistantDelta(harness, "ses-A", "会话 A 的助手回答");
    await emitLoadResult(harness, "ses-A", firstLoad);

    expect(harness.client.sessionId()).toBe("ses-A");
    expect(harness.client.timelineTexts()).toEqual(["来自会话 A 的历史消息", "会话 A 的助手回答"]);

    const secondLoad = await startSwitch(harness, "ses-B");
    await emitUserMessage(harness, "ses-B", "来自会话 B 的历史消息");
    await emitAssistantDelta(harness, "ses-B", "会话 B 的助手回答");
    await emitLoadResult(harness, "ses-B", secondLoad);

    expect(harness.client.sessionId()).toBe("ses-B");
    expect(harness.client.timelineTexts()).toEqual(["来自会话 B 的历史消息", "会话 B 的助手回答"]);
  });

  // 多轮历史回放：回放中途 result 到达不得关闭回放合成（否则后续轮次无 turn 上下文被整体丢弃）。
  test("多轮历史回放中 result 到达后其余轮次仍可见", async () => {
    const harness = createHarness();
    await openChat(harness);

    const rpcId = await startSwitch(harness, "ses-A");
    await emitUserMessage(harness, "ses-A", "第一轮用户消息");
    await emitAssistantDelta(harness, "ses-A", "第一轮回答");
    await emitLoadResult(harness, "ses-A", rpcId);
    await emitUserMessage(harness, "ses-A", "第二轮用户消息");
    await emitAssistantDelta(harness, "ses-A", "第二轮回答");

    expect(harness.client.timelineTexts()).toEqual(["第一轮用户消息", "第一轮回答", "第二轮用户消息", "第二轮回答"]);
  });
  // 连续切换：前一次 load 的响应在用户切到新会话之后才到达（响应迟到/乱序），
  // 不得把活跃会话回绑到旧目标，否则新会话的回放被绑定校验丢弃、消息区空白。
  test("迟到的会话同步响应不得回绑到已切走的会话", async () => {
    const harness = createHarness();
    await openChat(harness);

    const firstLoad = await startSwitch(harness, "ses-A");
    await emitUserMessage(harness, "ses-A", "会话 A 的历史消息");
    // 用户未等 A 的响应即切到 B
    const secondLoad = await startSwitch(harness, "ses-B");
    await emitUserMessage(harness, "ses-B", "会话 B 的历史消息");
    // A 的迟到响应
    await emitLoadResult(harness, "ses-A", firstLoad);
    // 迟到的旧目标响应不得改写投影会话（新投影只应等待 B 的响应；被改写会让前端
    // 高亮/输入路由回退到已切走的会话，且 B 的增量被绑定校验丢弃）
    expect(harness.client.sessionId()).not.toBe("ses-A");
    // B 的响应与后续回放
    await emitAssistantDelta(harness, "ses-B", "会话 B 的助手回答");
    await emitLoadResult(harness, "ses-B", secondLoad);

    expect(harness.client.sessionId()).toBe("ses-B");
    expect(harness.client.timelineTexts()).toEqual(["会话 B 的历史消息", "会话 B 的助手回答"]);
  });
  // 10s 回放窗口未过期时的连续切换：第一次点击复用持久化投影（不清空、不请求 Agent，
  // 窗口以「已有内容」开启），随后切到别的会话时新会话回放必须仍被投影——
  // 跳过判定不得跨换代继承。
  test("复用持久化投影后的窗口内切换仍可见新会话回放", async () => {
    const harness = createHarness();
    await seedPersistedProjection(harness, "ses-A", "持久化投影里的历史消息");
    await openChat(harness);

    // 首次点击 ses-A：持久化投影已属于目标会话 → 静默绑定，不清空投影、不请求 Agent
    await startSwitch(harness, "ses-A");
    expect(harness.relay.lastRequestOf("session/load")).toBeUndefined();
    expect(harness.client.timelineTexts()).toEqual(["持久化投影里的历史消息"]);

    // 窗口未过期即切到 ses-B
    const second = await startSwitch(harness, "ses-B");
    await emitUserMessage(harness, "ses-B", "来自会话 B 的历史消息");
    await emitLoadResult(harness, "ses-B", second);

    expect(harness.client.timelineTexts()).toEqual(["来自会话 B 的历史消息"]);
  });
});
