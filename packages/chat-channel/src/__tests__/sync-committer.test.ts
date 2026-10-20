// packages/chat-channel/src/__tests__/sync-committer.test.ts
// C2 提交器（规格 §5.6）的行为守护：create-if-absent、冲突读回与已提交目录的连续性。
//
// 这里用的是**测试替身**，只实现提交器真正调用的三个存储出口（`putSealedIfAbsent` /
// `readDocStateAt` / `readDirectory`），语义照 `store/types.ts` 的冻结契约实现；其余出口一律抛错，
// 误用即暴露而不是给出一个看似合理的假答案。理由：`src/sync/store/memory-store.ts`（B 阶段）在本
// 工作区尚不存在，而本文件要固化的是**提交器语义**，不是第二个内存 adapter 的回归测试。
// 待 B 阶段落地后替身可整体替换为 `MemoryProjectionStore`，用例名与断言不变。

import { describe, expect, test } from "bun:test";

import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { type BlockRecordInput, type BuiltBlock, buildContentBlock } from "../sync/history/block-builder";
import { HistoryCommitter } from "../sync/history/committer";
import { type SyncErrorCode, SyncProtocolError } from "../sync/protocol/errors";
import { buildDocId } from "../sync/protocol/identity";
import type {
  AppendUpdatesResult,
  CommitGenerationResult,
  CommitOutcome,
  DirectoryPage,
  DirectoryQuery,
  DocStateSnapshot,
  ProjectionStore,
  PutSealedInput,
  PutSealedResult,
  RetireResult,
  SealDocResult,
  SyncDocRecord,
  SyncGenerationRecord,
  SyncRefRecord,
  SyncScopeRow,
  SyncUpdateRecord,
  WriterLease,
} from "../sync/store/types";

const SCOPE_KEY = "org_committer_test/rcs_session_committer_test";
const GENERATION = "gen_committer_test";
const textEncoder = new TextEncoder();

/** 目录页条目形状；替身与断言共用一份，避免两处各写一份后在字段名上漂移。 */
type DirectoryEntry = DirectoryPage["entries"][number];

/** 未实现的存储出口：抛错而不是返回空值，避免替身在无关路径上伪装成成功。 */
function unusedStoreMethod<T>(name: string): Promise<T> {
  throw new Error(`commit store double does not implement ${name}`);
}

/** 已提交记录存副本：调用方后续改缓冲不得穿透进「已提交」状态。 */
function copyDoc(doc: SyncDocRecord): SyncDocRecord {
  return { ...doc, snapshot: new Uint8Array(doc.snapshot), dependsOn: [...doc.dependsOn] };
}

/** 按整代次已提交条目算缺口：相邻两条之间序号不连续即为一段缺口（首块之前的序号不在此表达）。 */
function directoryGaps(entries: DirectoryEntry[]): { afterOrdinal: number; beforeOrdinal: number }[] {
  const gaps: { afterOrdinal: number; beforeOrdinal: number }[] = [];
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1];
    const current = entries[index];
    if (current.ordinalStart > previous.ordinalEnd + 1) {
      gaps.push({ afterOrdinal: previous.ordinalEnd, beforeOrdinal: current.ordinalStart });
    }
  }
  return gaps;
}

/**
 * 存储替身：实现提交器用到的三个出口，另加两个开关用于构造单进程存储不会自发生成的路径。
 *
 * `insertCount` 统计**真实写入**次数：`already-committed` / `conflict` / `unknown` 都不得增加它，
 * 这是「幂等重试不重复写入」唯一可观察的证据（只看目录条目数区分不了「没写」与「写了同内容」）。
 */
class CommitStoreDouble implements ProjectionStore {
  private readonly docs = new Map<string, SyncDocRecord>();
  /** 非空时下一次 `putSealedIfAbsent` 返回该结局且不写任何字节（模拟提交结果未知）。 */
  forcedOutcome: CommitOutcome | null = null;
  insertCount = 0;

