// packages/chat-channel/src/__tests__/sync-writer-lease-takeover.test.ts
// 单写者租约的接管语义：第二写者取得新 epoch 后，旧写者的下一次写入必须被明确拒绝且不落库。
//
// 断言跑在真实 `MemoryProjectionStore` 上（租约、epoch fencing 与已提交前沿都是存储契约）；
// scope-runtime 用例验证编排层把存储的 SCOPE_BUSY 收敛为 LEASE_EXPIRED，live-writer 用例验证
// 旧 epoch 的续租在提交前失败，两种入口都不能把旧写者的数据写进已提交边界。

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { type Clock, deterministicRandomSource, sha256Digest } from "../sync/clock";
import {
  createLiveWriter,
  LIVE_WRITER_LEASE_TTL_MS,
  type LiveInput,
  type LiveRecordValue,
  type LiveWriter,
} from "../sync/live/live-writer";
import type { RotationControllerOptions } from "../sync/live/rotation";
import { RUNTIME_DOC_LIMITS } from "../sync/live/runtime-doc";
import { SyncProtocolError } from "../sync/protocol/errors";
import { buildDocId, type DocKind, type SyncScope, scopeKey } from "../sync/protocol/identity";
import { resolveSyncRuntimeConfig, type SyncRuntimeConfig } from "../sync/runtime/config";
import type { SyncIngressEvent } from "../sync/runtime/ingress";
import { createSyncScopeRuntime, type SyncScopeRuntime } from "../sync/runtime/scope-runtime";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { GenerationEntryRefs, SyncDocRecord, SyncGenerationRecord } from "../sync/store/types";

