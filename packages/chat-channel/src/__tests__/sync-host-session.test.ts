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
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { type Clock, deterministicRandomSource, sha256Digest } from "../sync/clock";
import { readDirectoryPage, readDirectoryRoot } from "../sync/protocol/directory";
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
import type { SyncRuntimeConfigOverrides } from "../sync/runtime/config";
import type { SyncFrameTransport } from "../sync/runtime/egress";
import { createSyncHostSession, type SyncHistorySource, type SyncHostSession } from "../sync/runtime/host-session";
import { SyncStoreRegistry } from "../sync/runtime/store-registry";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { ProjectionStore } from "../sync/store/types";

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

type HostOverrides = Omit<SyncRuntimeConfigOverrides, "lifecycle" | "spoolRootDir">;

interface HostOptions {
  readonly storeRegistry?: SyncStoreRegistry;
  readonly store?: ProjectionStore;
  readonly historySource?: SyncHistorySource;
  readonly onError?: (message: string, error: unknown) => void;
  readonly randomSeed?: string;
}

async function createHost(
  overrides: HostOverrides = {},
  options: HostOptions = {},
): Promise<{
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
    random: deterministicRandomSource(options.randomSeed ?? "sync-host-session"),
    owner: "test-owner",
    overrides,
    storeRegistry: options.storeRegistry,
    store: options.store,
    historySource: options.historySource,
    onError: options.onError,
  });
  return { session, frames, closeReasons };
}

/** 入口投递是 fire-and-forget；测试用轮询等待异步失败落定，避免依赖单个微任务/定时器时序。 */
async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** 导入一条稳定历史对象，取得可用于 HELLO 的已提交 generation。 */
async function importOne(session: SyncHostSession): Promise<{ generation: string; contentDocIds: readonly string[] }> {
  return await session.importHistory({
    acpSessionId: "ses_1",
    records: [{ value: { role: "assistant", text: "hello" }, meta: { kind: "history_object", entryId: "entry-1" } }],
  });
}

/** stateless HELLO：不带 generation，由服务端按认证 scope 建立/恢复当前代次。 */
async function sendStatelessHello(session: SyncHostSession): Promise<void> {
  await session.onInboundBytes(
    new TextEncoder().encode(
      JSON.stringify({ type: "HELLO", protocolVersion: 1, scope: SCOPE, loadedDocs: [], stateful: false }),
    ),
  );
}

/** 一条可计数的稳定历史源；`text_part` 是历史记录的真实保真形态（字符串值）。 */
function historySourceOf(text: string): SyncHistorySource & { readonly reads: number } {
  let reads = 0;
  return {
    acpSessionId: "ses_legacy",
    get reads() {
      return reads;
    },
    async read() {
      reads += 1;
      return [{ value: text, meta: { kind: "text_part", entryId: "turn-1:assistant", contentSlot: 0, partIndex: 0 } }];
    },
  };
}

function createMemoryStore(): MemoryProjectionStore {
  return new MemoryProjectionStore({
    clock: CLOCK,
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: { sealGraceMs: RUNTIME_CONFIG.sealGraceMs, retireGraceMs: RUNTIME_CONFIG.retireGraceMs },
  });
}

