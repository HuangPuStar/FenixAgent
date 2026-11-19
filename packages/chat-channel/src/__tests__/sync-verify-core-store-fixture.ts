// packages/chat-channel/src/__tests__/sync-verify-core.test.ts
// 对抗式验证用例：不确认实现「大致正确」，而是逐条攻击设计 §4.1 / §8.3 / §9.2 / §10.1 与规格 §3~§4 的断言。
//
// 三条纪律：
// 1. 每个用例只针对一条具体断言，输入取边界值（精确字节数、多字节字符、超限标识、畸形 profile）而不是典型值；
// 2. 断言按设计原文的**最严格读法**写，发现实现达不到就保留失败并用「缺陷复现（待修复）」标注，不放宽断言；
// 3. 失败清单与可疑点写进交付报告，`file:line` 指向实现而非测试。

import { expect } from "bun:test";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { type Clock, sha256Digest } from "../sync/clock";
import { type SyncErrorCode, SyncProtocolError } from "../sync/protocol/errors";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type {
  AppendUpdatesInput,
  SyncDocRecord,
  SyncGenerationRecord,
  SyncRefRecord,
  WriterLease,
} from "../sync/store/types";

import { bytes as bytesOf } from "./sync-memory-store-fixture";

export { bytesOf };

/** 异步版：拒绝且错误码一致；正常返回（含返回错误结果对象）一律判失败。 */
export async function expectRejectCode(action: Promise<unknown>, code: SyncErrorCode): Promise<void> {
  const settled = await action.then(
    () => null,
    (error: unknown) => error,
  );
  expect(settled).toBeInstanceOf(SyncProtocolError);
  expect((settled as SyncProtocolError).code).toBe(code);
}

/** 固定作用域使租户隔离断言独立于Doc命名。 */
export const SCOPE = "org-verify/rcs-verify";
/** 第二租户作用域用于拒绝越界写入。 */
export const OTHER_SCOPE = "org-other/rcs-other";
const LIFECYCLE = { sealGraceMs: 100, retireGraceMs: 100 } as const;

/** 可推进时钟使fencing与生命周期边界无需真实等待。 */
export class TestClock implements Clock {
  private current = 1_000;

  now(): number {
    return this.current;
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}

/** 创建使用真实容量与生命周期的内存存储。 */
export function makeStore(clock: Clock): MemoryProjectionStore {
  return new MemoryProjectionStore({
    clock,
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: LIFECYCLE,
  });
}

/** 构造独立的staging代次。 */
export function generationRecord(generation: string, scopeKey = SCOPE): SyncGenerationRecord {
  return {
    scopeKey,
    generation,
    acpSessionId: "acp-session",
    loadId: `load-${generation}`,
    state: "staging",
    importEndOrdinal: null,
    entryRefs: {
      controlDocId: `${generation}-control`,
      directoryDocId: `${generation}-directory`,
      runtimeDocId: `${generation}-runtime`,
      contentDocIds: [],
    },
    createdAt: 1_000,
  };
}

/** 文档基线使用可真实合并的Yjs字节。 */
export function docRecord(docId: string, generation = "gen-1", scopeKey = SCOPE): SyncDocRecord {
  const snapshot = bytesOf(`${docId}-snapshot`);
  return {
    scopeKey,
    generation,
    docId,
    kind: "runtime",
    state: "active",
    snapshot,
    hash: sha256Digest(snapshot),
    baseSeq: 0,
    finalSeq: null,
    blockIndex: null,
    ordinalStart: null,
    ordinalEnd: null,
    dependsOn: [],
  };
}

/** 构造可逐字段攻击的资源定位引用。 */
export function refRecord(overrides: Partial<SyncRefRecord> = {}): SyncRefRecord {
  return {
    scopeKey: SCOPE,
    generation: "gen-1",
    lookupKind: "entry",
    lookupId: "entry-1",
    contentSlot: 0,
    partIndex: 0,
    docId: "doc-1",
    recordId: "record-1",
    orderStart: 0,
    orderEnd: 1,
    byteStart: 0,
    byteEnd: 1,
    ...overrides,
  };
}

/** 取得写权并登记代次，不预先提交待测写入。 */
export async function setup(): Promise<{ store: MemoryProjectionStore; clock: TestClock; lease: WriterLease }> {
  const clock = new TestClock();
  const store = makeStore(clock);
  const lease = await store.acquireWriter(SCOPE, "writer-a", 100);
  await store.createGeneration({ scopeKey: SCOPE, epoch: lease.epoch, generation: generationRecord("gen-1") });
  return { store, clock, lease };
}

/** 通过正式存储原语登记文档。 */
export async function registerDoc(store: MemoryProjectionStore, lease: WriterLease, docId: string): Promise<void> {
  await store.createDoc({ scopeKey: SCOPE, epoch: lease.epoch, doc: docRecord(docId) });
}

/** 固定批次身份和起始前沿，异常场景只覆盖必要字段。 */
export function appendInput(lease: WriterLease, overrides: Partial<AppendUpdatesInput> = {}): AppendUpdatesInput {
  return {
    scopeKey: SCOPE,
    epoch: lease.epoch,
    owner: lease.owner,
    batchId: "batch-1",
    digest: "digest-1",
    expectedFrontiers: [{ docId: "doc-1", lastSeq: 0 }],
    updates: [{ docId: "doc-1", fromSeq: 1, bytes: bytesOf("update-1") }],
    ...overrides,
  };
}
