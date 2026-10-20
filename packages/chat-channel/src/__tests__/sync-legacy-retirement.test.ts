// packages/chat-channel/src/__tests__/sync-legacy-retirement.test.ts
// 旧全量通道退役边界：`chatSync=1` 声明的 sync-only 连接不再接收旧全量快照、
// 旧 Doc 广播与 legacy state-vector 差量；文本 action 与旧连接行为保持不变。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { YjsBroadcaster } from "../channel/broadcaster";
import { ConnectionRegistry } from "../channel/connection-registry";
import {
  createBoundDocs,
  createGateway,
  createRelayEvents,
  createWs,
  decodeUpdateFrames,
  type MockWs,
  textFrames,
} from "../channel/connection-test-helpers";
import { encodeYjsStateVectorFrame } from "../protocol/update-frame";

const LOCATOR = { instanceUid: "instance-1", rcsSessionId: "rcs-1" } as const;

/** 真实 DocManager + 记录 relay 发送的 Gateway；旧/新连接共用同一装配。 */
async function createHarness(rcsSessionId = LOCATOR.rcsSessionId) {
  const registry = new ConnectionRegistry();
  const broadcaster = new YjsBroadcaster(registry);
  const relayEvents = createRelayEvents(registry, broadcaster, []);
  const { docManager, chatDoc, sessionDoc } = await createBoundDocs(rcsSessionId);
  const relaySent: Record<string, unknown>[] = [];
  const gateway = createGateway(
    registry,
    broadcaster,
    relayEvents,
    {
      connectAgentRelay: async () =>
        ({
          state: "open",
          send(message: Record<string, unknown>) {
            relaySent.push(message);
          },
          close() {},
        }) as never,
    },
    {
      openChat: (id: string) => docManager.openChat(id),
      openSession: (userId: string, agentId: string, id: string) => docManager.openSession(userId, agentId, id),
      getChat: (id: string) => docManager.getChat(id),
      getSession: (id: string) => docManager.getSession(id),
      getSessionYdoc: (id: string) => docManager.getSessionYdoc(id),
      hasTimelineContent: (id: string) => docManager.hasTimelineContent(id),
    },
  );
  return { registry, broadcaster, gateway, docManager, chatDoc, sessionDoc, relaySent };
}

/** 等待 broadcaster 的 microtask 批量发送落地。 */
function flushBroadcast(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function hasSyncRequest(ws: MockWs): boolean {
  return textFrames(ws).some((frame) => frame.includes("yjs:sync-request"));
}

describe("旧全量通道退役边界", () => {
  // sync-only 连接不参与旧握手：无 sync-request、无旧快照，但文本控制帧仍可达。
  test("sync-only 连接跳过旧全量初始同步并保留文本控制帧", async () => {
    const { gateway, registry } = await createHarness();
    const ws = createWs();
    try {
      await gateway.handleOpen(ws, "ws-sync", "user-1", "agent-1", { ...LOCATOR, syncOnly: true });
      expect(registry.getClient("ws-sync")?.syncOnly).toBe(true);
      expect(hasSyncRequest(ws)).toBe(false);
      expect(decodeUpdateFrames(ws)).toHaveLength(0);

      await gateway.handleMessage(ws, "ws-sync", JSON.stringify({ type: "ping" }));
      expect(textFrames(ws)).toContain(JSON.stringify({ type: "pong" }));
    } finally {
      gateway.handleClose("ws-sync");
    }
  });

  // 旧客户端（无 chatSync 标记）保持原行为：仍收到 500ms 握手的 sync-request。
  test("旧连接仍收到旧全量握手请求", async () => {
    const { gateway } = await createHarness();
    const ws = createWs();
    try {
      await gateway.handleOpen(ws, "ws-legacy", "user-1", "agent-1", LOCATOR);
      expect(hasSyncRequest(ws)).toBe(true);
    } finally {
      gateway.handleClose("ws-legacy");
    }
  });

  // sync-only 的 legacy state-vector 被忽略；旧连接仍得到定向差量。
  test("sync-only 忽略 legacy state-vector 而旧连接保留差量", async () => {
    const { gateway, docManager } = await createHarness();
    const syncWs = createWs();
    const legacyWs = createWs();
    try {
      await gateway.handleOpen(syncWs, "ws-sync", "user-1", "agent-1", { ...LOCATOR, syncOnly: true });
      await gateway.handleOpen(legacyWs, "ws-legacy", "user-1", "agent-1", LOCATOR);
      const chat = docManager.getChat(LOCATOR.rcsSessionId);
      if (!chat) throw new Error("expected chat doc");
      const frame = encodeYjsStateVectorFrame(
        `chat:${LOCATOR.rcsSessionId}`,
        chat.generation,
        Y.encodeStateVector(new Y.Doc()),
      );

      await gateway.handleMessage(syncWs, "ws-sync", frame);
      await gateway.handleMessage(legacyWs, "ws-legacy", frame);

      expect(decodeUpdateFrames(syncWs)).toHaveLength(0);
      expect(decodeUpdateFrames(legacyWs).length).toBeGreaterThan(0);
    } finally {
      gateway.handleClose("ws-legacy");
      gateway.handleClose("ws-sync");
    }
  });

  // 同一会话混用新旧标签页：旧 Doc 增量只发给旧连接，sync-only 不重复接收。
  test("旧 Doc 广播跳过 sync-only 连接", async () => {
    const { gateway, chatDoc } = await createHarness();
    const syncWs = createWs();
    const legacyWs = createWs();
    try {
      await gateway.handleOpen(syncWs, "ws-sync", "user-1", "agent-1", { ...LOCATOR, syncOnly: true });
      await gateway.handleOpen(legacyWs, "ws-legacy", "user-1", "agent-1", LOCATOR);
      const syncBefore = decodeUpdateFrames(syncWs).length;
      const legacyBefore = decodeUpdateFrames(legacyWs).length;

      chatDoc.getMap("root").set("probe", "changed");
      await flushBroadcast();

      expect(decodeUpdateFrames(syncWs)).toHaveLength(syncBefore);
      expect(decodeUpdateFrames(legacyWs).length).toBeGreaterThan(legacyBefore);
    } finally {
      gateway.handleClose("ws-legacy");
      gateway.handleClose("ws-sync");
    }
  });

  // 文本 action 不因退役被阻断：会话动作仍转发到 relay。
  test("sync-only 连接保留文本 action 转发", async () => {
    const { gateway, relaySent } = await createHarness();
    const ws = createWs();
    try {
      await gateway.handleOpen(ws, "ws-sync", "user-1", "agent-1", { ...LOCATOR, syncOnly: true });
      await gateway.handleMessage(ws, "ws-sync", JSON.stringify({ action: "cancel", commandId: "cmd-1" }));
      expect(relaySent.some((message) => message.method === "session/cancel")).toBe(true);
    } finally {
      gateway.handleClose("ws-sync");
    }
  });
});