/** 反复 tick 直到帧出现：provider 只在 tick 时推进游标，异步写入需要给运行时留出落定时间。 */
async function tickUntil(session: SyncHostSession, predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await session.tick();
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function baseFrame(frames: readonly SyncFrame[], docId: string): Extract<SyncFrame, { type: "DOC_BASE" }> | undefined {
  return frames.find(
    (frame): frame is Extract<SyncFrame, { type: "DOC_BASE" }> => frame.type === "DOC_BASE" && frame.docId === docId,
  );
}

function ackOf(frame: Extract<SyncFrame, { type: "DOC_BASE" | "DOC_UPDATE" }>): ApplyAckFrame {
  return {
    type: "APPLY_ACK",
    protocolVersion: 1,
    transportEpoch: frame.transportEpoch,
    deliveryId: frame.deliveryId,
    result: "processed",
    docId: frame.docId,
    appliedSeq: frame.type === "DOC_BASE" ? frame.baseSeq : frame.toSeq,
  };
}

/** 经目录根 → 最新页发现当前代次的全部内容块，并结清两次 DOC_BASE。 */
async function discoverContentDocIds(
  session: SyncHostSession,
  frames: SyncFrame[],
  manifest: ManifestFrame,
): Promise<readonly string[]> {
  await session.onInboundBytes(
    encodeSyncFrame({ type: "SUBSCRIBE", protocolVersion: 1, docIds: [manifest.directoryDocId], priority: "live" }),
  );
  await tickUntil(session, () => baseFrame(frames, manifest.directoryDocId) !== undefined, "directory DOC_BASE");
  const directoryBase = baseFrame(frames, manifest.directoryDocId)!;
  const directory = new Y.Doc();
  Y.applyUpdate(directory, Buffer.from(directoryBase.payload, "base64"));
  const { latestPageId } = readDirectoryRoot(directory);
  directory.destroy();
  if (!latestPageId) throw new Error("expected latestPageId in directory root");

  await session.onInboundBytes(
    encodeSyncFrame({ type: "SUBSCRIBE", protocolVersion: 1, docIds: [latestPageId], priority: "live" }),
  );
  await tickUntil(session, () => baseFrame(frames, latestPageId) !== undefined, "directory page DOC_BASE");
  const pageBase = baseFrame(frames, latestPageId)!;
  const page = new Y.Doc();
  Y.applyUpdate(page, Buffer.from(pageBase.payload, "base64"));
  const contentDocIds = readDirectoryPage(page).contentDocIds;
  page.destroy();

  await session.onInboundBytes(encodeSyncFrame(ackOf(directoryBase)));
  await session.onInboundBytes(encodeSyncFrame(ackOf(pageBase)));
  return contentDocIds;
}

/** 从共享 store 读取目录页的当前内容块列表（含 leader 运行期追加的 active 尾块）。 */
async function readPageContentIdsFromStore(
  store: MemoryProjectionStore,
  pageDocId: string,
): Promise<readonly string[]> {
  const base = await store.readDocStateAt(pageDocId, 0);
  if (base === null) throw new Error("expected committed directory page base");
  const page = new Y.Doc();
  Y.applyUpdate(page, base.snapshot);
  let lastSeq = 0;
  for (;;) {
    const updates = await store.readUpdatesAfter(pageDocId, lastSeq, 256);
    if (updates.length === 0) break;
    for (const update of updates) {
      Y.applyUpdate(page, update.bytes);
      lastSeq = update.updateSeq;
    }
  }
  const contentDocIds = readDirectoryPage(page).contentDocIds;
  page.destroy();
  return contentDocIds;
}

/** 按已投递帧重建某个 Doc 的正文记录（DOC_BASE 可能已折叠 tail，故必须看实际载荷而非帧类型）。 */
function textsOfDoc(frames: readonly SyncFrame[], docId: string): readonly string[] {
  const doc = new Y.Doc();
  for (const frame of frames) {
    if ((frame.type === "DOC_BASE" || frame.type === "DOC_UPDATE") && frame.docId === docId) {
      Y.applyUpdate(doc, Buffer.from(frame.payload, "base64"));
    }
  }
  const records = doc.getMap<unknown>("root").get("records");
  const texts =
    records instanceof Y.Array
      ? records.toArray().map((value) => new TextDecoder().decode((value as { payload: Uint8Array }).payload))
      : [];
  doc.destroy();
  return texts;
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
    const { latestPageId } = readDirectoryRoot(directory);
    directory.destroy();
    if (!latestPageId) throw new Error("expected latestPageId in baseline directory root");

    const pageSubscribe: SubscribeFrame = {
      type: "SUBSCRIBE",
      protocolVersion: 1,
      docIds: [latestPageId],
      priority: "live",
    };
    await session.onInboundBytes(encodeSyncFrame(pageSubscribe));
    const pageBase = frames.find(
      (frame): frame is Extract<SyncFrame, { type: "DOC_BASE" }> =>
        frame.type === "DOC_BASE" && frame.docId === latestPageId,
    );
    if (!pageBase) throw new Error("expected DOC_BASE for directory page");
    const page = new Y.Doc();
    Y.applyUpdate(page, Buffer.from(pageBase.payload, "base64"));
    expect(readDirectoryPage(page).contentDocIds).toHaveLength(1);
    page.destroy();
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

  // 未注入共享注册表时保持连接隔离：这是直接使用宿主会话（单连接/测试）的契约。
  test("未注入共享注册表时两个连接各自持有 store，关闭其一不影响另一个", async () => {
    const first = await createHost();
    const second = await createHost();
    await importOne(first.session);
    await importOne(second.session);
    await first.session.dispose();
    expect(first.session.closed).toBe(true);
    expect(second.session.closed).toBe(false);
    await second.session.dispose();
  });

  // 同 scope 多标签页共享 store 与一次性历史引导：同一 generation，follower 从共享已提交边界追赶。
  test("同 scope 多连接共享 store 与已提交代次，follower 从共享边界追赶", async () => {
    const registry = new SyncStoreRegistry();
    const sharedStore = createMemoryStore();
    const source = historySourceOf("legacy hello");
    const errors: string[] = [];
    const first = await createHost(
      {},
      {
        store: sharedStore,
        storeRegistry: registry,
        historySource: source,
        onError: (message) => errors.push(message),
        randomSeed: "tabs-leader",
      },
    );
    const second = await createHost(
      {},
      {
        store: sharedStore,
        storeRegistry: registry,
        historySource: source,
        onError: (message) => errors.push(message),
        randomSeed: "tabs-follower",
      },
    );
    await sendStatelessHello(first.session);
    await sendStatelessHello(second.session);
    const firstManifest = manifestOf(first.frames);
    const secondManifest = manifestOf(second.frames);
    expect(secondManifest.generation).toBe(firstManifest.generation);
    expect(secondManifest.directoryDocId).toBe(firstManifest.directoryDocId);
    // 历史引导每个共享 store 只执行一次，第二个标签页不得重复导入。
    expect(source.reads).toBe(1);

    const [contentDocId] = await discoverContentDocIds(first.session, first.frames, firstManifest);
    if (!contentDocId) throw new Error("expected content doc after history import");

    await first.session.onInboundBytes(
      encodeSyncFrame({ type: "SUBSCRIBE", protocolVersion: 1, docIds: [contentDocId], priority: "live" }),
    );
    await tickUntil(
      first.session,
      () => baseFrame(first.frames, contentDocId) !== undefined,
      "leader content DOC_BASE",
    );
    await first.session.onInboundBytes(encodeSyncFrame(ackOf(baseFrame(first.frames, contentDocId)!)));
    await second.session.onInboundBytes(
      encodeSyncFrame({ type: "SUBSCRIBE", protocolVersion: 1, docIds: [contentDocId], priority: "live" }),
    );
    await tickUntil(
      second.session,
      () => baseFrame(second.frames, contentDocId) !== undefined,
      "follower content DOC_BASE",
    );
    await second.session.onInboundBytes(encodeSyncFrame(ackOf(baseFrame(second.frames, contentDocId)!)));

    // 历史块全部已封口：leader 首次实时写入会新建 active 尾块并追加到目录页。
    const directoryBase = baseFrame(first.frames, firstManifest.directoryDocId);
    if (!directoryBase) throw new Error("expected directory DOC_BASE after discovery");
    const directory = new Y.Doc();
    Y.applyUpdate(directory, Buffer.from(directoryBase.payload, "base64"));
    const { latestPageId } = readDirectoryRoot(directory);
    directory.destroy();
    if (!latestPageId) throw new Error("expected latest directory page");

    // leader 真实写入后，follower 仅靠 tick 从共享 store 追赶同一条已提交更新。
    first.session.acceptUserMessage("turn-leader", "leader text");
    let liveContentDocId: string | undefined;
    for (let attempt = 0; attempt < 200 && liveContentDocId === undefined; attempt += 1) {
      const tail = (await readPageContentIdsFromStore(sharedStore, latestPageId)).at(-1);
      if (tail !== undefined && tail !== contentDocId) liveContentDocId = tail;
      else await new Promise((resolve) => setTimeout(resolve, 1));
    }
    if (liveContentDocId === undefined) throw new Error("timed out waiting for live content tail");

    // 两个标签页订阅同一个 active 尾块：leader 自己的写入与 follower 的追赶都必须落到它的已提交字节。
    for (const host of [first, second]) {
      const { session, frames } = host;
      await session.onInboundBytes(
        encodeSyncFrame({ type: "SUBSCRIBE", protocolVersion: 1, docIds: [liveContentDocId], priority: "live" }),
      );
      await tickUntil(session, () => baseFrame(frames, liveContentDocId) !== undefined, "live content DOC_BASE");
      await session.onInboundBytes(encodeSyncFrame(ackOf(baseFrame(frames, liveContentDocId)!)));
      // DOC_BASE 会把已提交 tail 折叠进基线，因此只断言「正文到达」而不绑定具体帧类型。
      await tickUntil(
        session,
        () => textsOfDoc(frames, liveContentDocId).includes("leader text"),
        "live content committed",
      );
      expect(textsOfDoc(frames, liveContentDocId)).toEqual(["leader text"]);
    }

    // follower 的实时入口按 SCOPE_BUSY 降级：不停止投影、不产生错误日志，订阅与追赶保持可用。
    second.session.acceptUserMessage("turn-follower", "dropped");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second.session.ingressDiagnostics()).toEqual({ total: 0, lastCode: null, stopped: false });
    expect(errors).toEqual([]);
    await first.session.dispose();
    await second.session.dispose();
  });

  // 断线重连：最后一个连接释放后注册表丢弃内存 store，重连必须重新从稳定源导入并完成握手。
  test("断线重连后重新导入真实历史，不依赖旧连接内存", async () => {
    const registry = new SyncStoreRegistry();
    const source = historySourceOf("reconnect hello");
    const first = await createHost(
      {},
      { storeRegistry: registry, historySource: source, randomSeed: "reconnect-first" },
    );
    await sendStatelessHello(first.session);
    const firstGeneration = manifestOf(first.frames).generation;
    await first.session.dispose();
    expect(registry.size).toBe(0);

    const second = await createHost(
      {},
      { storeRegistry: registry, historySource: source, randomSeed: "reconnect-second" },
    );
    await sendStatelessHello(second.session);
    expect(manifestOf(second.frames).generation).not.toBe(firstGeneration);
    expect(source.reads).toBe(2);
    await second.session.dispose();
  });

  // 重启恢复：从已提交快照恢复的导入代次不得再次读取历史源，generation 与内容块逐项复用。
  test("从已提交快照重启后复用同一代次，不重复导入", async () => {
    const firstStore = createMemoryStore();
    const source = historySourceOf("persisted hello");
    const first = await createHost(
      {},
      {
        store: firstStore,
        storeRegistry: new SyncStoreRegistry(),
        historySource: source,
        randomSeed: "restart-first",
      },
    );
    await sendStatelessHello(first.session);
    const firstManifest = manifestOf(first.frames);
    const firstContentIds = await discoverContentDocIds(first.session, first.frames, firstManifest);
    await first.session.dispose();
    const snapshot = firstStore.exportCommittedState();

    const restoredStore = createMemoryStore();
    restoredStore.restoreFromCommittedState(snapshot);
    let restoredReads = 0;
    const restoredSource: SyncHistorySource = {
      acpSessionId: "ses_legacy",
      async read() {
        restoredReads += 1;
        throw new Error("restored committed state must not re-read history");
      },
    };
    const second = await createHost(
      {},
      {
        store: restoredStore,
        storeRegistry: new SyncStoreRegistry(),
        historySource: restoredSource,
        randomSeed: "restart-second",
      },
    );
    await sendStatelessHello(second.session);
    const secondManifest = manifestOf(second.frames);
    expect(secondManifest.generation).toBe(firstManifest.generation);
    expect(secondManifest.directoryDocId).toBe(firstManifest.directoryDocId);
    expect(restoredReads).toBe(0);
    const secondContentIds = await discoverContentDocIds(second.session, second.frames, secondManifest);
    expect(secondContentIds).toEqual(firstContentIds);
    await second.session.dispose();
  });

  // 恢复失败：不把失败伪装成已导入，回退空基线并记录错误；失败不缓存，下一条连接重试成功。
  test("历史源失败时回退空基线，错误被记录且下一次连接重试成功", async () => {
    const registry = new SyncStoreRegistry();
    const errors: string[] = [];
    const failing: SyncHistorySource = {
      acpSessionId: "ses_legacy",
      async read() {
        throw new Error("history unavailable");
      },
    };
    const first = await createHost(
      {},
      {
        storeRegistry: registry,
        historySource: failing,
        onError: (message) => errors.push(message),
        randomSeed: "failure-first",
      },
    );
    await sendStatelessHello(first.session);
    const baseline = manifestOf(first.frames);
    expect(baseline.generation).toBeString();
    expect(errors.some((message) => message.includes("history bootstrap failed"))).toBe(true);

    const source = historySourceOf("recovered hello");
    const second = await createHost(
      {},
      { storeRegistry: registry, historySource: source, randomSeed: "failure-second" },
    );
    await sendStatelessHello(second.session);
    const recovered = manifestOf(second.frames);
    expect(recovered.generation).not.toBe(baseline.generation);
    expect(source.reads).toBe(1);
    await first.session.dispose();
    await second.session.dispose();
  });

  // 入口容量饱和是显式终态：只报告一次并停止新投影；后续事件直接丢弃，不再进入 runtime 触发更多失败。
  test("入口容量饱和后 stopped=true，后续事件不再进入 runtime", async () => {
    // 字节预算设为 1：任何真实事件都超出预算，用最小配置复现入口饱和。
    const tinyLiveBudget = {
      ...DEFAULT_SYNC_CAPACITY,
      concurrency: { ...DEFAULT_SYNC_CAPACITY.concurrency, liveWaitPerScopeBytes: 1 },
    };
    const { session } = await createHost({ capacity: tinyLiveBudget });
    // 先走 stateless HELLO 建立空基线：写者 acquire 需要运行态/内容 Doc 的已提交 base，否则会先报 DOC_NOT_FOUND。
    await session.onInboundBytes(
      new TextEncoder().encode(
        JSON.stringify({ type: "HELLO", protocolVersion: 1, scope: SCOPE, loadedDocs: [], stateful: false }),
      ),
    );
    const event = {
      type: "message_delta",
      update: { content: { type: "text", text: "hello" } },
      turnId: "turn-live",
    };

    session.acceptNormalizedEvent(event);
    await waitUntil(() => session.ingressDiagnostics().stopped, "ingress to stop");
    expect(session.ingressDiagnostics()).toEqual({
      total: 1,
      lastCode: "CAPACITY_EXCEEDED",
      stopped: true,
    });

    // 若停止标志没有生效，这两次调用会再次进入 runtime 并各自累计一次失败计数。
    session.acceptNormalizedEvent(event);
    session.acceptUserMessage("turn-live", "user text");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.ingressDiagnostics()).toEqual({
      total: 1,
      lastCode: "CAPACITY_EXCEEDED",
      stopped: true,
    });
    expect(session.closed).toBe(false);
    await session.dispose();
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