  async putSealedIfAbsent(input: PutSealedInput): Promise<PutSealedResult> {
    const forced = this.forcedOutcome;
    this.forcedOutcome = null;
    if (forced !== null) {
      return { outcome: forced, hash: this.docs.get(input.doc.docId)?.hash ?? "" };
    }
    const existing = this.docs.get(input.doc.docId);
    if (existing !== undefined) {
      // 同键幂等、异摘要冲突：两条路径都不改动已提交字节。
      return existing.hash === input.doc.hash
        ? { outcome: "already-committed", hash: existing.hash }
        : { outcome: "conflict", hash: existing.hash };
    }
    this.docs.set(input.doc.docId, copyDoc(input.doc));
    this.insertCount += 1;
    return { outcome: "committed", hash: input.doc.hash };
  }

  /** 忽略 `seq`：内容块是整块快照，读回位置恒为 `baseSeq`；返回副本，不交出内部缓冲。 */
  async readDocStateAt(docId: string): Promise<DocStateSnapshot | null> {
    const doc = this.docs.get(docId);
    if (doc === undefined) {
      return null;
    }
    return {
      docId,
      baseSeq: doc.baseSeq,
      lastSeq: doc.baseSeq,
      snapshot: new Uint8Array(doc.snapshot),
      hash: doc.hash,
    };
  }

  /** 目录只含该代次已封口内容块，按 `ordinalStart` 升序；`gaps` / `complete` 按整代次算，与 `limit` 无关。 */
  async readDirectory(query: DirectoryQuery): Promise<DirectoryPage> {
    const all = [...this.docs.values()]
      .filter((doc) => doc.generation === query.generation && doc.kind === "content" && doc.state === "sealed")
      .map((doc) => ({
        docId: doc.docId,
        ordinalStart: doc.ordinalStart ?? 0,
        ordinalEnd: doc.ordinalEnd ?? 0,
        hash: doc.hash,
        sealed: true,
      }))
      .sort((left, right) => left.ordinalStart - right.ordinalStart);
    const entries = all
      .filter((entry) => query.afterOrdinal === undefined || entry.ordinalEnd > query.afterOrdinal)
      .slice(0, query.limit);
    const gaps = directoryGaps(all);
    return { entries, gaps, complete: gaps.length === 0 };
  }

  /** 预置一条已提交记录：构造「存储说冲突但目录里没有该块」与「自报摘要与字节不符」两种存储故障。 */
  seedDoc(doc: SyncDocRecord): void {
    this.docs.set(doc.docId, copyDoc(doc));
  }

  // 其余出口未实现：误用即抛错（调用签名可省略入参，返回类型保持与 `ProjectionStore` 一致）。
  readonly acquireWriter: () => Promise<WriterLease> = () => unusedStoreMethod("acquireWriter");
  readonly renewWriter: () => Promise<WriterLease> = () => unusedStoreMethod("renewWriter");
  readonly appendUpdates: () => Promise<AppendUpdatesResult> = () => unusedStoreMethod("appendUpdates");
  readonly sealDoc: () => Promise<SealDocResult> = () => unusedStoreMethod("sealDoc");
  readonly commitGeneration: () => Promise<CommitGenerationResult> = () => unusedStoreMethod("commitGeneration");
  readonly readUpdatesAfter: () => Promise<SyncUpdateRecord[]> = () => unusedStoreMethod("readUpdatesAfter");
  readonly readScopePointer: () => Promise<SyncScopeRow | null> = () => unusedStoreMethod("readScopePointer");
  readonly readGeneration: () => Promise<SyncGenerationRecord | null> = () => unusedStoreMethod("readGeneration");
  readonly locateRefs: () => Promise<SyncRefRecord[]> = () => unusedStoreMethod("locateRefs");
  readonly retireAndCollect: () => Promise<RetireResult> = () => unusedStoreMethod("retireAndCollect");
}

