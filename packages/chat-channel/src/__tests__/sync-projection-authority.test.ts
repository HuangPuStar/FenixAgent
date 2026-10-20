// packages/chat-channel/src/__tests__/sync-projection-authority.test.ts
// 会话切换的权威换代回归：真实 ChatChannelController / Gateway / DocManager / SyncHostSession，
// 两个 WebSocket 走完整 HELLO → 目录 → 内容订阅链路；只替换宿主依赖与传输边界。
//
// 覆盖：A→B→A 旧连接被服务端主动失效、换代不依赖 legacy replace 帧、resume_session 同样换代、
// 多标签页不复用旧历史。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { createWs, type MockWs } from "../channel/connection-test-helpers";
import { ChatChannelController } from "../channel/controller";
import { decodeYjsSyncFrame } from "../protocol/update-frame";
import { appendEntryText, ensureEntry, setEntryStatus } from "../state/chat-writer";
import { DocManager } from "../state/doc-manager";
import { type Clock, deterministicRandomSource, sha256Digest } from "../sync/clock";
import { fidelityDeserialize } from "../sync/history/fidelity-json";
import { readDirectoryPage, readDirectoryRoot } from "../sync/protocol/directory";
import { decodeSyncFrame, encodeSyncFrame, SYNC_PROTOCOL_VERSION, type SyncFrame } from "../sync/protocol/frames";
import { FakeRedis } from "./helpers/fake-redis";

const LOCATOR = { instanceUid: "instance-authority", rcsSessionId: "rcs-authority" };
const RCS = LOCATOR.rcsSessionId;
const NOW = 1_700_000_000_000;
const CLOCK: Clock = { now: () => NOW };

/** 真实控制器装配：假 relay 只记录转发，其余均为生产实现。 */
function createHarness(docManager = new DocManager({ onError: () => {}, onLog: () => {} })): {
  controller: ChatChannelController;
  docManager: DocManager;
  relayed: string[];
} {
  const relayed: string[] = [];
  const controller = new ChatChannelController({
    docManager,
    getEnvironment: async () => ({ userId: "user-1", organizationId: "org-1" }),
    authorizeEnvironment: () => true,
    resolveWorkspacePath: () => "/workspace",
    ensureRunning: async () => LOCATOR.instanceUid,
    connectAgentRelay: async () => ({
      state: "open",
      send(message: Record<string, unknown>) {
        relayed.push(String(message.method ?? message.type));
      },
      close() {},
    }),
    refreshInstanceEnvironment: async () => {},
    markRelayAttached() {},
    markRelayDetached() {},
    touchInstanceActivity() {},
    terminateLocalDeadInstance() {},
    isMachineOffline: () => false,
    classifyPermanentSpawnFailure: () => null,
    maxClients: () => 10,
    chatSyncProtocol: { enabled: true, sealGraceMs: 2_000, retireGraceMs: 30_000 },
    syncHostOverrides: {
      clock: CLOCK,
      random: deterministicRandomSource("sync-projection-authority"),
      digest: sha256Digest,
      tickIntervalMs: 10,
    },
    snapshotPersist: () => ({ intervalMs: 2_000, idleMs: 500, ttlSeconds: 604_800 }),
    log() {},
    reportError() {},
  });
  return { controller, docManager, relayed };
}

function syncFrames(ws: MockWs): SyncFrame[] {
  const frames: SyncFrame[] = [];
  for (const message of ws.messages) {
    if (!(message instanceof Uint8Array) || message[0] !== 0x7b) continue;
    frames.push(decodeSyncFrame(message));
  }
  return frames;
}

function frameOfType<T extends SyncFrame["type"]>(ws: MockWs, type: T): Extract<SyncFrame, { type: T }> | undefined {
  return syncFrames(ws).find((frame): frame is Extract<SyncFrame, { type: T }> => frame.type === type);
}

function baseFor(ws: MockWs, docId: string): Extract<SyncFrame, { type: "DOC_BASE" }> | undefined {
  return syncFrames(ws).find(
    (frame): frame is Extract<SyncFrame, { type: "DOC_BASE" }> => frame.type === "DOC_BASE" && frame.docId === docId,
  );
}

