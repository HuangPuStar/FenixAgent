// packages/chat-channel/src/__tests__/sync-gateway-e2e.test.ts
// 新协议宿主接线的端到端用例：真实 ChatChannelController / Gateway / SyncHostSession / runtime，
// 假 WebSocket 与假时钟；只把传输端口与时间源替换掉。
//
// 覆盖：开关开启的完整数据面（stateless HELLO → MANIFEST → 目录发现 → 内容订阅 → DOC_BASE →
// DOC_UPDATE → APPLY_ACK → 连接窗口归零），真实旧 Chat Doc 历史经握手导入，同 scope 两个标签页
// 共享同一代次与活动尾块，以及开关关闭时 `{` 帧 1008 拒绝、旧文本/旧 Yjs 帧路径不变。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { createWs, type MockWs } from "../channel/connection-test-helpers";
import { ChatChannelController } from "../channel/controller";
import { encodeYjsStateVectorFrame } from "../protocol/update-frame";
import { appendEntryText, ensureEntry, setEntryStatus } from "../state/chat-writer";
import { DocManager } from "../state/doc-manager";
import { type Clock, deterministicRandomSource, sha256Digest } from "../sync/clock";
import { fidelityDeserialize } from "../sync/history/fidelity-json";
import { readDirectoryPage, readDirectoryRoot } from "../sync/protocol/directory";
import { decodeSyncFrame, encodeSyncFrame, SYNC_PROTOCOL_VERSION, type SyncFrame } from "../sync/protocol/frames";

const WS_ID = "ws-sync-e2e";
const LOCATOR = { instanceUid: "instance-e2e", rcsSessionId: "rcs-e2e" };
const NOW = 1_700_000_000_000;

/** 固定时刻的假时钟：租约、ACK 期限与合并窗口都不随墙钟漂移。 */
const CLOCK: Clock = { now: () => NOW };

/** 真实控制器装配：只替换宿主能力与传输边界，协议栈全部使用生产实现。 */
function createController(enabled: boolean): {
  controller: ChatChannelController;
  ws: MockWs;
  docManager: DocManager;
} {
  const docManager = new DocManager({ onError: () => {}, onLog: () => {} });
  const controller = new ChatChannelController({
    docManager,
    getEnvironment: async () => ({ userId: "user-1", organizationId: "org-1" }),
    authorizeEnvironment: () => true,
    resolveWorkspacePath: () => "/workspace",
    ensureRunning: async () => LOCATOR.instanceUid,
    connectAgentRelay: async () => ({ state: "open", send() {}, close() {} }),
    refreshInstanceEnvironment: async () => {},
    markRelayAttached() {},
    markRelayDetached() {},
    touchInstanceActivity() {},
    terminateLocalDeadInstance() {},
    isMachineOffline: () => false,
    classifyPermanentSpawnFailure: () => null,
    maxClients: () => 10,
    chatSyncProtocol: { enabled, sealGraceMs: 2_000, retireGraceMs: 30_000 },
    syncHostOverrides: {
      clock: CLOCK,
      random: deterministicRandomSource("sync-gateway-e2e"),
      digest: sha256Digest,
      tickIntervalMs: 10,
    },
    snapshotPersist: () => ({ intervalMs: 2_000, idleMs: 500, ttlSeconds: 604_800 }),
    log() {},
    reportError() {},
  });
  return { controller, ws: createWs(), docManager };
}

/** 只保留新协议帧：旧 Yjs 帧首字节不是 `{`。 */
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

function helloFrame(): SyncFrame {
  return {
    type: "HELLO",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    scope: { organizationId: "self-reported", rcsSessionId: "self-reported" },
    loadedDocs: [],
    stateful: false,
  };
}

