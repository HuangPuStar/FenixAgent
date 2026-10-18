// packages/chat-channel/src/__tests__/sync-host-session.test.ts
// 宿主连接接入：每连接一个 runtime、开关关闭旧路径不变、握手/订阅/ACK、认证拒绝、版本不符与回收。

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { YjsBroadcaster } from "../channel/broadcaster";
import { ConnectionRegistry } from "../channel/connection-registry";
import { createGateway, createRelayEvents, createSharedRelay, createWs } from "../channel/connection-test-helpers";
import type { DocManager } from "../state/doc-manager";
import { type Clock, deterministicRandomSource, sha256Digest } from "../sync/clock";
import {
  type ApplyAckFrame,
  decodeSyncFrame,
  encodeSyncFrame,
  type HelloFrame,
  MAX_DATA_FRAME_BYTES,
  type ManifestFrame,
  type SubscribeFrame,
  type SyncFrame,
} from "../sync/protocol/frames";
import type { SyncFrameTransport } from "../sync/runtime/egress";
import { createSyncHostSession, type SyncHostSession } from "../sync/runtime/host-session";

const now = 1_700_000_000_000;
const CLOCK: Clock = { now: () => now };
const SCOPE = { organizationId: "org-1", rcsSessionId: "rcs_1" };
const RUNTIME_CONFIG = { sealGraceMs: 2_000, retireGraceMs: 30_000, tickIntervalMs: 5_000 };
const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sync-host-"));
  tempRoots.push(root);
  return root;
}

function transportOf(): {
  transport: SyncFrameTransport;
  frames: SyncFrame[];
  closeReasons: string[];
} {
  const frames: SyncFrame[] = [];
  const closeReasons: string[] = [];
  return {
    frames,
    closeReasons,
    transport: {
      send(bytes: Uint8Array): boolean {
        frames.push(decodeSyncFrame(bytes));
        return true;
      },
      bufferedAmount: () => 0,
      close(reason: string): void {
        closeReasons.push(reason);
      },
    },
  };
}

async function createHost(): Promise<{
  session: SyncHostSession;
  frames: SyncFrame[];
  closeReasons: string[];
}> {
  const { transport, frames, closeReasons } = transportOf();
  const session = await createSyncHostSession({
    scope: SCOPE,
    runtimeConfig: { ...RUNTIME_CONFIG, spoolRootDir: join(tempRoot(), "spool") },
    transport,
    clock: CLOCK,
    digest: sha256Digest,
    random: deterministicRandomSource("sync-host-session"),
    owner: "test-owner",
  });
  return { session, frames, closeReasons };
}

/** 导入一条稳定历史对象，取得可用于 HELLO 的已提交 generation。 */
async function importOne(session: SyncHostSession): Promise<{ generation: string; contentDocIds: readonly string[] }> {
  return await session.importHistory({
    acpSessionId: "ses_1",
    records: [{ value: { role: "assistant", text: "hello" }, meta: { kind: "history_object", entryId: "entry-1" } }],
  });
}

function helloFrame(generation: string): HelloFrame {
  return {
    type: "HELLO",
    protocolVersion: 1,
    scope: SCOPE,
    generation,
    loadedDocs: [],
    stateful: false,
  };
}

function manifestOf(frames: readonly SyncFrame[]): ManifestFrame {
  const manifest = frames.find((frame): frame is ManifestFrame => frame.type === "MANIFEST");
  if (!manifest) throw new Error("expected MANIFEST after HELLO");
  return manifest;
}