function ackFor(frame: Extract<SyncFrame, { type: "DOC_BASE" | "DOC_UPDATE" }>): SyncFrame {
  return {
    type: "APPLY_ACK",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    transportEpoch: frame.transportEpoch,
    deliveryId: frame.deliveryId,
    result: "processed",
    docId: frame.docId,
    appliedSeq: frame.type === "DOC_BASE" ? frame.baseSeq : frame.toSeq,
  };
}

async function waitForFrame(
  ws: MockWs,
  type: SyncFrame["type"],
  docId: string,
  timeoutMs = 2_000,
): Promise<Extract<SyncFrame, { type: "DOC_BASE" }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = syncFrames(ws).find(
      (candidate): candidate is Extract<SyncFrame, { type: "DOC_BASE" }> =>
        candidate.type === type && "docId" in candidate && candidate.docId === docId,
    );
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${type} on ${docId}`);
}

/** 解码连接已收到的全部内容记录，用于断言文本隔离。 */
function receivedTexts(ws: MockWs): string[] {
  const texts: string[] = [];
  for (const frame of syncFrames(ws)) {
    if (frame.type !== "DOC_BASE" && frame.type !== "DOC_UPDATE") continue;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(frame.payload, "base64"));
    const records = doc.getMap<unknown>("root").get("records");
    if (records instanceof Y.Array) {
      for (const value of records.toArray()) {
        if (typeof value !== "object" || value === null) continue;
        const record = value as { kind?: unknown; payload?: unknown };
        if (!(record.payload instanceof Uint8Array)) continue;
        if (record.kind === "text") texts.push(new TextDecoder().decode(record.payload));
        else if (record.kind === "text_part") {
          const parsed = fidelityDeserialize(record.payload);
          if (typeof parsed === "string") texts.push(parsed);
        }
      }
    }
    doc.destroy();
  }
  return texts;
}

async function waitForText(ws: MockWs, docId: string, expected: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const doc = new Y.Doc();
    for (const frame of syncFrames(ws)) {
      if ((frame.type === "DOC_BASE" || frame.type === "DOC_UPDATE") && frame.docId === docId) {
        Y.applyUpdate(doc, Buffer.from(frame.payload, "base64"));
      }
    }
    const records = doc.getMap<unknown>("root").get("records");
    const texts: string[] = [];
    if (records instanceof Y.Array) {
      for (const value of records.toArray()) {
        if (typeof value !== "object" || value === null) continue;
        const record = value as { kind?: unknown; payload?: unknown };
        if (!(record.payload instanceof Uint8Array)) continue;
        if (record.kind === "text") texts.push(new TextDecoder().decode(record.payload));
        else if (record.kind === "text_part") {
          const parsed = fidelityDeserialize(record.payload);
          if (typeof parsed === "string") texts.push(parsed);
        }
      }
    }
    doc.destroy();
    if (texts.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for text "${expected}" on ${docId}`);
}

/** 连接一个真实 WebSocket 并订阅目录与内容块，返回可见内容 doc id。 */
async function connect(controller: ChatChannelController, wsId: string, ws: MockWs): Promise<string[]> {
  await controller.gateway.handleOpen(ws, wsId, "user-1", "agent-1", LOCATOR);
  return await handshake(controller, wsId, ws);
}

