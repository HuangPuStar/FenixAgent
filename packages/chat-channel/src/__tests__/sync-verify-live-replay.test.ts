// packages/chat-channel/src/__tests__/sync-verify-wiring-2.test.ts
// V2 第二轮对抗验证（身份 V2）：目标不是复述 wave4 的修正，而是证明它**没有真正解决问题**或引入了新问题。
//
// 观察面全部是黑盒可观测事实：发到传输端口的字节序列、传输层收到的关闭请求、网关自报的在途投递数、
// 真实账本与额度的账目、入口记录快照、导入分派的池占用与在飞结算、以及「按已提交字节重放出的文档」。
// store、会话、额度、账本、出帧网关、控制 governor、ACK 超时登记、构建池、写入层全部用真实实现；注入的替身
// 只有传输端口（宿主 WS 边界）、假时钟、以及历史分派的记录源/提交口（分派器的对外缝本身）。
//
// 每个用例的期望值取设计/规格契约，失败消息里的 Received 就是实际观测值。被顶替/丢失的投递一律通过
// 「客户端收到的序号集合」与「账本残留」两条独立证据链交叉确认，不依赖实现自报的计数。

import { describe, expect, test } from "bun:test";

import * as Y from "yjs";

import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";

import { deterministicRandomSource, sha256Digest } from "../sync/clock";

import { captureChange } from "../sync/live/change-capture";

import { createLiveWriter, type LiveInput, type LiveRecordValue, type LiveWriter } from "../sync/live/live-writer";

import type { RotationControllerOptions } from "../sync/live/rotation";

import { createRuntimeDoc, RUNTIME_DOC_LIMITS, type RuntimeEntityRecord } from "../sync/live/runtime-doc";

import { encodeSyncFrame } from "../sync/protocol/frames";

import { MemoryProjectionStore } from "../sync/store/memory-store";

import type { GenerationEntryRefs, SyncGenerationRecord } from "../sync/store/types";
import {
  ackDirect,
  ackFrame,
  attemptCount,
  BOOTSTRAP_TTL_MS,
  CONTENT_DOC,
  CONTENT_DOCS,
  decodedData,
  docIdFor,
  docRecord,
  driveSession,
  emptyState,
  GENERATION,
  helloFrame,
  isDataFrame,
  LIFECYCLE,
  RUNTIME_DOC,
  SCOPE,
  SCOPE_KEY,
  setupDirect,
  subscribeFrame,
  TestClock,
} from "./sync-verify-wiring-2-fixture";

const LIVE_MERGE = { maxDelayMs: 600_000, maxBytes: 1 << 20 };

/** live 夹具的入口引用：单内容块 + 运行态（写入层的落点分别是 `contentDocIds.at(-1)` 与 `runtimeDocId`）。 */
const LIVE_ENTRY_REFS: GenerationEntryRefs = {
  controlDocId: docIdFor("control", 0, "live-control"),
  directoryDocId: docIdFor("directory", 0, "live-directory"),
  runtimeDocId: RUNTIME_DOC,
  contentDocIds: [CONTENT_DOC],
};

interface LiveHarness {
  readonly store: MemoryProjectionStore;
  readonly time: TestClock;
  readonly writer: LiveWriter;
  readonly runtimeDocId: string;
  readonly contentDocId: string;
}

/** 装配 live 写入层：真实存储 + 真实写入层，只注入假时钟与确定性随机源。 */
async function setupLive(): Promise<LiveHarness> {
  const time = new TestClock();
  const capacity = DEFAULT_SYNC_CAPACITY;
  const store = new MemoryProjectionStore({ clock: time, digest: sha256Digest, capacity, lifecycle: LIFECYCLE });
  const lease = await store.acquireWriter(SCOPE_KEY, "bootstrap", BOOTSTRAP_TTL_MS);
  const generation: SyncGenerationRecord = {
    scopeKey: SCOPE_KEY,
    generation: GENERATION,
    acpSessionId: "acp-live",
    loadId: "load-live",
    state: "staging",
    importEndOrdinal: null,
    entryRefs: LIVE_ENTRY_REFS,
    createdAt: time.now(),
  };
  await store.createGeneration({ scopeKey: SCOPE_KEY, epoch: lease.epoch, generation });
  await store.commitGeneration({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    newGeneration: generation,
    entryClosure: LIVE_ENTRY_REFS,
    expectedCurrent: null,
    expectedPointerRevision: 0,
    retired: [],
  });
  await store.createDoc({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    doc: docRecord(RUNTIME_DOC, "runtime", emptyState()),
  });
  await store.createDoc({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    doc: docRecord(CONTENT_DOC, "content", emptyState()),
  });
  time.advance(BOOTSTRAP_TTL_MS + 1);

  const rotation: RotationControllerOptions = {
    clock: time,
    random: deterministicRandomSource("verify2-rotation"),
    limits: RUNTIME_DOC_LIMITS,
    maxResidentMs: 600_000,
    maxTransactions: 1_000,
  };
  const writer = createLiveWriter({
    scope: SCOPE,
    store,
    clock: time,
    digest: sha256Digest,
    random: deterministicRandomSource("verify2-live"),
    capacity,
    merge: LIVE_MERGE,
    limits: RUNTIME_DOC_LIMITS,
    rotation,
  });
  await writer.acquire();
  return { store, time, writer, runtimeDocId: RUNTIME_DOC, contentDocId: CONTENT_DOC };
}