async function send(controller: ChatChannelController, ws: MockWs, frame: SyncFrame, wsId = WS_ID): Promise<void> {
  await controller.gateway.handleMessage(ws, wsId, encodeSyncFrame(frame));
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

/** 轮询等待服务端产出的数据帧；假时钟不驱动宿主定时器，真实定时器负责 tick。 */
async function waitForFrame<T extends SyncFrame["type"]>(
  ws: MockWs,
  type: T,
  docId: string,
  timeoutMs = 2_000,
): Promise<Extract<SyncFrame, { type: T }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = syncFrames(ws).find(
      (candidate): candidate is Extract<SyncFrame, { type: T }> =>
        candidate.type === type && "docId" in candidate && candidate.docId === docId,
    );
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${type} on ${docId}`);
}

function expectWindowClosed(controller: ChatChannelController): void {
  expect(controller.registry.getClient(WS_ID)?.syncConnection?.diagnostics?.()).toEqual({
    outstandingBytes: 0,
    pendingTasks: 0,
    unackedDeliveries: 0,
  });
}

/** 按该连接已收到的 DOC_BASE/DOC_UPDATE 重建一个 Doc；帧顺序即服务端发送顺序。 */
function materializeDoc(ws: MockWs, docId: string): Y.Doc {
  const doc = new Y.Doc();
  for (const frame of syncFrames(ws)) {
    if ((frame.type === "DOC_BASE" || frame.type === "DOC_UPDATE") && frame.docId === docId) {
      Y.applyUpdate(doc, Buffer.from(frame.payload, "base64"));
    }
  }
  return doc;
}

/** 内容块中的可见正文：历史记录是 `text_part`（保真 JSON），实时记录是 `text`（裸 UTF-8）。 */
function recordTexts(doc: Y.Doc): string[] {
  const records = doc.getMap<unknown>("root").get("records");
  if (!(records instanceof Y.Array)) return [];
  const texts: string[] = [];
  for (const value of records.toArray()) {
    if (typeof value !== "object" || value === null) continue;
    const record = value as { kind?: unknown; payload?: unknown };
    if (!(record.payload instanceof Uint8Array)) continue;
    if (record.kind === "text") {
      texts.push(new TextDecoder().decode(record.payload));
    } else if (record.kind === "text_part") {
      const parsed = fidelityDeserialize(record.payload);
      if (typeof parsed === "string") texts.push(parsed);
    }
  }
  return texts;
}

/** 等待某连接从已投递帧中重建出目标正文（DOC_BASE 可能已折叠 tail）。 */
async function waitForText(ws: MockWs, docId: string, expected: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const doc = materializeDoc(ws, docId);
    const found = recordTexts(doc).includes(expected);
    doc.destroy();
    if (found) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for text "${expected}" on ${docId}`);
}

/** 订阅目录根与最新页，结清两次 DOC_BASE，返回页里的内容块顺序。 */
async function openDirectory(
  controller: ChatChannelController,
  ws: MockWs,
  manifest: Extract<SyncFrame, { type: "MANIFEST" }>,
  wsId = WS_ID,
): Promise<{ readonly pageDocId: string; readonly contentDocIds: readonly string[] }> {
  await send(
    controller,
    ws,
    {
      type: "SUBSCRIBE",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      docIds: [manifest.directoryDocId],
      priority: "live",
    },
    wsId,
  );
  const directoryBase = await waitForFrame(ws, "DOC_BASE", manifest.directoryDocId);
  const directory = new Y.Doc();
  Y.applyUpdate(directory, Buffer.from(directoryBase.payload, "base64"));
  const { latestPageId } = readDirectoryRoot(directory);
  directory.destroy();
  if (!latestPageId) throw new Error("expected latestPageId in directory root");

  await send(
    controller,
    ws,
    {
      type: "SUBSCRIBE",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      docIds: [latestPageId],
      priority: "live",
    },
    wsId,
  );
  const pageBase = await waitForFrame(ws, "DOC_BASE", latestPageId);
  const page = new Y.Doc();
  Y.applyUpdate(page, Buffer.from(pageBase.payload, "base64"));
  const contentDocIds = readDirectoryPage(page).contentDocIds;
  page.destroy();
  await send(controller, ws, ackFor(directoryBase), wsId);
  await send(controller, ws, ackFor(pageBase), wsId);
  return { pageDocId: latestPageId, contentDocIds };
}