const SCOPE: SyncScope = { organizationId: "org-lease", rcsSessionId: "session-lease" };
const SCOPE_KEY = scopeKey(SCOPE);
const GENERATION = "gen-lease-1";
const LIFECYCLE = { sealGraceMs: 100, retireGraceMs: 100 } as const;
const BOOTSTRAP_TTL_MS = 5_000;
const CONTENT_DOC = docIdFor("content", "content");
const RUNTIME_DOC = docIdFor("runtime", "runtime");
const TEXT_DECODER = new TextDecoder();
const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class TestClock implements Clock {
  private current = 1_000;

  now(): number {
    return this.current;
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

function docIdFor(kind: DocKind, nonce: string): string {
  return buildDocId({ kind, generation: GENERATION, blockIndex: 0, nonce });
}

function emptyState(): Uint8Array {
  return Y.encodeStateAsUpdate(new Y.Doc());
}

function docRecord(docId: string, kind: DocKind): SyncDocRecord {
  const snapshot = emptyState();
  return {
    scopeKey: SCOPE_KEY,
    generation: GENERATION,
    docId,
    kind,
    state: "active",
    snapshot,
    hash: sha256Digest(snapshot),
    baseSeq: 0,
    finalSeq: null,
    blockIndex: 0,
    ordinalStart: null,
    ordinalEnd: null,
    dependsOn: [],
  };
}

/**
 * 建一个有已提交代次的作用域：先由引导租约登记代次与两个基础文档，随后让租约过期，
 * 使被测写者能以新 epoch 取得写权（存储不提供主动释放以外的让位方式）。
 */
async function seed(store: MemoryProjectionStore, time: TestClock): Promise<void> {
  const entryRefs: GenerationEntryRefs = {
    controlDocId: docIdFor("control", "control"),
    directoryDocId: docIdFor("directory", "directory"),
    runtimeDocId: RUNTIME_DOC,
    contentDocIds: [CONTENT_DOC],
  };
  const lease = await store.acquireWriter(SCOPE_KEY, "bootstrap", BOOTSTRAP_TTL_MS);
  const generation: SyncGenerationRecord = {
    scopeKey: SCOPE_KEY,
    generation: GENERATION,
    acpSessionId: "acp-lease",
    loadId: "load-lease",
    state: "staging",
    importEndOrdinal: null,
    entryRefs,
    createdAt: time.now(),
  };
  await store.createGeneration({ scopeKey: SCOPE_KEY, epoch: lease.epoch, generation });
  await store.commitGeneration({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    newGeneration: generation,
    entryClosure: entryRefs,
    expectedCurrent: null,
    expectedPointerRevision: 0,
    retired: [],
  });
  await store.createDoc({ scopeKey: SCOPE_KEY, epoch: lease.epoch, doc: docRecord(CONTENT_DOC, "content") });
  await store.createDoc({ scopeKey: SCOPE_KEY, epoch: lease.epoch, doc: docRecord(RUNTIME_DOC, "runtime") });
  time.advance(BOOTSTRAP_TTL_MS + 1);
}

/** 从已提交状态重建内容块并按记录顺序取正文：不读写者内存，只读已提交字节。 */
function committedTexts(store: MemoryProjectionStore, docId: string): string[] {
  const snapshot = store.exportCommittedState();
  const stored = snapshot.docs.find((doc) => doc.docId === docId);
  if (stored === undefined) return [];
  const ydoc = new Y.Doc({ guid: docId });
  Y.applyUpdate(ydoc, stored.baseSnapshot);
  for (const update of snapshot.updates) {
    if (update.docId === docId) Y.applyUpdate(ydoc, update.bytes);
  }
  const records = ydoc.getMap<unknown>("root").get("records");
  const texts =
    records instanceof Y.Array
      ? (records.toArray() as LiveRecordValue[]).map((record) => TEXT_DECODER.decode(record.payload))
      : [];
  ydoc.destroy();
  return texts;
}

function runtimeConfig(time: TestClock, seedValue: string, spoolRootDir: string): SyncRuntimeConfig {
  return resolveSyncRuntimeConfig({
    clock: time,
    random: deterministicRandomSource(seedValue),
    lifecycle: LIFECYCLE,
    merge: { maxBytes: 1 },
    spoolRootDir,
  });
}

function createStore(time: TestClock, config: SyncRuntimeConfig): MemoryProjectionStore {
  return new MemoryProjectionStore({
    clock: time,
    digest: sha256Digest,
    capacity: config.capacity,
    lifecycle: LIFECYCLE,
  });
}

function textEvent(delta: string, turnId: string): SyncIngressEvent {
  return {
    kind: "text-delta",
    turnId,
    entryId: `${turnId}:assistant`,
    contentSlot: "text",
    contentType: "text/plain",
    delta,
  };
}

function textDelta(entryId: string, delta: string): LiveInput {
  return {
    turnId: "turn-1",
    entryId,
    contentSlot: "text",
    contentType: "text/plain",
    kind: "text-delta",
    delta,
  };
}

function semantic(kind: "tool", entityId: string): LiveInput {
  return {
    turnId: "turn-1",
    entryId: "turn-1",
    contentSlot: "text",
    contentType: "text/plain",
    kind: "semantic",
    semantic: { kind, payload: { entityId } },
  };
}

function newWriter(time: TestClock, store: MemoryProjectionStore, seedValue: string): LiveWriter {
  const rotation: RotationControllerOptions = {
    clock: time,
    random: deterministicRandomSource(`${seedValue}-rotation`),
    limits: RUNTIME_DOC_LIMITS,
    maxResidentMs: 600_000,
    maxTransactions: 1_000,
  };
  return createLiveWriter({
    scope: SCOPE,
    store,
    clock: time,
    digest: sha256Digest,
    random: deterministicRandomSource(seedValue),
    capacity: DEFAULT_SYNC_CAPACITY,
    merge: { maxDelayMs: 600_000, maxBytes: 1 },
    limits: RUNTIME_DOC_LIMITS,
    rotation,
  });
}

function asProtocolError(error: unknown): SyncProtocolError {
  if (error instanceof SyncProtocolError) return error;
  throw error;
}

describe("第二写者接管", () => {
  // scope 运行时在续租失败后重新竞争：租约已被第二写者持有 → 旧写者收到 LEASE_EXPIRED，写入不落库。
  test("第二写者接管后旧运行时的写入被拒为 LEASE_EXPIRED", async () => {
    const time = new TestClock();
    const spoolRoot = mkdtempSync(join(tmpdir(), "sync-lease-takeover-"));
    tempRoots.push(spoolRoot);
    const firstConfig = runtimeConfig(time, "runtime-first", spoolRoot);
    const store = createStore(time, firstConfig);
    await seed(store, time);

    const first: SyncScopeRuntime = await createSyncScopeRuntime({
      scope: SCOPE,
      config: firstConfig,
      clock: time,
      digest: sha256Digest,
      random: deterministicRandomSource("runtime-first-writer"),
      store,
    });
    const second: SyncScopeRuntime = await createSyncScopeRuntime({
      scope: SCOPE,
      config: runtimeConfig(time, "runtime-second", spoolRoot),
      clock: time,
      digest: sha256Digest,
      random: deterministicRandomSource("runtime-second-writer"),
      store,
    });

    await first.acceptIngress(textEvent("from-first", "turn-first"));
    // 第一写者空闲超过租约 TTL，第二写者以新 epoch 接管。
    time.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
    await second.acceptIngress(textEvent("from-second", "turn-second"));

    const rejection = await first.acceptIngress(textEvent("stale", "turn-stale")).then(
      () => null,
      (error: unknown) => asProtocolError(error),
    );

    expect(rejection?.code).toBe("LEASE_EXPIRED");
    expect(committedTexts(store, CONTENT_DOC)).toEqual(["from-first", "from-second"]);
    await first.dispose();
    await second.dispose();
  });

  // 旧 epoch 的续租在提交前失败：写者拿不回写权，旧 epoch 的数据一个字节都不进已提交边界。
  test("第二写者接管后旧 epoch 的 live-writer 写入被拒", async () => {
    const time = new TestClock();
    const config = runtimeConfig(time, "live-writer-takeover", mkdtempSync(join(tmpdir(), "sync-live-takeover-")));
    tempRoots.push(config.spool.rootDir);
    const store = createStore(time, config);
    await seed(store, time);

    const first = newWriter(time, store, "writer-first");
    await first.acquire();
    await first.accept(textDelta("entry-first", "from-first"));
    await first.accept(semantic("tool", "tool-first"));

    time.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
    const second = newWriter(time, store, "writer-second");
    await second.acquire();
    await second.accept(textDelta("entry-second", "from-second"));
    await second.accept(semantic("tool", "tool-second"));

    const staleWrite = async (): Promise<void> => {
      await first.accept(textDelta("entry-stale", "stale"));
      await first.accept(semantic("tool", "tool-stale"));
    };
    const rejection = await staleWrite().then(
      () => null,
      (error: unknown) => asProtocolError(error),
    );

    expect(rejection?.code).toBe("LEASE_EXPIRED");
    expect(committedTexts(store, CONTENT_DOC)).toEqual(["from-first", "from-second"]);
    await first.close();
    await second.close();
  });
});
