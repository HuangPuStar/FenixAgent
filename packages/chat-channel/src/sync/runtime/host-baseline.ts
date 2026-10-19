// packages/chat-channel/src/sync/runtime/host-baseline.ts
// stateless 首次连接的基线代次：只创建空的内容/控制/运行态/目录 Doc，不伪造历史。
//
// 目录 Doc 分页：根目录只持最新页 ID，每页固定条数并链接上一页；客户端经 MANIFEST 的
// `directoryDocId` 订阅根目录，再按 `latestPageId` / `previousPageId` 逐页发现内容块。
// 真实 ACP 历史仍必须由 `HistoryImportService` 以完整稳定对象列表导入。

import * as Y from "yjs";
import type { Clock, DigestFn, RandomSource } from "../clock";
import {
  buildDirectoryPageSnapshot,
  buildDirectoryRootSnapshot,
  directoryPageDocId,
  directoryRootDocId,
} from "../protocol/directory";
import { SyncProtocolError } from "../protocol/errors";
import {
  buildDocId,
  createBatchId,
  createGenerationId,
  createLoadId,
  type SyncScope,
  scopeKey,
} from "../protocol/identity";
import type { GenerationEntryRefs, ProjectionStore, SyncDocRecord } from "../store/types";

const BASELINE_LEASE_TTL_MS = 30_000;

function encodeSnapshot(build?: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  try {
    build?.(doc);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

function docRecordOf(input: {
  readonly scopeKey: string;
  readonly generation: string;
  readonly docId: string;
  readonly kind: SyncDocRecord["kind"];
  readonly snapshot: Uint8Array;
  readonly digest: DigestFn;
  readonly blockIndex: number | null;
}): SyncDocRecord {
  return {
    scopeKey: input.scopeKey,
    generation: input.generation,
    docId: input.docId,
    kind: input.kind,
    state: "active",
    snapshot: input.snapshot,
    hash: input.digest(input.snapshot),
    baseSeq: 0,
    finalSeq: null,
    blockIndex: input.blockIndex,
    ordinalStart: input.kind === "content" ? 0 : null,
    ordinalEnd: input.kind === "content" ? 0 : null,
    dependsOn: [],
  };
}

/**
 * 读取或创建当前代次。
 *
 * 已存在 committed 当前代次时直接返回；否则在单写权下创建空基线并原子提交。空基线只服务
 * 「客户端先握手、再用目录 Doc 发现内容块」的 stateless 首连，不替代历史导入。
 */
export async function ensureBaselineGeneration(input: {
  readonly store: ProjectionStore;
  readonly scope: SyncScope;
  readonly owner: string;
  readonly clock: Clock;
  readonly digest: DigestFn;
  readonly random: RandomSource;
}): Promise<string> {
  const key = scopeKey(input.scope);
  const pointer = await input.store.readScopePointer(key);
  if (pointer !== null && pointer.currentGeneration !== null) {
    const current = await input.store.readGeneration(key, pointer.currentGeneration);
    if (current?.state === "committed") return current.generation;
  }
  const lease = await input.store.acquireWriter(key, input.owner, BASELINE_LEASE_TTL_MS);
  try {
    const generation = createGenerationId(input.random);
    const loadId = createLoadId(input.random);
    const controlDocId = buildDocId({ kind: "control", generation, blockIndex: 0, nonce: createBatchId(input.random) });
    const runtimeDocId = buildDocId({ kind: "runtime", generation, blockIndex: 0, nonce: createBatchId(input.random) });
    const directoryDocId = directoryRootDocId(generation);
    const pageDocId = directoryPageDocId(generation, 1);
    const contentDocId = buildDocId({ kind: "content", generation, blockIndex: 0, nonce: createBatchId(input.random) });
    const entryRefs: GenerationEntryRefs = {
      controlDocId,
      directoryDocId,
      runtimeDocId,
      contentDocIds: [contentDocId],
    };
    const registration = await input.store.createGeneration({
      scopeKey: key,
      epoch: lease.epoch,
      generation: {
        scopeKey: key,
        generation,
        acpSessionId: "",
        loadId,
        state: "staging",
        importEndOrdinal: 0,
        entryRefs,
        createdAt: input.clock.now(),
      },
    });
    if (registration.outcome === "conflict") {
      throw new SyncProtocolError("GENERATION_MISMATCH", { message: "baseline generation already exists" });
    }
    if (registration.outcome === "unknown") {
      throw new SyncProtocolError("COMMIT_OUTCOME_UNKNOWN", { message: "baseline generation outcome is unknown" });
    }
    // 基线只有一个内容块：立即建一页并让根目录指向它，客户端无需等待首次 live 写入。
    const directorySnapshot = buildDirectoryRootSnapshot(pageDocId);
    const pageSnapshot = buildDirectoryPageSnapshot(entryRefs.contentDocIds, null);
    const docs: SyncDocRecord[] = [
      docRecordOf({
        scopeKey: key,
        generation,
        docId: controlDocId,
        kind: "control",
        snapshot: encodeSnapshot(),
        digest: input.digest,
        blockIndex: null,
      }),
      docRecordOf({
        scopeKey: key,
        generation,
        docId: runtimeDocId,
        kind: "runtime",
        snapshot: encodeSnapshot(),
        digest: input.digest,
        blockIndex: null,
      }),
      docRecordOf({
        scopeKey: key,
        generation,
        docId: directoryDocId,
        kind: "directory",
        snapshot: directorySnapshot,
        digest: input.digest,
        blockIndex: null,
      }),
      docRecordOf({
        scopeKey: key,
        generation,
        docId: pageDocId,
        kind: "directory",
        snapshot: pageSnapshot,
        digest: input.digest,
        blockIndex: 1,
      }),
      docRecordOf({
        scopeKey: key,
        generation,
        docId: contentDocId,
        kind: "content",
        snapshot: encodeSnapshot(),
        digest: input.digest,
        blockIndex: 0,
      }),
    ];
    for (const doc of docs) {
      const created = await input.store.createDoc({ scopeKey: key, epoch: lease.epoch, doc });
      if (created.outcome === "conflict") {
        throw new SyncProtocolError("DIGEST_CONFLICT", { message: "baseline document conflicts" });
      }
      if (created.outcome === "unknown") {
        throw new SyncProtocolError("COMMIT_OUTCOME_UNKNOWN", { message: "baseline document outcome is unknown" });
      }
    }
    const committed = await input.store.commitGeneration({
      scopeKey: key,
      epoch: lease.epoch,
      expectedCurrent: pointer?.currentGeneration ?? null,
      newGeneration: {
        scopeKey: key,
        generation,
        acpSessionId: "",
        loadId,
        state: "staging",
        importEndOrdinal: 0,
        entryRefs,
        createdAt: input.clock.now(),
      },
      retired: [],
      entryClosure: entryRefs,
      expectedPointerRevision: pointer?.pointerRevision ?? 0,
    });
    if (committed.outcome === "conflict" || committed.outcome === "unknown") {
      throw new SyncProtocolError("GENERATION_MISMATCH", { message: "baseline generation commit failed" });
    }
    return committed.currentGeneration;
  } finally {
    await input.store.releaseWriter?.(lease);
  }
}