describe("sync host session 生命周期", () => {
  // stateless HELLO 缺 generation 且 scope 由客户端自报时，服务端必须改用认证 scope 并建立空基线。
  test("stateless HELLO 自动建立基线，目录 Doc 可发现内容块", async () => {
    const { session, frames } = await createHost();
    const statelessHello = {
      type: "HELLO",
      protocolVersion: 1,
      scope: { organizationId: "evil-org", rcsSessionId: "evil-session" },
      loadedDocs: [],
      stateful: false,
    };
    await session.onInboundBytes(new TextEncoder().encode(JSON.stringify(statelessHello)));
    const manifest = manifestOf(frames);
    const subscribe: SubscribeFrame = {
      type: "SUBSCRIBE",
      protocolVersion: 1,
      docIds: [manifest.directoryDocId],
      priority: "live",
    };
    await session.onInboundBytes(encodeSyncFrame(subscribe));
    const base = frames.find((frame): frame is Extract<SyncFrame, { type: "DOC_BASE" }> => frame.type === "DOC_BASE");
    if (!base) throw new Error("expected DOC_BASE for directory doc");
    const directory = new Y.Doc();
    Y.applyUpdate(directory, Buffer.from(base.payload, "base64"));
    const ids = directory.getMap("root").get("contentDocIds") as Y.Array<string>;
    expect(ids.toArray()).toHaveLength(1);
    await session.dispose();
  });

  // 导入稳定历史后必须能用返回的 generation 完成 HELLO → MANIFEST 握手。
  test("已认证 scope 导入稳定历史后完成 HELLO → MANIFEST 握手", async () => {
    const { session, frames } = await createHost();
    const { generation } = await importOne(session);
    await session.onInboundBytes(encodeSyncFrame(helloFrame(generation)));
    expect(manifestOf(frames).generation).toBe(generation);
    await session.dispose();
  });

  // 订阅已提交 Doc 后必须收到 DOC_BASE，并以 APPLY_ACK 结清这笔投递。
  test("订阅当前代 Doc 后收到 DOC_BASE，APPLY_ACK 完成传输闭环", async () => {
    const { session, frames } = await createHost();
    const { generation, contentDocIds } = await importOne(session);
    await session.onInboundBytes(encodeSyncFrame(helloFrame(generation)));
    const contentDocId = contentDocIds[0];
    if (!contentDocId) throw new Error("expected a committed content doc after import");
    const subscribe: SubscribeFrame = {
      type: "SUBSCRIBE",
      protocolVersion: 1,
      docIds: [contentDocId],
      priority: "live",
    };
    await session.onInboundBytes(encodeSyncFrame(subscribe));
    const base = frames.find((frame): frame is Extract<SyncFrame, { type: "DOC_BASE" }> => frame.type === "DOC_BASE");
    if (!base) throw new Error("expected DOC_BASE after SUBSCRIBE");
    const ack: ApplyAckFrame = {
      type: "APPLY_ACK",
      protocolVersion: 1,
      transportEpoch: base.transportEpoch,
      deliveryId: base.deliveryId,
      result: "processed",
      docId: base.docId,
      appliedSeq: base.baseSeq,
    };
    await session.onInboundBytes(encodeSyncFrame(ack));
    expect(frames.some((frame) => frame.type === "ERROR")).toBe(false);
    await session.dispose();
  });

  // 版本不符必须回 ERROR 并关闭连接，不能静默降级到旧帧格式。
  test("版本不匹配回 ERROR 并关闭连接，不静默降级", async () => {
    const { session, closeReasons, frames } = await createHost();
    const { generation } = await importOne(session);
    const badVersion = new TextEncoder().encode(JSON.stringify({ ...helloFrame(generation), protocolVersion: 999 }));
    await session.onInboundBytes(badVersion);
    expect(frames.some((frame) => frame.type === "ERROR")).toBe(true);
    expect(closeReasons.length).toBeGreaterThan(0);
    await session.dispose();
  });

  // 服务端认证参数为空时必须拒绝构造，防止客户端自报 scope 获得身份。
  test("scope 为空时拒绝构造，认证值不得由客户端补足", async () => {
    const { transport } = transportOf();
    await expect(
      createSyncHostSession({
        scope: { organizationId: "", rcsSessionId: "rcs_1" },
        runtimeConfig: RUNTIME_CONFIG,
        transport,
      }),
    ).rejects.toThrow();
  });

  // 同 scope 多标签页各自持有独立 store，关闭一个连接不得回收另一个 runtime。
  test("同 scope 的两个连接各自导入、互不共享 store，关闭其一不影响另一个", async () => {
    const first = await createHost();
    const second = await createHost();
    await importOne(first.session);
    await importOne(second.session);
    await first.session.dispose();
    expect(first.session.closed).toBe(true);
    expect(second.session.closed).toBe(false);
    await second.session.dispose();
  });
});