/** 实体输入（`kind: "tool"`）：编号输入序列里的一条「增/改」。 */
function entityInput(entityId: string, revision: number): LiveInput {
  return {
    turnId: "turn-1",
    entryId: entityId,
    contentSlot: "0",
    contentType: "tool",
    kind: "semantic",
    semantic: { kind: "tool", payload: { entityId, toolCallId: `tc-${entityId}`, metadata: { revision } } },
  };
}

/** 终态输入：带描述符 → 写内容块并在同一批次移出运行态实体。 */
function removalInput(entityId: string): LiveInput {
  return {
    turnId: "turn-1",
    entryId: entityId,
    contentSlot: "0",
    contentType: "tool",
    kind: "semantic",
    semantic: {
      kind: "final",
      payload: {
        entityId,
        finalDescriptor: {
          kind: "tool",
          contentRef: `blk/${entityId}`,
          digest: `dg/${entityId}`,
          byteLength: 8,
          completedAt: 1_700_000_000_000,
        },
      },
    },
  };
}

/** 文本增量：合并窗口很大，只有屏障（封口/终态）才把它冲出去。 */
function textInput(delta: string): LiveInput {
  return {
    turnId: "turn-1",
    entryId: "entry-text",
    contentSlot: "text",
    contentType: "text/plain",
    kind: "text-delta",
    delta,
  };
}

/** 客户端恢复路径：canonical base 快照 + 按序号连续的已提交 tail。 */
function liveReplay(h: LiveHarness, docId: string): Y.Doc {
  const state = h.store.exportCommittedState();
  const stored = state.docs.find((doc) => doc.docId === docId);
  if (stored === undefined) throw new Error(`document ${docId} is not committed`);
  const doc = new Y.Doc({ guid: docId });
  Y.applyUpdate(doc, stored.baseSnapshot);
  for (const update of liveUpdates(h, docId)) Y.applyUpdate(doc, update.bytes);
  return doc;
}

/** 该文档的已提交 tail，按序号升序（序号有洞即抛出：连续性由本函数自己把关）。 */
function liveUpdates(h: LiveHarness, docId: string): Array<{ updateSeq: number; bytes: Uint8Array }> {
  const all = h.store
    .exportCommittedState()
    .updates.filter((update) => update.docId === docId && update.generation === GENERATION)
    .sort((left, right) => left.updateSeq - right.updateSeq);
  all.forEach((update, index) => {
    const expected = index === 0 ? 1 : (all[index - 1]?.updateSeq ?? 0) + 1;
    if (update.updateSeq !== expected) {
      throw new Error(`sequence hole in ${docId}: expected ${expected}, received ${update.updateSeq}`);
    }
  });
  return all.map((update) => ({ updateSeq: update.updateSeq, bytes: update.bytes }));
}

function liveEntities(doc: Y.Doc): RuntimeEntityRecord[] {
  return createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS, doc).exportForRotation();
}

function liveEntityIds(doc: Y.Doc): string[] {
  return liveEntities(doc)
    .map((entity) => entity.entityId)
    .sort();
}

