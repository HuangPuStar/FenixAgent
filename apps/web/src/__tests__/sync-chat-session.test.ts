// apps/web/src/__tests__/sync-chat-session.test.ts
// 浏览器同步会话（隔离路径）的协议回归：二进制帧、HELLO/MANIFEST/SUBSCRIBE、APPLY_ACK（成功与拒绝）、
// ERROR 显式失败、断连重连不重复消息。帧编解码用协议包的真实实现（相对导入，仅测试使用），
// 断言的是线上字节而不是本层构造的对象。

import { describe, expect, test } from "bun:test";
import { decodeSyncFrame, encodeSyncFrame, SYNC_PROTOCOL_VERSION, type SyncFrame } from "@fenix/chat-channel/server";
import {
  buildDirectoryPageSnapshot,
  buildDirectoryRootSnapshot,
  directoryPageDocId,
  directoryRootDocId,
} from "@fenix/chat-channel/sync-client";
import * as Y from "yjs";
import type { SyncChatProjection } from "../../../../packages/agent-runtime/web/yjs/sync-doc-hub";
import {
  createSyncChatSession,
  type SyncChatConnectionState,
  type SyncChatSessionOptions,
} from "../../../../packages/agent-runtime/web/yjs/sync-transport";
import type { SyncBrowserSocket } from "../../../../packages/agent-runtime/web/yjs/yjs-ws";

const GENERATION = "gen_session0001";
const CONTROL_DOC = `sync/control/${GENERATION}/0/control`;
const RUNTIME_DOC = `sync/runtime/${GENERATION}/0/runtime`;
const DIRECTORY_DOC = directoryRootDocId(GENERATION);
const DIRECTORY_PAGE_1 = directoryPageDocId(GENERATION, 1);
const DIRECTORY_PAGE_2 = directoryPageDocId(GENERATION, 2);
const CONTENT_DOC = `sync/content/${GENERATION}/1/content_a`;
const CONTENT_DOC_2 = `sync/content/${GENERATION}/2/content_b`;
const CONTENT_DOC_3 = `sync/content/${GENERATION}/3/content_c`;
const CONTENT_DOC_4 = `sync/content/${GENERATION}/4/content_d`;
const CONTENT_DOC_5 = `sync/content/${GENERATION}/5/content_e`;
const CONTENT_DOC_6 = `sync/content/${GENERATION}/6/content_f`;
const URL_UNDER_TEST = "ws://test.local/acp/yjs/env_1?chatSync=1";

class FakeSocket implements SyncBrowserSocket {
  static instances: FakeSocket[] = [];