describe("gateway 帧判据", () => {
  // 开关关闭时 `{` 二进制帧必须明确拒绝，不能当成旧 Yjs 帧静默丢弃。
  test("开关关闭时 `{` 开头的二进制帧以明确理由关闭连接", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry, { reportLog: () => {} });
    const gateway = createGateway(registry, broadcaster, createRelayEvents(registry, broadcaster, []), {
      chatSyncProtocol: { enabled: false, sealGraceMs: 2_000, retireGraceMs: 30_000 },
    });
    const ws = createWs();
    await gateway.handleOpen(ws, "ws-1", "user-1", "agent-1", {
      instanceUid: "instance-1",
      rcsSessionId: "rcs-1",
      organizationId: "org-1",
    });
    await gateway.handleMessage(ws, "ws-1", new Uint8Array([0x7b, 0x7d]));
    expect(ws.closed).toContainEqual([1008, "sync protocol disabled"]);
    gateway.handleClose("ws-1");
  });

  // 开关开启时 `{` 帧必须进入新 runtime，而不是落到旧 Yjs 解码分支。
  test("开关开启时 `{` 帧进入新 runtime 而不是旧 Yjs 解码", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry, { reportLog: () => {} });
    const gateway = createGateway(registry, broadcaster, createRelayEvents(registry, broadcaster, []), {
      chatSyncProtocol: { enabled: true, sealGraceMs: 2_000, retireGraceMs: 30_000 },
    });
    const ws = createWs();
    await gateway.handleOpen(ws, "ws-2", "user-1", "agent-1", {
      instanceUid: "instance-1",
      rcsSessionId: "rcs-1",
      organizationId: "org-1",
    });
    await gateway.handleMessage(ws, "ws-2", new TextEncoder().encode("{}"));
    expect(ws.messages.some((message) => message instanceof Uint8Array)).toBe(true);
    expect(ws.closed.some(([code, reason]) => code === 1008 && reason === "sync protocol disabled")).toBe(false);
    gateway.handleClose("ws-2");
  });
});

describe("relay 事件旁路", () => {
  // 协议版本不符必须以 1002 关闭，客户端据此刷新而不是重连风暴。
  test("开关开启时版本不符以 1002 关闭连接", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry, { reportLog: () => {} });
    const gateway = createGateway(registry, broadcaster, createRelayEvents(registry, broadcaster, []), {
      chatSyncProtocol: { enabled: true, sealGraceMs: 2_000, retireGraceMs: 30_000 },
    });
    const ws = createWs();
    await gateway.handleOpen(ws, "ws-v", "user-1", "agent-1", {
      instanceUid: "instance-1",
      rcsSessionId: "rcs-1",
      organizationId: "org-1",
    });
    const hello = { type: "HELLO", protocolVersion: 999, scope: SCOPE, loadedDocs: [], stateful: false };
    await gateway.handleMessage(ws, "ws-v", new TextEncoder().encode(JSON.stringify(hello)));
    expect(ws.closed.some(([code]) => code === 1002)).toBe(true);
    gateway.handleClose("ws-v");
  });

  // 超过数据帧上限的输入必须以 1009 关闭，不能无界解析。
  test("超大新协议帧以 1009 关闭连接", async () => {
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry, { reportLog: () => {} });
    const gateway = createGateway(registry, broadcaster, createRelayEvents(registry, broadcaster, []), {
      chatSyncProtocol: { enabled: true, sealGraceMs: 2_000, retireGraceMs: 30_000 },
    });
    const ws = createWs();
    await gateway.handleOpen(ws, "ws-big", "user-1", "agent-1", {
      instanceUid: "instance-1",
      rcsSessionId: "rcs-1",
    });
    const oversized = new Uint8Array(MAX_DATA_FRAME_BYTES + 1);
    oversized[0] = 0x7b;
    await gateway.handleMessage(ws, "ws-big", oversized);
    expect(ws.closed.some(([code]) => code === 1009)).toBe(true);
    gateway.handleClose("ws-big");
  });

  // ACP 载荷无 turnId 时，只允许使用旧投影 activeTurnId 作为服务端可信绑定。
  test("实时增量缺 turnId 时使用旧投影的 activeTurnId 作为可信绑定", async () => {
    const sessionDoc = new Y.Doc();
    const session = new Y.Map<unknown>();
    session.set("activeTurnId", "turn-live");
    session.set("activeTurnStatus", "streaming");
    sessionDoc.getMap("root").set("session", session);
    const docManager = {
      processNormalizedEvent: () => {},
      getSessionYdoc: () => sessionDoc,
      hasTimelineContent: () => true,
      getProjectionGeneration: () => "gen-1",
    } as unknown as DocManager;
    const registry = new ConnectionRegistry();
    const broadcaster = new YjsBroadcaster(registry, { reportLog: () => {} });
    const seen: Array<{ turnId?: string | null }> = [];
    const relayEvents = createRelayEvents(registry, broadcaster, [], {
      docManager,
      onNormalizedEvent: (_rcsSessionId, event) => seen.push({ turnId: event.turnId }),
    });
    const handler = relayEvents.createMessageHandler(createSharedRelay());
    await handler({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "ses-1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
      },
    } as never);
    expect(seen.at(-1)?.turnId).toBe("turn-live");
  });
});

// 清理临时目录：Bun 没有全局 afterEach 时由每个用例自行 dispose，这里登记进程结束前的兜底。
process.on("beforeExit", () => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});