/** 已登记连接的同步握手与订阅；用于在 attach 窗口后补发 HELLO。 */
async function handshake(controller: ChatChannelController, wsId: string, ws: MockWs): Promise<string[]> {
  await controller.gateway.handleMessage(
    ws,
    wsId,
    encodeSyncFrame({
      type: "HELLO",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      scope: { organizationId: "self-reported", rcsSessionId: "self-reported" },
      loadedDocs: [],
      stateful: false,
    }),
  );
  const manifest = frameOfType(ws, "MANIFEST");
  if (!manifest) throw new Error(`expected MANIFEST; closed=${JSON.stringify(ws.closed)} frames=${ws.messages.length}`);
  await controller.gateway.handleMessage(
    ws,
    wsId,
    encodeSyncFrame({
      type: "SUBSCRIBE",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      docIds: [manifest.directoryDocId],
      priority: "live",
    }),
  );
  const directoryBase = baseFor(ws, manifest.directoryDocId);
  if (!directoryBase) throw new Error("expected directory DOC_BASE");
  const directory = new Y.Doc();
  Y.applyUpdate(directory, Buffer.from(directoryBase.payload, "base64"));
  const { latestPageId } = readDirectoryRoot(directory);
  directory.destroy();
  if (!latestPageId) throw new Error("expected latest page");
  await controller.gateway.handleMessage(
    ws,
    wsId,
    encodeSyncFrame({
      type: "SUBSCRIBE",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      docIds: [latestPageId],
      priority: "live",
    }),
  );
  const pageBase = baseFor(ws, latestPageId);
  if (!pageBase) throw new Error("expected page DOC_BASE");
  const page = new Y.Doc();
  Y.applyUpdate(page, Buffer.from(pageBase.payload, "base64"));
  const contentDocIds = readDirectoryPage(page).contentDocIds;
  page.destroy();
  await controller.gateway.handleMessage(ws, wsId, encodeSyncFrame(ackFor(directoryBase)));
  await controller.gateway.handleMessage(ws, wsId, encodeSyncFrame(ackFor(pageBase)));
  for (const docId of contentDocIds) {
    await controller.gateway.handleMessage(
      ws,
      wsId,
      encodeSyncFrame({
        type: "SUBSCRIBE",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        docIds: [docId],
        priority: "currentHistory",
      }),
    );
    const base = await waitForFrame(ws, "DOC_BASE", docId);
    await controller.gateway.handleMessage(ws, wsId, encodeSyncFrame(ackFor(base)));
  }
  return contentDocIds;
}

/** 向旧 Chat Doc 写一条已提交历史，供同步握手导入。 */
async function writeCommittedText(docManager: DocManager, text: string): Promise<void> {
  const chat = await docManager.openChat(RCS);
  const entryId = `turn_${text}:assistant`;
  ensureEntry(chat.ydoc, { entryId, turnId: `turn_${text}`, kind: "assistant", role: "assistant" });
  appendEntryText(chat.ydoc, entryId, "text:1", "text", text);
  setEntryStatus(chat.ydoc, entryId, "completed");
}

/** 通过真实 Action 链路切换 ACP 会话（load/resume 均由 SessionChannel 处理）。 */
async function switchSession(
  controller: ChatChannelController,
  ws: MockWs,
  wsId: string,
  action: string,
  sessionId = "ses-B",
): Promise<void> {
  await controller.gateway.handleMessage(
    ws,
    wsId,
    JSON.stringify({ action, sessionId, commandId: `switch-${action}` }),
  );
}