describe("sync gateway end-to-end", () => {
  // 连接建立时写 timelineEmpty：客户端据此区分已有空会话与回放未开始，不再依赖计时兜底。
  test("连接建立写入 timelineEmpty", async () => {
    const { controller, ws, docManager } = createController(true);
    try {
      await controller.gateway.handleOpen(ws, WS_ID, "user-1", "agent-1", LOCATOR);
      const session = docManager.getSession(LOCATOR.rcsSessionId)?.ydoc.getMap("root").get("session") as
        | Y.Map<unknown>
        | undefined;
      expect(session?.get("timelineEmpty")).toBe(true);
    } finally {
      controller.gateway.handleClose(WS_ID);
    }
  });

  // 真实竞态：浏览器 open 后立刻发 HELLO，服务端 handleOpen 仍在异步装配；必须暂存而非 1008。
  test("entry 创建前的 HELLO 被暂存，不关闭连接", async () => {
    const { controller, ws } = createController(true);
    try {
      const opening = controller.gateway.handleOpen(ws, WS_ID, "user-1", "agent-1", LOCATOR);
      await controller.gateway.handleMessage(ws, WS_ID, encodeSyncFrame(helloFrame()));
      expect(ws.closed).toEqual([]);

      await opening;
      expect(ws.closed).toEqual([]);
      expect(frameOfType(ws, "MANIFEST")).toBeDefined();
    } finally {
      controller.gateway.handleClose(WS_ID);
    }
  });

  // 路由层在认证/环境解析完成前就分配了 wsId：此时连 pending 都未登记，HELLO 仍必须暂存。
  test("handleOpen 之前的 HELLO 被暂存，不关闭连接", async () => {
    const { controller, ws } = createController(true);
    try {
      await controller.gateway.handleMessage(ws, WS_ID, encodeSyncFrame(helloFrame()));
      expect(ws.closed).toEqual([]);

      await controller.gateway.handleOpen(ws, WS_ID, "user-1", "agent-1", LOCATOR);
      expect(ws.closed).toEqual([]);
      expect(frameOfType(ws, "MANIFEST")).toBeDefined();
    } finally {
      controller.gateway.handleClose(WS_ID);
    }
  });

  // 开关开启：从 stateless HELLO 到内容块 DOC_UPDATE/APPLY_ACK 全链路，连接窗口在每次结清后归零。
  test("开关开启时 HELLO→MANIFEST→目录→内容→DOC_UPDATE→ACK 贯通且窗口归零", async () => {
    const { controller, ws } = createController(true);
    try {
      await controller.gateway.handleOpen(ws, WS_ID, "user-1", "agent-1", LOCATOR);
      const hello = helloFrame();
      expect(hello.stateful).toBe(false);
      expect("generation" in hello).toBe(false);
      await send(controller, ws, hello);

      const manifest = frameOfType(ws, "MANIFEST");
      if (!manifest) throw new Error("expected MANIFEST after stateless HELLO");
      expect(manifest.recoveryState).toBeString();
      expect(manifest.generation.length).toBeGreaterThan(0);

      await send(controller, ws, {
        type: "SUBSCRIBE",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        docIds: [manifest.directoryDocId],
        priority: "live",
      });
      const directoryBase = baseFor(ws, manifest.directoryDocId);
      if (!directoryBase) throw new Error("expected directory DOC_BASE");
      const directory = new Y.Doc();
      Y.applyUpdate(directory, Buffer.from(directoryBase.payload, "base64"));
      const { latestPageId } = readDirectoryRoot(directory);
      directory.destroy();
      if (!latestPageId) throw new Error("expected latestPageId in directory root");

      // 目录分页：根目录只给最新页 ID，内容块在页 Doc 里。
      await send(controller, ws, {
        type: "SUBSCRIBE",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        docIds: [latestPageId],
        priority: "live",
      });
      const pageBase = baseFor(ws, latestPageId);
      if (!pageBase) throw new Error("expected directory page DOC_BASE");
      const page = new Y.Doc();
      Y.applyUpdate(page, Buffer.from(pageBase.payload, "base64"));
      const contentDocId = readDirectoryPage(page).contentDocIds[0];
      page.destroy();
      if (!contentDocId) throw new Error("expected contentDocIds in directory page baseline");

      await send(controller, ws, {
        type: "SUBSCRIBE",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        docIds: [contentDocId],
        priority: "currentHistory",
      });
      const contentBase = baseFor(ws, contentDocId);
      if (!contentBase) throw new Error("expected content DOC_BASE");

      await send(controller, ws, ackFor(directoryBase));
      await send(controller, ws, ackFor(pageBase));
      await send(controller, ws, ackFor(contentBase));
      expectWindowClosed(controller);

      controller.registry.getClient(WS_ID)?.syncConnection?.acceptUserMessage("turn-e2e", "hello e2e");
      const update = await waitForFrame(ws, "DOC_UPDATE", contentDocId);
      await send(controller, ws, ackFor(update));
      expectWindowClosed(controller);
    } finally {
      controller.gateway.handleClose(WS_ID);
    }
  });

  // 真实历史源（旧 Chat Doc 已提交时间线）经握手导入；同 scope 两个标签页共享同一代次，
  // 历史块保持只读，leader 的实时写入落到新建的 active 尾块，follower 从共享已提交边界读到同一正文。
  test("旧 Chat Doc 历史经握手导入，两个标签页共享代次与活动尾块", async () => {
    const { controller, ws, docManager } = createController(true);
    const secondWs = createWs();
    const secondId = "ws-sync-e2e-2";
    try {
      const chat = await docManager.openChat(LOCATOR.rcsSessionId);
      ensureEntry(chat.ydoc, {
        entryId: "turn-legacy:user",
        turnId: "turn-legacy",
        kind: "message",
        role: "user",
      });
      appendEntryText(chat.ydoc, "turn-legacy:user", "text:1", "text", "legacy hello");
      setEntryStatus(chat.ydoc, "turn-legacy:user", "completed");

      await controller.gateway.handleOpen(ws, WS_ID, "user-1", "agent-1", LOCATOR);
      await controller.gateway.handleOpen(secondWs, secondId, "user-1", "agent-1", LOCATOR);
      await send(controller, ws, helloFrame());
      await send(controller, secondWs, helloFrame(), secondId);
      const firstManifest = frameOfType(ws, "MANIFEST");
      const secondManifest = frameOfType(secondWs, "MANIFEST");
      if (!firstManifest || !secondManifest) throw new Error("expected MANIFEST on both connections");
      // 共享 store 与一次历史引导：两个连接必须落在同一代次。
      expect(secondManifest.generation).toBe(firstManifest.generation);

      const firstDirectory = await openDirectory(controller, ws, firstManifest);
      const secondDirectory = await openDirectory(controller, secondWs, secondManifest, secondId);
      expect(secondDirectory.contentDocIds).toEqual(firstDirectory.contentDocIds);
      const historyDocId = firstDirectory.contentDocIds[0];
      if (!historyDocId) throw new Error("expected imported history content block");

      // 真实旧 Chat Doc 的正文确实进入了已提交历史块，两个标签页读到同一份事实。
      await send(controller, ws, {
        type: "SUBSCRIBE",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        docIds: [historyDocId],
        priority: "currentHistory",
      });
      await send(
        controller,
        secondWs,
        {
          type: "SUBSCRIBE",
          protocolVersion: SYNC_PROTOCOL_VERSION,
          docIds: [historyDocId],
          priority: "currentHistory",
        },
        secondId,
      );
      const firstHistoryBase = await waitForFrame(ws, "DOC_BASE", historyDocId);
      const secondHistoryBase = await waitForFrame(secondWs, "DOC_BASE", historyDocId);
      await waitForText(ws, historyDocId, "legacy hello");
      await waitForText(secondWs, historyDocId, "legacy hello");
      await send(controller, ws, ackFor(firstHistoryBase));
      await send(controller, secondWs, ackFor(secondHistoryBase), secondId);

      // leader（第一条连接）实时写入：历史块已封口，写入必须落到目录页新追加的 active 尾块。
      controller.registry.getClient(WS_ID)?.syncConnection?.acceptUserMessage("turn-live", "live hello");
      let liveDocId: string | undefined;
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && liveDocId === undefined) {
        const pageDoc = materializeDoc(ws, firstDirectory.pageDocId);
        const tail = readDirectoryPage(pageDoc).contentDocIds.at(-1);
        pageDoc.destroy();
        if (tail !== undefined && !firstDirectory.contentDocIds.includes(tail)) liveDocId = tail;
        else await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (liveDocId === undefined) throw new Error("timed out waiting for live content tail");
      expect(firstDirectory.contentDocIds).not.toContain(liveDocId);

      for (const [targetWs, targetId] of [
        [ws, WS_ID],
        [secondWs, secondId],
      ] as const) {
        await send(
          controller,
          targetWs,
          {
            type: "SUBSCRIBE",
            protocolVersion: SYNC_PROTOCOL_VERSION,
            docIds: [liveDocId],
            priority: "live",
          },
          targetId,
        );
        const base = await waitForFrame(targetWs, "DOC_BASE", liveDocId);
        // 先结清基线回执，provider 才会补发 BASE_READY 与其后的 tail 更新。
        await send(controller, targetWs, ackFor(base), targetId);
        await waitForText(targetWs, liveDocId, "live hello");
      }
    } finally {
      controller.gateway.handleClose(secondId);
      controller.gateway.handleClose(WS_ID);
    }
  });

  // 开关关闭：`{` 帧明确 1008；旧文本 ping/pong 与旧 Yjs state-vector 帧在收到 `{` 前不受影响。
  test("开关关闭时旧文本/旧 Yjs 帧不变，`{` 帧以 1008 拒绝", async () => {
    const { controller, ws, docManager } = createController(false);
    try {
      await controller.gateway.handleOpen(ws, WS_ID, "user-1", "agent-1", LOCATOR);
      await controller.gateway.handleMessage(ws, WS_ID, JSON.stringify({ type: "ping" }));
      expect(ws.messages).toContain(JSON.stringify({ type: "pong" }));

      const chat = docManager.getChat(LOCATOR.rcsSessionId);
      if (!chat) throw new Error("expected chat doc after open");
      const beforeLegacy = ws.messages.length;
      await controller.gateway.handleMessage(
        ws,
        WS_ID,
        encodeYjsStateVectorFrame(`chat:${LOCATOR.rcsSessionId}`, chat.generation, Y.encodeStateVector(new Y.Doc())),
      );
      expect(
        ws.messages.slice(beforeLegacy).some((message) => message instanceof Uint8Array && message[0] !== 0x7b),
      ).toBe(true);
      expect(ws.closed).toHaveLength(0);
      expect(syncFrames(ws)).toHaveLength(0);

      await send(controller, ws, helloFrame());
      expect(ws.closed).toContainEqual([1008, "sync protocol disabled"]);
    } finally {
      controller.gateway.handleClose(WS_ID);
    }
  });
});