describe("V2 live 写入层：删除、同名重建与封口交错的编号输入 oracle", () => {
  // 契约（设计 §6.2/§6.3 + 规格 §6.3）：每一步编号输入的运行态都必须能由已提交 tail 重放出来——包括
  // 「删除」「删除后再用同名 entityId 重建」这两类只能靠重放序列区分的状态；只比对终态会漏掉被吞掉的删除。
  test("删除与同名重建：每一步的运行态都必须由已提交 tail 逐步重放出来", async () => {
    const h = await setupLive();
    // 自有 oracle：编号输入序列（1 增 a、2 增 b、3 删 a、4 同名重建 a、5 删 b）。
    const steps: string[][] = [];
    const inputs: LiveInput[] = [
      entityInput("entity_a", 1),
      entityInput("entity_b", 1),
      removalInput("entity_a"),
      entityInput("entity_a", 2),
      removalInput("entity_b"),
      removalInput("entity_a"),
    ];
    const expected: string[][] = [
      ["entity_a"],
      ["entity_a", "entity_b"],
      ["entity_b"],
      ["entity_a", "entity_b"],
      ["entity_a"],
      [],
    ];

    for (const input of inputs) {
      await h.writer.accept(input);
      steps.push(liveEntityIds(liveReplay(h, h.runtimeDocId)));
    }

    expect(steps).toEqual(expected);
    // 同名重建必须落成新内容（revision 2），而不是旧实体留下的幽灵；重建后的实体也必须能被再次删除。
    const rebuilt = liveEntities(liveReplay(h, h.runtimeDocId)).find((entity) => entity.entityId === "entity_a");
    expect(rebuilt).toBeUndefined();
    // 序号连续性是重放 oracle 的前提：tail 必须从 1 起连续（`liveUpdates` 已校验，这里量化确认）。
    expect(liveUpdates(h, h.runtimeDocId).length).toBe(inputs.length);
  });

  // 契约（设计 §6.3 运行态轮换 + 规格 §6.2 封口）：轮换先取出存活实体再封口，删除必须落在**被封口的旧文档**里；
  // 若删除只存在于写者内存 Doc，封口后它就永久消失了。
  test("轮换封口的交错：删除落在被封口的旧运行态文档里，存活实体被带到新文档", async () => {
    const h = await setupLive();
    await h.writer.accept(entityInput("entity_keep", 1));
    await h.writer.accept(entityInput("entity_gone", 1));
    await h.writer.accept(removalInput("entity_gone"));

    const rotated = await h.writer.rotateRuntime();

    expect(liveEntityIds(liveReplay(h, rotated.oldDocId))).toEqual(["entity_keep"]);
    expect(liveEntityIds(liveReplay(h, rotated.newDocId))).toEqual(["entity_keep"]);
  });

  // 契约（设计 §6.1「屏障前已接收的文本先完成写入」）：唯一的未决批次必须在封口前被冲进旧内容块，
  // 否则这段文本既不在已封口块里、也没有后续写入能把它带下去（内容无声丢失）。
  test("封口屏障：未决的文本批次必须先落进被封装的内容块", async () => {
    const h = await setupLive();
    await h.writer.accept(textInput("pending-before-seal"));

    const sealed = await h.writer.seal();

    const records = liveReplay(h, h.contentDocId).getMap<unknown>("root").get("records");
    const texts =
      records instanceof Y.Array ? records.toArray().map((record) => (record as LiveRecordValue).payload) : [];
    expect(texts.length).toBe(1);
    expect(new TextDecoder().decode(texts[0])).toBe("pending-before-seal");
    expect(sealed.docId).toBe(h.contentDocId);
  });
});

// ---------------------------------------------------------------------------------------------------
// E 组（方向 5 的捕获层补充 + 方向 6 的回归面）
// ---------------------------------------------------------------------------------------------------