describe("会话切换的服务端权威换代", () => {
  // 两个标签页先读到 A 历史；load_session 切到 B 后必须被服务端主动关闭并用新代次重建，A 文本不得进入 B。
  test("A→B→A：旧连接失效，B/A 新连接只看到各自代次", async () => {
    const { controller, docManager } = createHarness();
    try {
      await writeCommittedText(docManager, "text-A");
      const ws1 = createWs();
      const ws2 = createWs();
      const ids1 = await connect(controller, "ws-a1", ws1);
      const ids2 = await connect(controller, "ws-a2", ws2);
      const contentA1 = ids1[0];
      const contentA2 = ids2[0];
      if (!contentA1 || !contentA2) throw new Error("expected A history content");
      await waitForText(ws1, contentA1, "text-A");
      await waitForText(ws2, contentA2, "text-A");

      await switchSession(controller, ws1, "ws-a1", "load_session");
      expect(ws1.closed[0]).toEqual([1012, "projection replaced"]);
      expect(ws2.closed[0]).toEqual([1012, "projection replaced"]);
      controller.gateway.handleClose("ws-a1");
      controller.gateway.handleClose("ws-a2");

      await writeCommittedText(docManager, "text-B");
      const ws3 = createWs();
      const ids3 = await connect(controller, "ws-b1", ws3);
      const contentB = ids3[0];
      if (!contentB) throw new Error("expected B history content");
      await waitForText(ws3, contentB, "text-B");
      expect(receivedTexts(ws3)).not.toContain("text-A");

      await switchSession(controller, ws3, "ws-b1", "load_session", "ses-A");
      expect(ws3.closed[0]).toEqual([1012, "projection replaced"]);
      controller.gateway.handleClose("ws-b1");
      // A 代次恢复依赖 ACP load 回放：回放完成后新连接必须重新读到 A，而不是停留在 B。
      await writeCommittedText(docManager, "text-A");
      const ws4 = createWs();
      const ids4 = await connect(controller, "ws-a3", ws4);
      const contentA3 = ids4[0];
      if (!contentA3) throw new Error("expected A history content");
      await waitForText(ws4, contentA3, "text-A");
      expect(receivedTexts(ws4)).not.toContain("text-B");
      controller.gateway.handleClose("ws-a3");
    } finally {
      controller.gateway.handleClose("ws-a1");
      controller.gateway.handleClose("ws-a2");
      controller.gateway.handleClose("ws-b1");
      controller.gateway.handleClose("ws-a3");
    }
  });

  // replace 帧被 64KB 背压跳过时，服务端仍必须权威失效旧连接，不能等客户端收到换代帧。
  test("legacy replace 帧被背压跳过时旧连接仍然失效", async () => {
    const { controller, docManager } = createHarness();
    try {
      await writeCommittedText(docManager, "text-A");
      const ws = createWs(70 * 1024);
      await connect(controller, "ws-blocked", ws);
      await switchSession(controller, ws, "ws-blocked", "load_session");
      expect(ws.closed[0]).toEqual([1012, "projection replaced"]);
      expect(controller.registry.getClient("ws-blocked")?.syncConnection).toBeUndefined();
    } finally {
      controller.gateway.handleClose("ws-blocked");
    }
  });

  // 旧动作连接发 prompt 时，用户消息必须经会话级入口进入所有同步连接（B01），且各轮 turn 不重复。
  test("旧连接发送的用户消息进入所有同步连接且每轮一次", async () => {
    const { controller } = createHarness();
    try {
      const actionWs = createWs();
      await controller.gateway.handleOpen(actionWs, "ws-action", "user-1", "agent-1", LOCATOR);
      const syncWs1 = createWs();
      const syncWs2 = createWs();
      await connect(controller, "ws-sync1", syncWs1);
      await connect(controller, "ws-sync2", syncWs2);

      const received: Array<{ tab: string; turnId: string; text: string }> = [];
      for (const [tab, wsId] of [
        ["tab-1", "ws-sync1"],
        ["tab-2", "ws-sync2"],
      ] as const) {
        const connection = controller.registry.getClient(wsId)?.syncConnection;
        if (!connection) throw new Error(`expected sync connection on ${wsId}`);
        const original = connection.acceptUserMessage.bind(connection);
        connection.acceptUserMessage = (turnId, text) => {
          received.push({ tab, turnId, text });
          original(turnId, text);
        };
      }

      for (const [index, text] of ["first question", "second question"].entries()) {
        await controller.gateway.handleMessage(
          actionWs,
          "ws-action",
          JSON.stringify({ action: "send_prompt", commandId: `prompt-${index}`, content: [{ type: "text", text }] }),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(received.filter((entry) => entry.tab === "tab-1").map((entry) => entry.text)).toEqual([
        "first question",
        "second question",
      ]);
      expect(received.filter((entry) => entry.tab === "tab-2").map((entry) => entry.text)).toEqual([
        "first question",
        "second question",
      ]);
      expect(new Set(received.map((entry) => entry.turnId)).size).toBe(2);
    } finally {
      controller.gateway.handleClose("ws-action");
      controller.gateway.handleClose("ws-sync1");
      controller.gateway.handleClose("ws-sync2");
    }
  });

  // attach 窗口内的首条 prompt 必须补水到握手后的同步投影，且多个标签各只出现一次（B01）。
  test("attach 前发送的首条 prompt 在握手后补齐且只出现一次", async () => {
    const { controller } = createHarness();
    try {
      const actionWs = createWs();
      await controller.gateway.handleOpen(actionWs, "ws-action-race", "user-1", "agent-1", LOCATOR);
      const syncWs1 = createWs();
      const syncWs2 = createWs();
      await controller.gateway.handleOpen(syncWs1, "ws-race1", "user-1", "agent-1", LOCATOR);
      await controller.gateway.handleOpen(syncWs2, "ws-race2", "user-1", "agent-1", LOCATOR);

      await controller.gateway.handleMessage(
        actionWs,
        "ws-action-race",
        JSON.stringify({
          action: "send_prompt",
          commandId: "prompt-race",
          content: [{ type: "text", text: "attach race question" }],
        }),
      );
      await handshake(controller, "ws-race1", syncWs1);
      await handshake(controller, "ws-race2", syncWs2);

      expect(receivedTexts(syncWs1).filter((text) => text === "attach race question")).toHaveLength(1);
      expect(receivedTexts(syncWs2).filter((text) => text === "attach race question")).toHaveLength(1);
    } finally {
      controller.gateway.handleClose("ws-action-race");
      controller.gateway.handleClose("ws-race1");
      controller.gateway.handleClose("ws-race2");
    }
  });

  // legacy 连接没有 sync runtime：普通 replace 帧会被 64KB 背压跳过，服务端必须强制送达新代次（B04）。
  test("legacy 连接在背压下仍收到权威 replace 帧", async () => {
    const { controller } = createHarness();
    try {
      const ws = createWs(70 * 1024);
      await controller.gateway.handleOpen(ws, "ws-legacy-backpressure", "user-1", "agent-1", LOCATOR);
      await switchSession(controller, ws, "ws-legacy-backpressure", "load_session");
      const replaced = ws.messages
        .filter((message): message is Uint8Array => message instanceof Uint8Array)
        .map((message) => decodeYjsSyncFrame(message))
        .filter((frame) => frame?.type === "replace");
      expect(replaced.length).toBeGreaterThanOrEqual(2);
      expect(ws.closed).toEqual([]);
    } finally {
      controller.gateway.handleClose("ws-legacy-backpressure");
    }
  });

  // 跨进程换代：节点 B 的内存 Doc 不变，但共享 Redis active generation 变化后必须失效已挂连接（B04）。
  test("共享 Redis 的跨进程换代使已挂连接失效", async () => {
    const redis = new FakeRedis();
    const docManager = new DocManager({ getRedis: () => redis as never, onError: () => {}, onLog: () => {} });
    docManager.setSnapshotPersistConfigSource(() => ({ intervalMs: 2_000, idleMs: 500, ttlSeconds: 604_800 }));
    await docManager.openChat(RCS);
    const { controller } = createHarness(docManager);
    try {
      const ws = createWs();
      await connect(controller, "ws-cross-process", ws);
      redis.seedActiveGeneration(RCS, "gen-remote-process");
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline && ws.closed.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(ws.closed[0]?.[0]).toBe(1012);
    } finally {
      controller.gateway.handleClose("ws-cross-process");
    }
  });

  // resume_session 同样切换 ACP 会话，必须换代，不能把 B 的历史挂到 A 的投影/store 上。
  test("resume_session 切换会话触发换代，新连接不复用 A 历史", async () => {
    const { controller, docManager } = createHarness();
    try {
      await writeCommittedText(docManager, "text-A");
      const ws = createWs();
      await connect(controller, "ws-resume", ws);
      await switchSession(controller, ws, "ws-resume", "resume_session");
      expect(ws.closed[0]).toEqual([1012, "projection replaced"]);
      controller.gateway.handleClose("ws-resume");

      const reconnected = createWs();
      await connect(controller, "ws-resume-new", reconnected);
      expect(receivedTexts(reconnected)).not.toContain("text-A");
      controller.gateway.handleClose("ws-resume-new");
    } finally {
      controller.gateway.handleClose("ws-resume");
      controller.gateway.handleClose("ws-resume-new");
    }
  });
});