  binaryType = "arraybuffer";
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  readonly closed: Array<{ code?: number; reason?: string }> = [];
  /** 模拟 ACK 写 socket 失败：服务端账本收不到回执，客户端基线等待只能靠超时。 */
  dropAcks = false;
  onopen: (() => void) | null = null;
  onmessage: ((data: unknown) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: Uint8Array): void {
    if (this.dropAcks && decodeSyncFrame(data).type === "APPLY_ACK") {
      throw new Error("simulated ack send failure");
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closed.push({ code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(frame: SyncFrame): void {
    this.onmessage?.(encodeSyncFrame(frame));
  }

  receiveRaw(data: unknown): void {
    this.onmessage?.(data);
  }

  closeFromServer(code: number, reason: string): void {
    this.readyState = 3;
    this.onclose?.(code, reason);
  }
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function contentUpdate(text: string, entryId = "turn_1:assistant"): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    const root = doc.getMap<unknown>("root");
    root.set("schemaVersion", 1);
    root.set("kind", "content");
    root.set("generation", GENERATION);
    root.set("blockIndex", 1);
    const records = new Y.Array<Record<string, unknown>>();
    root.set("records", records);
    records.push([
      {
        recordId: `rec_${entryId}`,
        entryId,
        entryOrder: 1,
        contentSlot: "text",
        partIndex: 0,
        kind: "text",
        payload: new TextEncoder().encode(text),
      },
    ]);
  });
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function manifest(): SyncFrame {
  return {
    type: "MANIFEST",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    generation: GENERATION,
    pointerRevision: 1,
    referenceRevision: 1,
    controlDocId: CONTROL_DOC,
    runtimeDocId: RUNTIME_DOC,
    directoryDocId: DIRECTORY_DOC,
    recoveryState: "ready",
  };
}

function directoryRootBase(deliveryId: string, latestPageId = DIRECTORY_PAGE_1): SyncFrame {
  const payload = buildDirectoryRootSnapshot(latestPageId);
  return {
    type: "DOC_BASE",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    docId: DIRECTORY_DOC,
    generation: GENERATION,
    transportEpoch: "tx_1",
    subscriptionEpoch: "sub_1",
    syncAttemptId: "att_1",
    deliveryId,
    baseSeq: 0,
    mode: "full",
    payloadDigest: "sha256:test",
    encodedLength: payload.byteLength,
    payload: base64(payload),
  };
}

function directoryPageBase(deliveryId: string, docIds: readonly string[]): SyncFrame {
  return docBaseWithPayload(DIRECTORY_PAGE_1, deliveryId, buildDirectoryPageSnapshot(docIds, null));
}

/** 指定页的基线：跨页用例需要显式给出上一页链接。 */
function pageBaseOf(
  pageDocId: string,
  deliveryId: string,
  docIds: readonly string[],
  previousPageId: string | null,
): SyncFrame {
  return docBaseWithPayload(pageDocId, deliveryId, buildDirectoryPageSnapshot(docIds, previousPageId));
}

/** 根目录基线 + 最新页基线：客户端先发现页，再从页里发现内容块。 */
function receiveDirectory(socket: FakeSocket, deliveryId: string, docIds: readonly string[]): void {
  socket.receive(directoryRootBase(`${deliveryId}_root`));
  socket.receive(directoryPageBase(`${deliveryId}_page`, docIds));
}

let appendSequence = 0;

/** 向同一 content Doc 追加一条记录并返回增量（模拟持续 DOC_UPDATE）。 */
function appendContentUpdate(doc: Y.Doc, text: string, entryId = "turn_1:assistant"): Uint8Array {
  const before = Y.encodeStateVector(doc);
  doc.transact(() => {
    const root = doc.getMap<unknown>("root");
    if (!(root.get("records") instanceof Y.Array)) {
      root.set("schemaVersion", 1);
      root.set("kind", "content");
      root.set("generation", GENERATION);
      root.set("blockIndex", 1);
      root.set("records", new Y.Array<Record<string, unknown>>());
    }
    const records = root.get("records") as Y.Array<Record<string, unknown>>;
    records.push([
      {
        recordId: `rec_append_${appendSequence++}`,
        entryId,
        entryOrder: 1,
        contentSlot: "text",
        partIndex: 0,
        kind: "text",
        payload: new TextEncoder().encode(text),
      },
    ]);
  });
  return Y.encodeStateAsUpdate(doc, before);
}

function docBaseWithPayload(docId: string, deliveryId: string, payload: Uint8Array): SyncFrame {
  return {
    type: "DOC_BASE",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    docId,
    generation: GENERATION,
    transportEpoch: "tx_1",
    subscriptionEpoch: "sub_1",
    syncAttemptId: "att_1",
    deliveryId,
    baseSeq: 0,
    mode: "full",
    payloadDigest: "sha256:test",
    encodedLength: payload.byteLength,
    payload: base64(payload),
  };
}

function docBase(docId: string, deliveryId: string, text = "hello"): SyncFrame {
  return docBaseWithPayload(docId, deliveryId, contentUpdate(text));
}

function docUpdate(docId: string, deliveryId: string): SyncFrame {
  const payload = contentUpdate("ignored");
  return {
    type: "DOC_UPDATE",
    protocolVersion: SYNC_PROTOCOL_VERSION,
    docId,
    generation: GENERATION,
    transportEpoch: "tx_1",
    subscriptionEpoch: "sub_1",
    syncAttemptId: "att_1",
    deliveryId,
    fromSeq: 1,
    toSeq: 1,
    payloadDigest: "sha256:test",
    encodedLength: payload.byteLength,
    payload: base64(payload),
  };
}

function sentFrames(socket: FakeSocket): SyncFrame[] {
  return socket.sent.map((bytes) => decodeSyncFrame(bytes));
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

interface Harness {
  readonly session: ReturnType<typeof createSyncChatSession>;
  readonly socket: FakeSocket;
  readonly states: SyncChatConnectionState[];
  readonly projections: SyncChatProjection[];
  readonly scheduled: Array<() => void>;
}

function createHarness(overrides: Partial<SyncChatSessionOptions> = {}): Harness {
  FakeSocket.instances = [];
  const states: SyncChatConnectionState[] = [];
  const projections: SyncChatProjection[] = [];
  const scheduled: Array<() => void> = [];
  const session = createSyncChatSession({
    agentId: "env_1",
    instanceUid: "inst_1",
    rcsSessionId: "rcs_1",
    organizationId: "org_1",
    contentDocIds: [CONTENT_DOC, CONTENT_DOC_2],
    generation: GENERATION,
    url: URL_UNDER_TEST,
    socketFactory: (url) => new FakeSocket(url),
    yieldToHost: async () => {},
    autoReconnect: false,
    schedule: (task) => {
      scheduled.push(task);
      return () => {};
    },
    onState: (state) => states.push(state),
    onProjection: (projection) => projections.push(projection),
    ...overrides,
  });
  session.connect();
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("fake socket was not created");
  return { session, socket, states, projections, scheduled };
}

describe("sync chat 浏览器会话", () => {
  // 正常握手不依赖临时 generation 参数；服务端 MANIFEST 提供代次与入口 Doc。
  test("默认 HELLO 不携带预设 generation", () => {
    const harness = createHarness({ generation: undefined, contentDocIds: [] });
    harness.socket.open();
    expect(sentFrames(harness.socket)[0]).toEqual({
      type: "HELLO",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      scope: { organizationId: "org_1", rcsSessionId: "rcs_1" },
      loadedDocs: [],
      stateful: false,
    } satisfies SyncFrame);
  });

  // 目录基线揭示内容块后才订阅并镜像内容，正常链路不依赖调试用 doc/generation 参数。
  test("MANIFEST → directory contentDocIds → content SUBSCRIBE → 消息投影", async () => {
    const harness = createHarness({ generation: undefined, contentDocIds: [] });
    harness.socket.open();
    harness.socket.receive(manifest());
    expect(sentFrames(harness.socket).filter((frame) => frame.type === "SUBSCRIBE")).toEqual([
      {
        type: "SUBSCRIBE",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        docIds: [CONTROL_DOC, RUNTIME_DOC, DIRECTORY_DOC],
        priority: "live",
      },
    ] satisfies SyncFrame[]);
    receiveDirectory(harness.socket, "dlv_directory_1", [CONTENT_DOC]);
    expect(
      sentFrames(harness.socket)
        .filter((frame) => frame.type === "SUBSCRIBE")
        .at(-1),
    ).toEqual({
      type: "SUBSCRIBE",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      docIds: [CONTENT_DOC],
      priority: "currentHistory",
    } satisfies SyncFrame);
    harness.socket.receive(docBase(CONTENT_DOC, "dlv_content_1", "from directory"));
    await flush();
    expect(harness.projections.at(-1)?.messages).toMatchObject([
      { type: "assistant_message", chunks: [{ type: "message", text: "from directory" }] },
    ]);
  });

  // 目录列出全部历史块时只订阅最近四块；显式“显示更早”才订阅上一批，且完成后入口消失。
  test("目录历史分页：首屏四块，加载更早再订阅上一批", async () => {
    const harness = createHarness({ generation: undefined, contentDocIds: [] });
    harness.socket.open();
    harness.socket.receive(manifest());
    receiveDirectory(harness.socket, "dlv_directory_window", [
      CONTENT_DOC,
      CONTENT_DOC_2,
      CONTENT_DOC_3,
      CONTENT_DOC_4,
      CONTENT_DOC_5,
      CONTENT_DOC_6,
    ]);
    const contentSubscribes = (): string[][] =>
      sentFrames(harness.socket)
        .filter((frame): frame is Extract<SyncFrame, { type: "SUBSCRIBE" }> => frame.type === "SUBSCRIBE")
        .filter((frame) => frame.priority === "currentHistory")
        .map((frame) => [...frame.docIds]);
    expect(contentSubscribes().at(-1)).toEqual([CONTENT_DOC_3, CONTENT_DOC_4, CONTENT_DOC_5, CONTENT_DOC_6]);
    expect(harness.states.at(-1)?.hasEarlierHistory).toBe(true);

    harness.socket.receive(
      docBaseWithPayload(CONTENT_DOC_3, "dlv_content_3", contentUpdate("doc 3", "doc3:assistant")),
    );
    harness.socket.receive(
      docBaseWithPayload(CONTENT_DOC_4, "dlv_content_4", contentUpdate("doc 4", "doc4:assistant")),
    );
    harness.socket.receive(
      docBaseWithPayload(CONTENT_DOC_5, "dlv_content_5", contentUpdate("doc 5", "doc5:assistant")),
    );
    harness.socket.receive(
      docBaseWithPayload(CONTENT_DOC_6, "dlv_content_6", contentUpdate("doc 6", "doc6:assistant")),
    );
    await flush();
    expect(harness.projections.at(-1)?.messages.map((message) => message.id)).toEqual([
      "doc3:assistant",
      "doc4:assistant",
      "doc5:assistant",
      "doc6:assistant",
    ]);

    expect(harness.session.loadEarlierHistory()).toBe(true);
    expect(contentSubscribes().at(-1)).toEqual([CONTENT_DOC, CONTENT_DOC_2]);
    expect(harness.states.at(-1)?.historyLoading).toBe(true);
    harness.socket.receive(docBaseWithPayload(CONTENT_DOC, "dlv_content_1", contentUpdate("doc 1", "doc1:assistant")));
    harness.socket.receive(
      docBaseWithPayload(CONTENT_DOC_2, "dlv_content_2", contentUpdate("doc 2", "doc2:assistant")),
    );
    await flush();
    expect(harness.projections.at(-1)?.messages).toHaveLength(6);
    expect(harness.states.at(-1)?.hasEarlierHistory).toBe(false);
    expect(harness.states.at(-1)?.historyLoading).toBe(false);
  });

  // 跨页加载：根目录只指向最新页；点击“显示更早”先订阅上一页，页基线到达后自动续订该页内容块。
  test("跨页加载：先订阅上一页，页到达后续订更早内容块", async () => {
    const harness = createHarness({ generation: undefined, contentDocIds: [] });
    harness.socket.open();
    harness.socket.receive(manifest());
    harness.socket.receive(directoryRootBase("dlv_cross_root", DIRECTORY_PAGE_2));
    harness.socket.receive(
      pageBaseOf(
        DIRECTORY_PAGE_2,
        "dlv_cross_page_2",
        [CONTENT_DOC_3, CONTENT_DOC_4, CONTENT_DOC_5, CONTENT_DOC_6],
        DIRECTORY_PAGE_1,
      ),
    );

    const subscribes = (): Extract<SyncFrame, { type: "SUBSCRIBE" }>[] =>
      sentFrames(harness.socket).filter(
        (frame): frame is Extract<SyncFrame, { type: "SUBSCRIBE" }> => frame.type === "SUBSCRIBE",
      );
    expect(subscribes().at(-1)).toEqual({
      type: "SUBSCRIBE",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      docIds: [CONTENT_DOC_3, CONTENT_DOC_4, CONTENT_DOC_5, CONTENT_DOC_6],
      priority: "currentHistory",
    } satisfies SyncFrame);
    expect(harness.states.at(-1)?.hasEarlierHistory).toBe(true);

    expect(harness.session.loadEarlierHistory()).toBe(true);
    expect(subscribes().at(-1)).toEqual({
      type: "SUBSCRIBE",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      docIds: [DIRECTORY_PAGE_1],
      priority: "currentHistory",
    } satisfies SyncFrame);
    expect(harness.states.at(-1)?.historyLoading).toBe(true);

    harness.socket.receive(pageBaseOf(DIRECTORY_PAGE_1, "dlv_cross_page_1", [CONTENT_DOC, CONTENT_DOC_2], null));
    expect(subscribes().at(-1)).toEqual({
      type: "SUBSCRIBE",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      docIds: [CONTENT_DOC, CONTENT_DOC_2],
      priority: "currentHistory",
    } satisfies SyncFrame);
    expect(harness.states.at(-1)?.historyLoading).toBe(true);

    harness.socket.receive(
      docBaseWithPayload(CONTENT_DOC, "dlv_cross_content_1", contentUpdate("doc 1", "cross:doc1")),
    );
    harness.socket.receive(
      docBaseWithPayload(CONTENT_DOC_2, "dlv_cross_content_2", contentUpdate("doc 2", "cross:doc2")),
    );
    await flush();
    expect(harness.states.at(-1)?.hasEarlierHistory).toBe(false);
    expect(harness.states.at(-1)?.historyLoading).toBe(false);
    expect(harness.projections.at(-1)?.messages.map((message) => message.id)).toEqual(["cross:doc1", "cross:doc2"]);
  });

  // 24 块历史反复向前/向后翻页：中间缺口可加载、所有块按目录顺序可达，回到最新只恢复最新窗口。
  test("20+ 块双向翻页：缺口可加载、按序可达，回到最新有界恢复", async () => {
    const entries = Array.from({ length: 24 }, (_, index) => {
      const number = index + 1;
      return {
        docId: `sync/content/${GENERATION}/${number}/doc_${number}`,
        entryId: `history:${String(number).padStart(2, "0")}`,
      };
    });
    const harness = createHarness({ generation: undefined, contentDocIds: [] });
    harness.socket.open();
    harness.socket.receive(manifest());
    receiveDirectory(
      harness.socket,
      "dlv_bidirectional_directory",
      entries.map((entry) => entry.docId),
    );

    const contentSubscribes = (): string[][] =>
      sentFrames(harness.socket)
        .filter((frame): frame is Extract<SyncFrame, { type: "SUBSCRIBE" }> => frame.type === "SUBSCRIBE")
        .filter((frame) => frame.priority === "currentHistory")
        .map((frame) => [...frame.docIds]);
    const feedLatestBatch = (label: string): void => {
      for (const docId of contentSubscribes().at(-1) ?? []) {
        const entry = entries.find((item) => item.docId === docId);
        if (entry === undefined) continue;
        harness.socket.receive(
          docBaseWithPayload(docId, `dlv_${label}_${entry.entryId}`, contentUpdate(entry.entryId, entry.entryId)),
        );
      }
    };

    expect(contentSubscribes().at(-1)).toEqual(entries.slice(20).map((entry) => entry.docId));
    feedLatestBatch("initial");
    await flush();

    const reached = new Set<string>();
    const seen: string[] = [];
    const collectVisible = (): void => {
      for (const batch of contentSubscribes()) {
        for (const docId of batch) {
          const entry = entries.find((item) => item.docId === docId);
          if (entry !== undefined) reached.add(entry.entryId);
        }
      }
      const messages = harness.projections.at(-1)?.messages ?? [];
      for (const message of messages) {
        if (message.id.startsWith("history:") && !seen.includes(message.id)) seen.push(message.id);
      }
      expect([...messages].map((message) => message.id)).toEqual(
        [...messages].map((message) => message.id).sort((left, right) => left.localeCompare(right)),
      );
    };
    collectVisible();

    for (let page = 0; page < 5; page += 1) {
      expect(harness.session.loadEarlierHistory()).toBe(true);
      feedLatestBatch(`earlier_${page}`);
      await flush();
      collectVisible();
    }
    expect(harness.states.at(-1)?.hasLaterHistory).toBe(true);
    expect(harness.states.at(-1)?.hasEarlierHistory).toBe(false);

    for (let page = 0; page < 3; page += 1) {
      expect(harness.session.loadLaterHistory()).toBe(true);
      feedLatestBatch(`later_${page}`);
      await flush();
      collectVisible();
    }
    expect(harness.states.at(-1)?.hasLaterHistory).toBe(false);
    expect(seen).toHaveLength(24);
    expect(reached.size).toBe(24);

    const latestReady = harness.session.returnToLatestHistory();
    // 最新窗口已全部驻留且已有基线：不能再发重复订阅，也不能让“回到最新”等待超时。
    expect(harness.states.at(-1)?.hasLaterHistory).toBe(false);
    expect(await latestReady).toBe(true);
    await flush();
    expect(harness.states.at(-1)?.historyLoading).toBe(false);
    expect(harness.projections.at(-1)?.messages.map((message) => message.id)).toEqual([
      "history:21",
      "history:22",
      "history:23",
      "history:24",
    ]);
  });

  // 开启后第一条出站帧必须是二进制 HELLO，携带协议版本、scope 与 stateful:false。
  test("建连后发送二进制 HELLO", () => {
    const harness = createHarness();
    harness.socket.open();
    expect(harness.socket.url).toBe(URL_UNDER_TEST);
    const first = harness.socket.sent[0];
    expect(first).toBeInstanceOf(Uint8Array);
    expect(first?.[0]).toBe(0x7b);
    expect(sentFrames(harness.socket)[0]).toEqual({
      type: "HELLO",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      scope: { organizationId: "org_1", rcsSessionId: "rcs_1" },
      generation: GENERATION,
      loadedDocs: [],
      stateful: false,
    } satisfies SyncFrame);
  });

  // MANIFEST 先 retain 再订阅：入口 Doc 用 live，内容 Doc 用 currentHistory；状态进入 ready。
  test("MANIFEST 触发 SUBSCRIBE 并进入 ready", () => {
    const harness = createHarness();
    harness.socket.open();
    harness.socket.receive(manifest());
    const subscribes = sentFrames(harness.socket).filter((frame) => frame.type === "SUBSCRIBE");
    expect(subscribes).toEqual([
      {
        type: "SUBSCRIBE",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        docIds: [CONTROL_DOC, RUNTIME_DOC, DIRECTORY_DOC],
        priority: "live",
      },
      {
        type: "SUBSCRIBE",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        docIds: [CONTENT_DOC, CONTENT_DOC_2],
        priority: "currentHistory",
      },
    ] satisfies SyncFrame[]);
    expect(harness.states.at(-1)?.status).toBe("ready");
  });

  // MANIFEST 后展示层先收起半成品：入口/目录/内容块 DOC_BASE 的 processed APPLY_ACK 全部到齐才解除。
  test("基线 DOC_BASE 与 APPLY_ACK 齐备前保持 hydrating", async () => {
    const harness = createHarness({ generation: undefined, contentDocIds: [] });
    harness.socket.open();
    harness.socket.receive(manifest());
    expect(harness.states.at(-1)?.hydrating).toBe(true);

    receiveDirectory(harness.socket, "dlv_hydrate_dir", [CONTENT_DOC]);
    expect(harness.states.at(-1)?.hydrating).toBe(true);
    harness.socket.receive(docBase(CONTROL_DOC, "dlv_hydrate_control"));
    expect(harness.states.at(-1)?.hydrating).toBe(true);
    harness.socket.receive(docBase(RUNTIME_DOC, "dlv_hydrate_runtime"));
    expect(harness.states.at(-1)?.hydrating).toBe(true);
    harness.socket.receive(docBase(CONTENT_DOC, "dlv_hydrate_content"));
    // 帧已到达但 ACK 尚未写出：不能提前放行。
    expect(harness.states.at(-1)?.hydrating).toBe(true);
    await flush();
    expect(harness.states.at(-1)?.hydrating).toBe(false);
  });

  // ACK 丢失时只能靠 base 超时解除 hydrate；投影仍已应用，后续增量正常追加且不重复。
  test("ACK 丢失降级为增量追加，不重复不丢失", async () => {
    const harness = createHarness({ generation: undefined, contentDocIds: [], syncBaseTimeoutMs: 20 });
    harness.socket.open();
    harness.socket.dropAcks = true;
    harness.socket.receive(manifest());
    receiveDirectory(harness.socket, "dlv_ackloss_dir", [CONTENT_DOC]);

    const contentDoc = new Y.Doc();
    const basePayload = appendContentUpdate(contentDoc, "hello");
    const updatePayload = appendContentUpdate(contentDoc, " world");
    harness.socket.receive(docBaseWithPayload(CONTENT_DOC, "dlv_ackloss_base", basePayload));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(harness.states.at(-1)?.hydrating).toBe(false);
    expect(harness.projections.at(-1)?.messages).toHaveLength(1);

    harness.socket.receive({
      type: "DOC_UPDATE",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      docId: CONTENT_DOC,
      generation: GENERATION,
      transportEpoch: "tx_1",
      subscriptionEpoch: "sub_1",
      syncAttemptId: "att_1",
      deliveryId: "dlv_ackloss_update",
      fromSeq: 1,
      toSeq: 1,
      payloadDigest: "sha256:test",
      encodedLength: updatePayload.byteLength,
      payload: base64(updatePayload),
    } satisfies SyncFrame);
    await flush();
    const messages = harness.projections.at(-1)?.messages ?? [];
    expect(messages).toHaveLength(1);
    const message = messages[0];
    const text =
      message?.type === "assistant_message"
        ? message.chunks
            .filter((chunk) => chunk.type === "message")
            .map((chunk) => chunk.text)
            .join("")
        : "";
    expect(text).toBe("hello world");
  });

  // DOC_BASE 应用成功后必须回 processed APPLY_ACK，同时把正文投影成只读消息。
  test("DOC_BASE 回 processed ACK 并更新投影", async () => {
    const harness = createHarness();
    harness.socket.open();
    harness.socket.receive(manifest());
    harness.socket.receive(docBase(CONTENT_DOC, "dlv_base_1"));
    await flush();

    const acks = sentFrames(harness.socket).filter((frame) => frame.type === "APPLY_ACK");
    expect(acks).toEqual([
      {
        type: "APPLY_ACK",
        protocolVersion: SYNC_PROTOCOL_VERSION,
        transportEpoch: "tx_1",
        deliveryId: "dlv_base_1",
        result: "processed",
        docId: CONTENT_DOC,
      },
    ] satisfies SyncFrame[]);
    expect(harness.projections.at(-1)?.messages).toEqual([
      {
        type: "assistant_message",
        id: "turn_1:assistant",
        chunks: [{ type: "message", text: "hello" }],
        seq: 0,
        ts: 0,
      },
    ]);
  });

  // 拒绝同样要回 APPLY_ACK（rejected），不得静默丢弃服务端账本。
  test("基线未到的 DOC_UPDATE 回 rejected ACK", async () => {
    const harness = createHarness();
    harness.socket.open();
    harness.socket.receive(manifest());
    harness.socket.receive(docUpdate(CONTENT_DOC, "dlv_reject_1"));
    await flush();

    const acks = sentFrames(harness.socket).filter((frame) => frame.type === "APPLY_ACK");
    expect(acks).toContainEqual({
      type: "APPLY_ACK",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      transportEpoch: "tx_1",
      deliveryId: "dlv_reject_1",
      result: "rejected",
      docId: CONTENT_DOC,
    } satisfies SyncFrame);
  });

  // 同一 deliveryId 重复到达只镜像一次；幂等重放不会让消息树翻倍。
  test("重复 delivery 不重复投影", async () => {
    const harness = createHarness();
    harness.socket.open();
    harness.socket.receive(manifest());
    const base = docBase(CONTENT_DOC, "dlv_dup_1");
    harness.socket.receive(base);
    harness.socket.receive(base);
    await flush();
    expect(harness.projections.at(-1)?.messages).toHaveLength(1);
  });

  // ERROR 是终态显式失败：状态为 error、关闭连接且不安排重连，不得降级回旧协议。
  test("ERROR 帧显式失败且不重连", () => {
    const scheduled: Array<() => void> = [];
    const harness = createHarness({
      autoReconnect: true,
      schedule: (task) => {
        scheduled.push(task);
        return () => {};
      },
    });
    harness.socket.open();
    harness.socket.receive({
      type: "ERROR",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      code: "PROTOCOL_VERSION_UNSUPPORTED",
      retryable: false,
      message: "unsupported version",
    });
    expect(harness.states.at(-1)).toMatchObject({
      status: "error",
      error: { code: "PROTOCOL_VERSION_UNSUPPORTED", message: "unsupported version" },
    });
    expect(harness.socket.closed.at(-1)?.code).toBe(1002);
    expect(scheduled).toHaveLength(0);
  });

  // 服务端以 1008 明确拒绝新协议（开关未开/不可用）时不再重连，避免把显式拒绝刷成重连风暴。
  test("服务端 1008 关闭显式失败且不重连", () => {
    const scheduled: Array<() => void> = [];
    const harness = createHarness({
      autoReconnect: true,
      schedule: (task) => {
        scheduled.push(task);
        return () => {};
      },
    });
    harness.socket.open();
    harness.socket.closeFromServer(1008, "sync protocol disabled");
    expect(harness.states.at(-1)).toMatchObject({
      status: "error",
      error: { code: "WS_1008", message: "sync protocol disabled [wasClean=false, local=false]" },
    });
    expect(scheduled).toHaveLength(0);
  });

  // 旧通道的 yjs:sync-request 与 keep_alive 等文本控制帧与新协议共用 endpoint，必须忽略而不是打成 MALFORMED_FRAME。
  test("旧通道文本控制帧被忽略", () => {
    const harness = createHarness();
    harness.socket.open();
    harness.socket.receiveRaw(
      '{"type":"yjs:sync-request","docs":[{"docName":"chat:rcs_1","generation":"gen_session0001"},{"docName":"session:rcs_1","generation":"gen_session0001"}]}',
    );
    expect(harness.states.at(-1)?.status).not.toBe("error");
    expect(harness.socket.closed).toHaveLength(0);
    harness.socket.receive(manifest());
    expect(harness.states.at(-1)?.status).toBe("ready");
  });

  // 旧 Yjs 二进制 update（首字节 0x01）同样共用 endpoint；新协议旁路必须忽略，不能交给 JSON 解码器。
  test("旧通道二进制帧被忽略", () => {
    const harness = createHarness();
    harness.socket.open();
    harness.socket.receiveRaw(new Uint8Array([0x01, 0x00, 0x03, 0x61, 0x62, 0x63]));
    expect(harness.states.at(-1)?.status).not.toBe("error");
    harness.socket.receive(manifest());
    expect(harness.states.at(-1)?.status).toBe("ready");
  });

  // `{` 开头但 JSON 非法仍是新协议损坏：必须显式失败，不能被“忽略旧帧”掩盖。
  test("畸形的新协议 JSON 帧显式失败", () => {
    const harness = createHarness();
    harness.socket.open();
    harness.socket.receiveRaw(new TextEncoder().encode('{"type":'));
    expect(harness.states.at(-1)?.status).toBe("error");
    expect(harness.states.at(-1)?.error?.code).toBe("MALFORMED_FRAME");
  });

  // 连接级 runtime/store 不跨连接：重连必须发 stateless HELLO，不能复用上一代 MANIFEST generation。
  test("重连 HELLO 不带上一代 generation", () => {
    const scheduled: Array<() => void> = [];
    const harness = createHarness({
      generation: undefined,
      autoReconnect: true,
      schedule: (task) => {
        scheduled.push(task);
        return () => {};
      },
    });
    harness.socket.open();
    harness.socket.receive(manifest());
    expect(harness.states.at(-1)?.generation).toBe(GENERATION);

    harness.socket.closeFromServer(1006, "network");
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    const second = FakeSocket.instances[1];
    second?.open();
    const hello = sentFrames(second as FakeSocket).find((frame) => frame.type === "HELLO");
    expect(hello).toBeDefined();
    expect(hello && "generation" in hello).toBe(false);
  });

  // 断连后重建 transport/镜像；新连接重新握手并应用新基线，消息数仍为 1（不重复 apply）。
  test("断连重连后重新握手且不重复消息", async () => {
    const scheduled: Array<() => void> = [];
    const harness = createHarness({
      autoReconnect: true,
      schedule: (task) => {
        scheduled.push(task);
        return () => {};
      },
    });
    harness.socket.open();
    harness.socket.receive(manifest());
    harness.socket.receive(docBase(CONTENT_DOC, "dlv_first_1"));
    await flush();
    expect(harness.projections.at(-1)?.messages).toHaveLength(1);

    harness.socket.closeFromServer(1006, "network");
    expect(harness.states.at(-1)?.status).toBe("reconnecting");
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();

    const second = FakeSocket.instances[1];
    expect(second).toBeDefined();
    second?.open();
    expect(sentFrames(second as FakeSocket)[0]).toMatchObject({
      type: "HELLO",
      protocolVersion: SYNC_PROTOCOL_VERSION,
    });

    second?.receive(manifest());
    second?.receive(docBase(CONTENT_DOC, "dlv_second_1"));
    await flush();
    expect(harness.projections.at(-1)?.messages).toHaveLength(1);
  });
});