describe("V2 捕获层与回归面", () => {
  // 契约（`change-capture.ts` + 设计 §6.2）：同一事务里的多次删除、以及「删掉再重建同名键」都必须被完整
  // 捕获在同一条更新里——少一条删除，接收方就永久留着幽灵；少一条写入，重建的内容就丢了。
  test("同一事务里的多次删除与删除后同名重建被完整捕获并重放", () => {
    const doc = new Y.Doc();
    const entities = doc.getMap<string>("runtime");
    const base = captureChange(doc, () => {
      entities.set("a", "v1");
      entities.set("b", "v1");
      entities.set("c", "v1");
    });
    expect(base).not.toBeNull();

    const mixed = captureChange(doc, () => {
      entities.delete("a");
      entities.delete("c");
      entities.set("b", "v2");
      entities.set("d", "v1");
      entities.delete("d");
      entities.set("d", "v2");
    });
    expect(mixed).not.toBeNull();

    const witness = new Y.Doc();
    if (base !== null) Y.applyUpdate(witness, base);
    expect([...witness.getMap<string>("runtime").keys()].sort()).toEqual(["a", "b", "c"]);
    if (mixed !== null) Y.applyUpdate(witness, mixed);
    expect([...witness.getMap<string>("runtime").entries()].sort()).toEqual([
      ["b", "v2"],
      ["d", "v2"],
    ]);
  });

  // 回归面（方向 6 的「额度单一账户」）：账本的归还必须回到会话预留额度的同一个账户——只有一条 ACK 路径
  // 能归还窗口字节，若归还到别处，诚实客户端的完整回执之后账户也不会归零。
  test("额度单一账户：回执全部收到的帧后账本与额度同时归零", async () => {
    const h = await setupDirect();
    await h.gateway.onInboundBytes(encodeSyncFrame(helloFrame()));
    await h.gateway.onInboundBytes(encodeSyncFrame(subscribeFrame(CONTENT_DOCS)));
    const delivered = decodedData(h.transport.sent);
    expect(delivered.length).toBeGreaterThan(0);
    expect(h.quota.snapshot().outstandingBytes).toBeGreaterThan(0);
    expect(h.ledger.outstandingCount()).toBe(delivered.length);

    await ackDirect(h);
    expect(h.ledger.outstandingCount()).toBe(0);
    expect(h.quota.snapshot().outstandingBytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// F 组（方向 1 的计账守恒 + 设计 §15.1「重复文本不得去重」）
// ---------------------------------------------------------------------------------------------------

describe("V2 计账守恒与重复内容", () => {
  // 契约（设计 §15.1 oracle 说明 + 规格 §2.4）：相同文本的两条增量是两份内容，合并窗口只能拼接、不得去重；
  // 一旦被当成重复丢弃，客户端与库里的内容就与 Agent 实际产出不符。
  test("重复文本不被去重：两条相同增量必须都落到内容块里", async () => {
    const h = await setupLive();
    await h.writer.accept(textInput("dup"));
    await h.writer.accept(textInput("dup"));
    await h.writer.seal();

    const records = liveReplay(h, h.contentDocId).getMap<unknown>("root").get("records");
    const text = (records instanceof Y.Array ? records.toArray() : [])
      .map((record) => new TextDecoder().decode((record as LiveRecordValue).payload))
      .join("");
    expect(text).toBe("dupdup");
  });

  // 契约（规格 §2.4 + ack-ledger.ts:101-122）：ACK 与补发可能交错——宿主 `send` 返回 false 但字节已出门时，
  // 客户端会回执一条服务端认为「没发出去」的投递，随后补发又把同一 deliveryId 送一遍。归还路径只允许结算一次。
  test("ACK 与补发交错：同一 deliveryId 只结算一次，账户不为负", async () => {
    const h = await setupDirect();
    await h.gateway.onInboundBytes(encodeSyncFrame(helloFrame()));
    // 只拒发一次：这条基线帧被搁置，服务端认为它没发出去。
    h.transport.refuse(isDataFrame, 1);
    await h.gateway.onInboundBytes(encodeSyncFrame(subscribeFrame([CONTENT_DOC])));
    const withheld = decodedData(h.transport.refused)[0];
    if (withheld === undefined) throw new Error("expected one refused DOC_BASE");
    // 该投递已被会话计费并登记：账本与窗口都在等一条 ACK（这是它「有补偿责任」的原因）。
    expect(h.ledger.outstandingCount()).toBe(1);
    expect(h.quota.snapshot().outstandingBytes).toBeGreaterThan(0);

    // 与拒发交错的回执：客户端确实收到了它。
    await h.gateway.onInboundBytes(encodeSyncFrame(ackFrame(withheld)));
    expect(h.ledger.outstandingCount()).toBe(0);
    expect(h.quota.snapshot().outstandingBytes).toBe(0);

    // 传输恢复：同一 deliveryId 被补发一次，客户端再回执一次（重复回执不得二次归还，否则账户为负或凭空多出额度）。
    h.transport.stopRefusing();
    await driveSession(h);
    expect(attemptCount(h.transport.attempts, withheld.deliveryId)).toBe(2);
    await ackDirect(h);
    await driveSession(h);

    expect(h.ledger.outstandingCount()).toBe(0);
    expect(h.quota.snapshot().outstandingBytes).toBe(0);
  });
});
