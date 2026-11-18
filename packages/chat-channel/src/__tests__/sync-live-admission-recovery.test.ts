import { expect, test } from "bun:test";
import * as Y from "yjs";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { loadCommittedDoc } from "../sync/live/committed-doc";
import { createLiveWriter, type LiveInput, type LiveRecordValue } from "../sync/live/live-writer";
import { createRuntimeDoc, RUNTIME_DOC_LIMITS } from "../sync/live/runtime-doc";
import { records } from "../sync/live/writer-support";
import { buildDocId, scopeKey } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { AppendUpdatesInput, SyncDocRecord } from "../sync/store/types";

/** 完整 Store、真实额度和真实 Yjs，只在存储边界注入读失败或回执丢失。 */
async function fixture() {
  const scope = { organizationId: "org_cursor", rcsSessionId: "rcs_cursor" };
  const key = scopeKey(scope);
  const generation = "gen_cursor";
  const clock = { now: () => 1000 };
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
  const store = new MemoryProjectionStore({
    clock,
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
    memoryBudget: admission,
  });
  const id = (kind: "control" | "directory" | "runtime" | "content") =>
    buildDocId({ kind, generation, blockIndex: 0, nonce: kind });
  const entryRefs = {
    controlDocId: id("control"),
    directoryDocId: id("directory"),
    runtimeDocId: id("runtime"),
    contentDocIds: [id("content")],
  };
  const lease = await store.acquireWriter(key, "bootstrap", 1000);
  const row = {
    scopeKey: key,
    generation,
    acpSessionId: "ses_cursor",
    loadId: "load",
    state: "staging" as const,
    importEndOrdinal: null,
    createdAt: 1000,
    entryRefs,
  };
  await store.createGeneration({ scopeKey: key, epoch: lease.epoch, generation: row });
  await store.commitGeneration({
    scopeKey: key,
    epoch: lease.epoch,
    newGeneration: row,
    entryClosure: entryRefs,
    expectedCurrent: null,
    expectedPointerRevision: 0,
    retired: [],
  });
  for (const kind of ["runtime", "content"] as const) {
    const doc = new Y.Doc();
    const snapshot = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    const record: SyncDocRecord = {
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
    };
    await store.createDoc({ scopeKey: key, epoch: lease.epoch, doc: record });
  }
  await store.releaseWriter(lease);
  const faults = { failReads: false, throwAfterWrite: false, appendCalls: 0, writeError: null as unknown };
  const readError = new Error("reload unavailable");
  const replyError = new Error("commit reply lost");
  const wrapped = new Proxy(store, {
    get(target, property) {
      if (property === "readDocStateAt")
        return (...args: Parameters<MemoryProjectionStore["readDocStateAt"]>) =>
          faults.failReads ? Promise.reject(readError) : target.readDocStateAt(...args);
      if (property === "appendUpdates")
        return async (input: AppendUpdatesInput) => {
          faults.appendCalls++;
          try {
            const result = await target.appendUpdates(input);
            if (faults.throwAfterWrite) {
              faults.throwAfterWrite = false;
              throw replyError;
            }
            return result;
          } catch (error) {
            faults.writeError = error;
            throw error;
          }
        };
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const writer = createLiveWriter({
    scope,
    store: wrapped,
    clock,
    digest: sha256Digest,
    random: deterministicRandomSource("cursor"),
    capacity: DEFAULT_SYNC_CAPACITY,
    admission,
    merge: { maxDelayMs: 600000, maxBytes: 1 << 20 },
    limits: RUNTIME_DOC_LIMITS,
    rotation: {
      clock,
      random: deterministicRandomSource("rotate"),
      limits: RUNTIME_DOC_LIMITS,
      maxResidentMs: 600000,
      maxTransactions: 1000,
    },
  });
  await writer.acquire();
  const read = async () => {
    const committed = await loadCommittedDoc(store, id("content"));
    if (!committed) throw new Error("Missing committed content");
    try {
      return records<LiveRecordValue>(committed.doc)?.toArray() ?? [];
    } finally {
      committed.doc.destroy();
    }
  };
  return {
    store,
    writer,
    admission,
    faults,
    replyError,
    read,
    contentId: id("content"),
    runtimeId: id("runtime"),
    async close() {
      await writer.close();
      store.dispose();
    },
  };
}

/** 小对象直接落内容块，能够观察拒绝后的 Yjs 依赖是否被污染。 */
function object(value: string): LiveInput {
  return {
    kind: "content-object",
    turnId: "turn",
    entryId: value,
    contentSlot: "object",
    contentType: "application/json",
    object: { value: { value }, meta: { kind: "history_object", entryId: value } },
  };
}
const payload = (record: LiveRecordValue) => JSON.parse(new TextDecoder().decode(record.payload));

// 已提交前缀必须保留，拒绝记录不能污染下一次 update 的 Yjs 依赖。
test("额度拒绝后继续写入仍能从已提交字节完整重建", async () => {
  const f = await fixture();
  await f.writer.accept(object("before"));
  const hold = f.admission.reserve("hotDocLive", f.admission.available("hotDocLive"));
  try {
    await expect(f.writer.accept(object("rejected"))).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    expect((await f.read()).map(payload)).toEqual([{ value: "before" }]);
    hold.release();
    await f.writer.accept(object("after"));
    expect((await f.read()).map(payload)).toEqual([{ value: "before" }, { value: "after" }]);
  } finally {
    hold.release();
    await f.close();
  }
});

// 同一批修改正文和 runtime 时必须一起恢复，工具边界的去重声明也不能吞掉重试。
test("多文档语义批次拒绝后重试保留工具边界与实体", async () => {
  const f = await fixture();
  const input: LiveInput = {
    kind: "semantic",
    turnId: "turn",
    entryId: "tool-entry",
    contentSlot: "tool",
    contentType: "application/json",
    semantic: {
      kind: "tool",
      payload: {
        entityId: "tool-one",
        toolCallId: "tool-one",
        boundary: true,
        boundaryOrdinal: 0,
        metadata: { title: "tool" },
      },
    },
  };
  const hold = f.admission.reserve("hotDocLive", f.admission.available("hotDocLive"));
  try {
    await expect(f.writer.accept(input)).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    hold.release();
    await f.writer.accept(input);
    expect((await f.read()).filter((record) => record.kind === "tool_boundary")).toHaveLength(1);
    const committed = await loadCommittedDoc(f.store, f.runtimeId);
    if (!committed) throw new Error("Missing committed runtime");
    try {
      expect(createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS, committed.doc).entityCount()).toBe(1);
    } finally {
      committed.doc.destroy();
    }
  } finally {
    hold.release();
    await f.close();
  }
});

// 回滚读取也失败时必须停写，既保留原始拒绝，又禁止使用尚未恢复的游标再次提交。
test("重载失败保留原始写入错误并阻止后续写入", async () => {
  const f = await fixture();
  const hold = f.admission.reserve("hotDocLive", f.admission.available("hotDocLive"));
  try {
    f.faults.failReads = true;
    let error: unknown;
    try {
      await f.writer.accept(object("rejected"));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBe(f.faults.writeError);
    expect(error).toMatchObject({ code: "ADMISSION_REJECTED" });
    hold.release();
    const calls = f.faults.appendCalls;
    await expect(f.writer.accept(object("after"))).rejects.toBeInstanceOf(Error);
    expect(f.faults.appendCalls).toBe(calls);
  } finally {
    hold.release();
    await f.close();
  }
});

// 存储已成功但回执丢失时，重载必须包括连续 tail，不能退回旧 base 丢掉已提交前缀。
test("回执丢失后从权威前沿重载并继续写入", async () => {
  const f = await fixture();
  try {
    f.faults.throwAfterWrite = true;
    await expect(f.writer.accept(object("committed"))).rejects.toBe(f.replyError);
    await f.writer.accept(object("after"));
    expect((await f.read()).map(payload)).toEqual([{ value: "committed" }, { value: "after" }]);
  } finally {
    await f.close();
  }
});

// 公开固定批次入口也会先修改游标，不能绕过与普通接收路径相同的拒绝恢复。
test("固定批次提交拒绝后不污染下一次对象写入", async () => {
  const f = await fixture();
  const uncommitted = new Y.Doc({ guid: f.contentId });
  records(uncommitted, [
    {
      recordId: "rejected",
      entryId: "rejected",
      kind: "history_object",
      contentSlot: "object",
      contentType: "application/json",
      partIndex: 0,
      payload: new TextEncoder().encode("{}"),
    },
  ]);
  const update = Y.encodeStateAsUpdate(uncommitted);
  uncommitted.destroy();
  const hold = f.admission.reserve("hotDocLive", f.admission.available("hotDocLive"));
  try {
    await expect(
      f.writer.commit({
        batchId: "batch_rejected",
        docId: f.contentId,
        ordinalStart: 1,
        ordinalEnd: 1,
        payload: update,
        digest: sha256Digest(update),
      }),
    ).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    hold.release();
    await f.writer.accept(object("after"));
    expect((await f.read()).map(payload)).toEqual([{ value: "after" }]);
  } finally {
    hold.release();
    await f.close();
  }
});

// 内容 successor 尚未进入目录时必须停写，不能确认客户端永远发现不了的新内容。
test("轮换目录登记被拒绝后禁止继续写入 successor", async () => {
  const f = await fixture();
  await f.writer.accept(object("before"));
  const hold = f.admission.reserve("hotDocLive", f.admission.available("hotDocLive"));
  try {
    await expect(f.writer.seal()).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    hold.release();
    const calls = f.faults.appendCalls;
    await expect(f.writer.accept(object("invisible"))).rejects.toBeInstanceOf(Error);
    expect(f.faults.appendCalls).toBe(calls);
    expect((await f.read()).map(payload)).toEqual([{ value: "before" }]);
  } finally {
    hold.release();
    await f.close();
  }
});

// 搬运失败后的空 successor 不能冒充已恢复状态，否则未结束的已提交实体会消失。
test("runtime 实体搬运被拒绝后禁止继续写入空 successor", async () => {
  const f = await fixture();
  const input: LiveInput = {
    kind: "semantic",
    turnId: "turn",
    entryId: "tool-entry",
    contentSlot: "tool",
    contentType: "application/json",
    semantic: { kind: "tool", payload: { entityId: "tool-one", metadata: { title: "tool" } } },
  };
  await f.writer.accept(input);
  const hold = f.admission.reserve("hotDocLive", f.admission.available("hotDocLive"));
  try {
    await expect(f.writer.rotateRuntime()).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    hold.release();
    const calls = f.faults.appendCalls;
    await expect(
      f.writer.accept({ ...input, semantic: { kind: "error", payload: { entityId: "error-two", metadata: {} } } }),
    ).rejects.toBeInstanceOf(Error);
    expect(f.faults.appendCalls).toBe(calls);
    const committed = await loadCommittedDoc(f.store, f.runtimeId);
    if (!committed) throw new Error("Missing old runtime");
    try {
      expect(
        createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS, committed.doc)
          .exportForRotation()
          .map((entity) => entity.entityId),
      ).toEqual(["tool-one"]);
    } finally {
      committed.doc.destroy();
    }
  } finally {
    hold.release();
    await f.close();
  }
});