/** 预置一条同 docId 的异摘要记录，用于构造存储侧故障；`state` 决定它是否出现在已提交目录里。 */
function seedForeignDoc(
  store: CommitStoreDouble,
  docId: string,
  input: { state: SyncDocRecord["state"]; snapshot: Uint8Array; hash: string },
): void {
  store.seedDoc({
    scopeKey: SCOPE_KEY,
    generation: GENERATION,
    docId,
    kind: "content",
    state: input.state,
    snapshot: input.snapshot,
    hash: input.hash,
    baseSeq: 0,
    finalSeq: input.state === "sealed" ? 0 : null,
    blockIndex: 0,
    ordinalStart: 1,
    ordinalEnd: 2,
    dependsOn: [],
  });
}

/** 构造一份写者租约；提交器只使用它的 `scopeKey` 与 `epoch`。 */
function writerLease(scopeKey: string = SCOPE_KEY): WriterLease {
  return { scopeKey, epoch: 7, owner: "writer_committer_test", expiresAt: 1_000_000 };
}

/** 构造提交器与其替身；默认租约属于本 scope，用例只覆盖关心的入参。 */
function setup(overrides: { generation?: string; lease?: WriterLease } = {}): {
  store: CommitStoreDouble;
  committer: HistoryCommitter;
} {
  const store = new CommitStoreDouble();
  const scopeKey = SCOPE_KEY;
  const generation = overrides.generation ?? GENERATION;
  const lease = overrides.lease ?? writerLease(scopeKey);
  return { store, committer: new HistoryCommitter({ store, scopeKey, generation, lease, digest: sha256Digest }) };
}

/** 生成 `[from, to]` 连续源序号的记录；`salt` 用于在同一序号范围下换取不同字节。 */
function records(from: number, to: number, salt = ""): BlockRecordInput[] {
  const out: BlockRecordInput[] = [];
  for (let ordinal = from; ordinal <= to; ordinal += 1) {
    out.push({
      sourceOrdinal: ordinal,
      kind: "history_object",
      payload: textEncoder.encode(`${salt}payload-${ordinal}`),
      entryId: `entry_${ordinal}`,
      entryOrder: ordinal,
      contentSlot: 0,
      partIndex: 0,
    });
  }
  return out;
}

/**
 * 用真实构建器产出一个块：提交器必须吞得下 block-builder 的真实 canonical 字节。
 *
 * `seed` 决定 docId 的 nonce（构建器取随机源前 8 字节），同一 `seed` + 同一 blockIndex 得到**同一
 * docId**；再换 payload（`salt` 或序号范围）就得到「同 docId 异摘要」的竞争重建物。
 */
function buildBlock(input: { blockIndex: number; seed: string; from: number; to: number; salt?: string }): BuiltBlock {
  return buildContentBlock({
    generation: GENERATION,
    blockIndex: input.blockIndex,
    records: records(input.from, input.to, input.salt ?? ""),
    targetPayloadBytes: DEFAULT_SYNC_CAPACITY.inputs.historyBlockTargetPayloadBytes,
    hardLimitBytes: DEFAULT_SYNC_CAPACITY.inputs.historyBlockHardBytes,
    rand: deterministicRandomSource(input.seed),
    digest: sha256Digest,
  });
}

/** 断言调用以指定协议错误码失败：错误码是跨模块可依赖的稳定契约，消息文本不是。 */
async function expectSyncErrorCode(run: () => Promise<unknown>, code: SyncErrorCode): Promise<void> {
  const error = await run().then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SyncProtocolError);
  expect(error instanceof SyncProtocolError ? error.code : "no-error").toBe(code);
}

