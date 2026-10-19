// packages/chat-channel/src/__tests__/sync-gateway-e2e.test.ts
// 新协议宿主接线的端到端用例：真实 ChatChannelController / Gateway / SyncHostSession / runtime，
// 假 WebSocket 与假时钟；只把传输端口与时间源替换掉。
//
// 覆盖：开关开启的完整数据面（stateless HELLO → MANIFEST → 目录发现 → 内容订阅 → DOC_BASE →
// DOC_UPDATE → APPLY_ACK → 连接窗口归零），以及开关关闭时 `{` 帧 1008 拒绝、旧文本/旧 Yjs 帧路径不变。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { createWs, type MockWs } from "../channel/connection-test-helpers";
import { ChatChannelController } from "../channel/controller";
import { encodeYjsStateVectorFrame } from "../protocol/update-frame";
import { DocManager } from "../state/doc-manager";
import { type Clock, deterministicRandomSource, sha256Digest } from "../sync/clock";
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

async function send(controller: ChatChannelController, ws: MockWs, frame: SyncFrame): Promise<void> {
  await controller.gateway.handleMessage(ws, WS_ID, encodeSyncFrame(frame));
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

describe("sync gateway end-to-end", () => {
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
      const contentDocId = (directory.getMap("root").get("contentDocIds") as Y.Array<string>).get(0);
      directory.destroy();
      if (!contentDocId) throw new Error("expected contentDocIds in directory baseline");

      await send(controller, ws, {
        type: "SUBSCRIBE",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        docIds: [contentDocId],
        priority: "currentHistory",
      });
      const contentBase = baseFor(ws, contentDocId);
      if (!contentBase) throw new Error("expected content DOC_BASE");

      await send(controller, ws, ackFor(directoryBase));
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
