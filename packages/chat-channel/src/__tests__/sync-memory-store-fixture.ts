import { expect } from "bun:test";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { type Clock, sha256Digest } from "../sync/clock";
import { SyncProtocolError } from "../sync/protocol/errors";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { CreateDocInput, SyncDocRecord, SyncGenerationRecord, WriterLease } from "../sync/store/types";

/** 租约与退役测试共用的可推进时钟。 */
export class TestClock implements Clock {
  private current: number;

  constructor(current = 1_000) {
    this.current = current;
  }

  now(): number {
    return this.current;
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

/** 固定租户作用域用于观察隔离与fencing。 */
export const SCOPE = "org-1/session-1";
/** 小生命周期窗口让退役无需真实等待。 */
export const LIFECYCLE = { sealGraceMs: 100, retireGraceMs: 100 } as const;

/** 固定 clientID 使同值字节可独立比较，各输入仍是真实可合并的 Yjs 更新。 */
export function bytes(value: string): Uint8Array {
  const doc = new Y.Doc();
  try {
    doc.clientID = Number.parseInt(sha256Digest(new TextEncoder().encode(value)).slice(0, 8), 16);
    doc.getText("payload").insert(0, value);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

/** 创建使用真实容量和生命周期的内存适配器。 */
export function makeStore(clock: TestClock): MemoryProjectionStore {
  return new MemoryProjectionStore({
    clock,
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: LIFECYCLE,
  });
}

/** 构造尚未发布的独立代次登记。 */
export function generation(generationId = "gen-1", loadId = "load-1"): SyncGenerationRecord {
  return {
    scopeKey: SCOPE,
    generation: generationId,
    acpSessionId: "acp-session",
    loadId,
    state: "staging",
    importEndOrdinal: null,
    entryRefs: {
      controlDocId: `${generationId}-control`,
      directoryDocId: `${generationId}-directory`,
      runtimeDocId: `${generationId}-runtime`,
      contentDocIds: [],
    },
    createdAt: 1_000,
  };
}

/** 构造具备有效Yjs基线的活动文档。 */
export function makeDoc(
  generationId = "gen-1",
  docId = "doc-1",
  kind: SyncDocRecord["kind"] = "runtime",
): SyncDocRecord {
  const snapshot = bytes(`${docId}-snapshot`);
  return {
    scopeKey: SCOPE,
    generation: generationId,
    docId,
    kind,
    state: "active",
    snapshot,
    hash: sha256Digest(snapshot),
    baseSeq: 0,
    finalSeq: null,
    blockIndex: kind === "content" ? 0 : null,
    ordinalStart: kind === "content" ? 0 : null,
    ordinalEnd: kind === "content" ? 0 : null,
    dependsOn: [],
  };
}

/** 取得写权并登记测试代次。 */
export async function setupStore(): Promise<{ store: MemoryProjectionStore; clock: TestClock; lease: WriterLease }> {
  const clock = new TestClock();
  const store = makeStore(clock);
  const lease = await store.acquireWriter(SCOPE, "writer-a", 100);
  await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: generation() });
  return { store, clock, lease };
}

/** 通过真实存储入口登记测试文档。 */
export async function createDoc(store: MemoryProjectionStore, lease: WriterLease, doc = makeDoc()): Promise<void> {
  const input: CreateDocInput = { scopeKey: SCOPE, epoch: lease.epoch, doc };
  await store.createDoc(input);
}

/** 默认更新保留完整批次身份与前沿，可按拒绝场景覆盖。 */
export function appendInput(
  lease: WriterLease,
  overrides: Partial<Parameters<MemoryProjectionStore["appendUpdates"]>[0]> = {},
) {
  return {
    scopeKey: SCOPE,
    epoch: lease.epoch,
    owner: lease.owner,
    batchId: "batch-1",
    digest: "digest-1",
    expectedFrontiers: [{ docId: "doc-1", lastSeq: 0 }],
    updates: [{ docId: "doc-1", fromSeq: 1, bytes: bytes("update-1") }],
    ...overrides,
  };
}

/** 拒绝断言同时校验真实协议错误码。 */
export async function expectCode(action: Promise<unknown>, code: SyncProtocolError["code"]): Promise<void> {
  await expect(action).rejects.toMatchObject({ code });
}
