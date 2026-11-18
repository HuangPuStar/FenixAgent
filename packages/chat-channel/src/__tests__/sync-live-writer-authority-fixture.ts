import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { createLiveWriter, type LiveInput } from "../sync/live/live-writer";
import { RUNTIME_DOC_LIMITS } from "../sync/live/runtime-doc";
import { buildDocId, scopeKey } from "../sync/protocol/identity";
import type { WriterLease } from "../sync/store/types";
import { fixture } from "./sync-live-admission-fixture";

/** 暂停真实 Store 边界；finally 释放后没有遗留事务。 */
export function gate() {
  let enter = () => {};
  let release = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { enter, release, entered, released };
}

/** 避免暂停点失配导致测试挂起。 */
export async function withinDeadline<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("writer did not reach controlled boundary")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 立即接住预期拒绝，受控异步窗口不产生未处理异常。 */
export function rejection(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => undefined,
    (error: unknown) => error,
  );
}

/** 用户消息重发必须按稳定 entry + 槽位判重。 */
export function text(entryId = "message"): LiveInput {
  return {
    kind: "text-delta",
    turnId: "turn",
    entryId,
    contentSlot: "text",
    contentType: "text/plain",
    delta: entryId,
    idempotent: true,
  };
}

/** 只定制合并阈值，租约、指针、提交和恢复均使用真实 Store。 */
export async function authorityFixture(options: { maxDelayMs?: number; maxBytes?: number } = {}) {
  const base = await fixture();
  await base.writer.close();
  let now = 1000;
  const clock = { now: () => now };
  let sequence = 0;
  const makeWriter = () =>
    createLiveWriter({
      scope: base.scope,
      store: base.store,
      clock,
      digest: sha256Digest,
      random: deterministicRandomSource(`authority-writer-${sequence++}`),
      capacity: DEFAULT_SYNC_CAPACITY,
      admission: base.admission,
      merge: { maxDelayMs: options.maxDelayMs ?? 600000, maxBytes: options.maxBytes ?? 1 },
      limits: RUNTIME_DOC_LIMITS,
      rotation: {
        clock,
        random: deterministicRandomSource(`authority-rotation-${sequence++}`),
        limits: RUNTIME_DOC_LIMITS,
        maxResidentMs: 600000,
        maxTransactions: 1000,
      },
    });
  const writer = makeWriter();
  await writer.acquire();
  return {
    ...base,
    writer,
    clock,
    makeWriter,
    advance(ms: number) {
      now += ms;
      base.advance(ms);
    },
    async close() {
      await writer.close();
      await base.close();
    },
  };
}

/** 用合法换代事务建立独立空投影，验证旧输入不得跨代次复活。 */
export async function replaceGeneration(f: Awaited<ReturnType<typeof authorityFixture>>, lease: WriterLease) {
  const key = scopeKey(f.scope);
  const pointer = await f.store.readScopePointer(key);
  if (!pointer?.currentGeneration) throw new Error("missing scope generation");
  const old = await f.store.readGeneration(key, pointer.currentGeneration);
  if (!old) throw new Error("missing current generation");
  const generation = "gen_replacement";
  const id = (kind: "control" | "directory" | "runtime" | "content") =>
    buildDocId({ kind, generation, blockIndex: 0, nonce: kind });
  const next = {
    ...old,
    generation,
    state: "staging" as const,
    entryRefs: {
      controlDocId: id("control"),
      directoryDocId: id("directory"),
      runtimeDocId: id("runtime"),
      contentDocIds: [id("content")],
    },
  };
  await f.store.createGeneration({ scopeKey: key, epoch: lease.epoch, generation: next });
  const doc = new Y.Doc();
  const snapshot = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  for (const kind of ["runtime", "content"] as const) {
    await f.store.createDoc({
      scopeKey: key,
      epoch: lease.epoch,
      doc: {
        scopeKey: key,
        generation,
        docId: id(kind),
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
      },
    });
  }
  await f.store.commitGeneration({
    scopeKey: key,
    epoch: lease.epoch,
    newGeneration: next,
    expectedCurrent: old.generation,
    expectedPointerRevision: pointer.pointerRevision,
    entryClosure: next.entryRefs,
    retired: [old.generation],
  });
}