describe("HistoryCommitter.commitBlock", () => {
  test("首次提交返回 committed，且已提交目录能查到该块", async () => {
    const { store, committer } = setup();
    const block = buildBlock({ blockIndex: 0, seed: "commit-first", from: 1, to: 2 });

    const result = await committer.commitBlock(block);

    expect(result.outcome).toBe("committed");
    expect(result.ref).toEqual({
      docId: block.docId,
      blockIndex: 0,
      ordinalStart: 1,
      ordinalEnd: 2,
      hash: block.hash,
    });
    expect(store.insertCount).toBe(1);
    const page = await committer.listDirectory(16);
    expect(page.blocks).toEqual([result.ref]);
    expect(page.gaps).toEqual([]);
    expect(page.complete).toBe(true);
  });

  test("同 docId 同摘要重试返回 already-committed：不重复写入，也不改动已提交字节", async () => {
    const { store, committer } = setup();
    const block = buildBlock({ blockIndex: 0, seed: "commit-idempotent", from: 1, to: 2 });
    const first = await committer.commitBlock(block);
    const bytesBefore = (await store.readDocStateAt(block.docId))?.snapshot;

    const retry = await committer.commitBlock(block);

    expect(retry.outcome).toBe("already-committed");
    expect(retry.ref).toEqual(first.ref);
    expect(store.insertCount).toBe(1);
    const after = await store.readDocStateAt(block.docId);
    expect(Array.from(after?.snapshot ?? [])).toEqual(Array.from(bytesBefore ?? []));
    expect(after?.hash).toBe(block.hash);
  });

  test("同 docId 异摘要返回 conflict，既有 canonical 字节未被覆盖", async () => {
    const { store, committer } = setup();
    const committed = buildBlock({ blockIndex: 0, seed: "commit-conflict", from: 1, to: 2 });
    const first = await committer.commitBlock(committed);
    // 同一 seed 与同一 blockIndex → 同一 docId；换 payload 后字节与摘要都不同。
    const competing = buildBlock({ blockIndex: 0, seed: "commit-conflict", from: 1, to: 2, salt: "competing-" });
    expect(competing.docId).toBe(committed.docId);
    expect(competing.hash).not.toBe(committed.hash);

    const result = await committer.commitBlock(competing);

    expect(result.outcome).toBe("conflict");
    expect(result.ref).toEqual(first.ref);
    // 读回的是首次提交的字节与摘要：竞争重建物一个字节都没写进去。
    const state = await store.readDocStateAt(committed.docId);
    expect(state?.hash).toBe(committed.hash);
    expect(sha256Digest(state?.snapshot ?? new Uint8Array())).toBe(committed.hash);
    expect(store.insertCount).toBe(1);
  });

  test("冲突时返回的 ref 描述既有块的范围，而不是本次重建物的范围", async () => {
    const { store, committer } = setup();
    const committed = buildBlock({ blockIndex: 0, seed: "commit-range", from: 1, to: 2 });
    await committer.commitBlock(committed);
    // 重建物覆盖 1–3（多一条记录）：与既有块同 docId 但范围更长，必须以已提交原字节为准。
    const wider = buildBlock({ blockIndex: 0, seed: "commit-range", from: 1, to: 3 });

    const result = await committer.commitBlock(wider);

    expect(wider.docId).toBe(committed.docId);
    expect(wider.ordinalEnd).toBe(3);
    expect(result.outcome).toBe("conflict");
    expect(result.ref.ordinalStart).toBe(1);
    expect(result.ref.ordinalEnd).toBe(2);
    expect(result.ref.hash).toBe(committed.hash);
    expect(store.insertCount).toBe(1);
  });

  test("既有异摘要提交不在已提交目录中时抛 IMPORT_INCOMPLETE：不覆盖，也不假装成功", async () => {
    const { store, committer } = setup();
    const block = buildBlock({ blockIndex: 0, seed: "commit-missing-entry", from: 1, to: 2 });
    // 预置一条同 docId、自洽但不在目录里的记录（例如尚未封口的文档）：字节可读，但不可复用。
    const foreignSnapshot = Uint8Array.from([1, 2, 3]);
    seedForeignDoc(store, block.docId, {
      state: "active",
      snapshot: foreignSnapshot,
      hash: sha256Digest(foreignSnapshot),
    });

    await expectSyncErrorCode(() => committer.commitBlock(block), "IMPORT_INCOMPLETE");

    const state = await store.readDocStateAt(block.docId);
    expect(state?.hash).toBe(sha256Digest(foreignSnapshot));
  });

  test("已提交记录自报摘要与它存回的字节不符时抛 DIGEST_CONFLICT：矛盾证据不得选一个信", async () => {
    const { store, committer } = setup();
    const block = buildBlock({ blockIndex: 0, seed: "commit-broken-store", from: 1, to: 2 });
    seedForeignDoc(store, block.docId, { state: "sealed", snapshot: Uint8Array.from([9, 9, 9]), hash: "d".repeat(64) });

    await expectSyncErrorCode(() => committer.commitBlock(block), "DIGEST_CONFLICT");
  });

  test("提交响应未知但字节已落地且摘要一致时收敛为 already-committed", async () => {
    const { store, committer } = setup();
    const block = buildBlock({ blockIndex: 0, seed: "commit-unknown-landed", from: 1, to: 2 });
    const first = await committer.commitBlock(block);
    store.forcedOutcome = "unknown";

    const retry = await committer.commitBlock(block);

    expect(retry.outcome).toBe("already-committed");
    expect(retry.ref).toEqual(first.ref);
    expect(store.insertCount).toBe(1);
  });

  test("提交响应未知且读不到既有字节时抛 COMMIT_OUTCOME_UNKNOWN：没有证据就不猜成功", async () => {
    const { store, committer } = setup();
    const block = buildBlock({ blockIndex: 0, seed: "commit-unknown-lost", from: 1, to: 2 });
    store.forcedOutcome = "unknown";

    await expectSyncErrorCode(() => committer.commitBlock(block), "COMMIT_OUTCOME_UNKNOWN");
  });

  test("代次不匹配时抛 GENERATION_MISMATCH，且不写入任何字节", async () => {
    const { store, committer } = setup();
    const foreign = buildContentBlock({
      generation: "gen_other_generation",
      blockIndex: 0,
      records: records(1, 2),
      targetPayloadBytes: DEFAULT_SYNC_CAPACITY.inputs.historyBlockTargetPayloadBytes,
      hardLimitBytes: DEFAULT_SYNC_CAPACITY.inputs.historyBlockHardBytes,
      rand: deterministicRandomSource("commit-foreign-generation"),
      digest: sha256Digest,
    });

    await expectSyncErrorCode(() => committer.commitBlock(foreign), "GENERATION_MISMATCH");

    expect(store.insertCount).toBe(0);
  });

  test("摘要与 canonical 字节不符时抛 DIGEST_CONFLICT：不允许写入无法自证的记录", async () => {
    const { store, committer } = setup();
    const block = buildBlock({ blockIndex: 0, seed: "commit-broken-hash", from: 1, to: 2 });

    await expectSyncErrorCode(() => committer.commitBlock({ ...block, hash: "0".repeat(64) }), "DIGEST_CONFLICT");

    expect(store.insertCount).toBe(0);
    expect((await committer.listDirectory(16)).blocks).toEqual([]);
  });

  test("docId 谱系不是 content 块时抛 MALFORMED_FRAME", async () => {
    const { store, committer } = setup();
    const block = buildBlock({ blockIndex: 0, seed: "commit-wrong-kind", from: 1, to: 2 });
    const runtimeDocId = buildDocId({
      kind: "runtime",
      generation: GENERATION,
      blockIndex: 0,
      nonce: "0011223344556677",
    });

    await expectSyncErrorCode(() => committer.commitBlock({ ...block, docId: runtimeDocId }), "MALFORMED_FRAME");

    expect(store.insertCount).toBe(0);
  });

  test("ordinalEnd 早于 ordinalStart 时抛 MALFORMED_FRAME，且不写入", async () => {
    const { store, committer } = setup();
    const block = buildBlock({ blockIndex: 0, seed: "commit-bad-range", from: 1, to: 2 });

    await expectSyncErrorCode(
      () => committer.commitBlock({ ...block, ordinalStart: 5, ordinalEnd: 3 }),
      "MALFORMED_FRAME",
    );

    expect(store.insertCount).toBe(0);
  });

  test("构造期拒绝别的 scope 的租约：epoch 只在同一 scope 行内构成 fencing", () => {
    const store = new CommitStoreDouble();
    let caught: unknown;
    try {
      new HistoryCommitter({
        store,
        scopeKey: SCOPE_KEY,
        generation: GENERATION,
        lease: writerLease("org_other/rcs_session_other"),
        digest: sha256Digest,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SyncProtocolError);
    expect(caught instanceof SyncProtocolError ? caught.code : "no-error").toBe("WRITER_EPOCH_LOST");
  });
});

describe("HistoryCommitter.listDirectory", () => {
  test("乱序提交的多个块按 ordinalStart 升序返回，缺口为空且 complete 为 true", async () => {
    const { committer } = setup();
    const third = buildBlock({ blockIndex: 2, seed: "order-3", from: 5, to: 6 });
    const first = buildBlock({ blockIndex: 0, seed: "order-1", from: 1, to: 2 });
    const second = buildBlock({ blockIndex: 1, seed: "order-2", from: 3, to: 4 });
    for (const block of [third, first, second]) {
      expect((await committer.commitBlock(block)).outcome).toBe("committed");
    }

    const page = await committer.listDirectory(16);

    expect(page.blocks.map((block) => block.ordinalStart)).toEqual([1, 3, 5]);
    expect(page.blocks.map((block) => block.blockIndex)).toEqual([0, 1, 2]);
    expect(page.gaps).toEqual([]);
    expect(page.complete).toBe(true);
  });

  test("中间缺块时 gaps 明确列出缺口且 complete 为 false", async () => {
    const { committer } = setup();
    await committer.commitBlock(buildBlock({ blockIndex: 0, seed: "gap-left", from: 1, to: 2 }));
    await committer.commitBlock(buildBlock({ blockIndex: 3, seed: "gap-right", from: 7, to: 8 }));

    const page = await committer.listDirectory(16);

    expect(page.blocks.map((block) => block.ordinalStart)).toEqual([1, 7]);
    expect(page.gaps).toEqual([{ afterOrdinal: 2, beforeOrdinal: 7 }]);
    expect(page.complete).toBe(false);
  });

  test("limit 只截断条目，不改变整个代次的 gaps 与 complete", async () => {
    const { committer } = setup();
    await committer.commitBlock(buildBlock({ blockIndex: 0, seed: "limit-1", from: 1, to: 2 }));
    await committer.commitBlock(buildBlock({ blockIndex: 1, seed: "limit-2", from: 3, to: 4 }));
    await committer.commitBlock(buildBlock({ blockIndex: 2, seed: "limit-3", from: 5, to: 6 }));

    const page = await committer.listDirectory(2);

    expect(page.blocks.length).toBe(2);
    // 连续性描述整代次已提交范围，不是这一页；分页是否取完由 `blocks.length === limit` 判定。
    expect(page.gaps).toEqual([]);
    expect(page.complete).toBe(true);
    expect((await committer.listDirectory(3)).blocks.length).toBe(3);
  });

  test("空目录返回空块列表、空缺口与 complete 为 true（空真：没有任何缺口）", async () => {
    const { committer } = setup();

    const page = await committer.listDirectory(16);

    expect(page.blocks).toEqual([]);
    expect(page.gaps).toEqual([]);
    expect(page.complete).toBe(true);
  });

  test("limit 不是正整数时抛 MALFORMED_FRAME，不做静默钳制", async () => {
    const { committer } = setup();

    await expectSyncErrorCode(() => committer.listDirectory(0), "MALFORMED_FRAME");
    await expectSyncErrorCode(() => committer.listDirectory(1.5), "MALFORMED_FRAME");
  });
});
