import { expect, spyOn, test } from "bun:test";
import * as Y from "yjs";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { sha256Digest } from "../sync/clock";
import { readTextClaimDoc } from "../sync/live/text-claim-read";
import { SyncProtocolError } from "../sync/protocol/errors";
import { MAX_DOC_SNAPSHOT_BYTES } from "../sync/protocol/frames";
import { scopeKey } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { DocStateSnapshot, SyncUpdateRecord } from "../sync/store/types";
import { authorityFixture, gate, rejection, withinDeadline } from "./sync-live-writer-authority-fixture";

/** 保留真实预算和解码器，只在 Store 的有界读取出口控制字节和异步次序。 */
function fixture() {
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
  const store = new MemoryProjectionStore({
    clock: { now: () => 1000 },
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
  });
  return {
    admission,
    store,
    read<T>(consume: (doc: Y.Doc, lastSeq: number) => T, assertCurrent = () => {}) {
      return readTextClaimDoc({ admission, store, docId: "claim-body", consume, assertCurrent });
    },
    close() {
      store.dispose();
    },
  };
}

/** canonical 与单条 tail 使用同一字节边界，不向解码器提供未受限数据。 */
function base(snapshot: Uint8Array): DocStateSnapshot {
  return { docId: "claim-body", snapshot, hash: sha256Digest(snapshot), baseSeq: 0, lastSeq: 0 };
}

/** 构造一条真正连续的更新；空 scope 仅是只读出口的测试元数据。 */
function tail(bytes: Uint8Array, updateSeq = 1): SyncUpdateRecord {
  return {
    docId: "claim-body",
    scopeKey: "claim/scope",
    generation: "claim",
    updateSeq,
    bytes,
    batchId: "batch",
    digest: sha256Digest(bytes),
  };
}

// 元数据池拒绝发生在正文已经预留之后，也必须在任何 Store 读取之前归还这部分额度。
test("controlIndex 预留失败时零读取且归还已取得的热池额度", async () => {
  const f = fixture();
  let reads = 0;
  f.store.readDocStateAt = async () => {
    reads++;
    return null;
  };
  const hold = f.admission.reserve("controlIndex", f.admission.available("controlIndex"));
  try {
    await expect(f.read(() => true)).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    expect(reads).toBe(0);
    expect(f.admission.used("hotDocLive")).toBe(0);
    hold.release();
    expect(await f.read(() => true)).toBeNull();
    expect(reads).toBe(1);
    expect(f.admission.used("controlIndex")).toBe(0);
  } finally {
    hold.release();
    f.close();
  }
});

for (const stage of ["base", "tail", "consume"] as const) {
  // canonical、tail、消费回调失败都必须保留原异常，并在所有出口销毁临时正文和归还两池额度。
  test(`${stage} 原始读取异常不泄漏正文临时额度`, async () => {
    const f = fixture();
    const doc = new Y.Doc(),
      snapshot = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    const failure = new Error(`${stage} unavailable`);
    f.store.readDocStateAt = async () => {
      if (stage === "base") throw failure;
      return base(snapshot);
    };
    f.store.readUpdatesAfter = async () => {
      if (stage === "tail") throw failure;
      return [];
    };
    try {
      await expect(
        f.read(() => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(f.admission.used("hotDocLive")).toBe(0);
      expect(f.admission.used("controlIndex")).toBe(0);
    } finally {
      f.close();
    }
  });
}

// 等待旧读取时预算仍应保护在途字节；生命周期失效后不能解码或返回旧结果，结清即归还。
test("reset 后迟到的 canonical 回执不进入消费且释放临时额度", async () => {
  const f = fixture(),
    paused = gate();
  const empty = new Y.Doc(),
    snapshot = Y.encodeStateAsUpdate(empty);
  empty.destroy();
  let current = true,
    consumed = false;
  f.store.readDocStateAt = async () => {
    paused.enter();
    await paused.released;
    return base(snapshot);
  };
  const pending = rejection(
    f.read(
      () => {
        consumed = true;
        return true;
      },
      () => {
        if (!current) throw new SyncProtocolError("GENERATION_MISMATCH");
      },
    ),
  );
  try {
    await withinDeadline(paused.entered);
    expect(f.admission.used("hotDocLive")).toBeGreaterThan(0);
    current = false;
    paused.release();
    expect(await pending).toMatchObject({ code: "GENERATION_MISMATCH" });
    expect(consumed).toBe(false);
    expect(f.admission.used("hotDocLive")).toBe(0);
    expect(f.admission.used("controlIndex")).toBe(0);
  } finally {
    paused.release();
    await pending;
    f.close();
  }
});

// 四个解码峰值可并行占用默认热池，第五个必须在进入 Store 前拒绝，避免无界 pending key 放大内存。
test("并发 claim 正文读取自然受共享热池上限限制", async () => {
  const f = fixture(),
    paused = gate();
  const empty = new Y.Doc(),
    snapshot = Y.encodeStateAsUpdate(empty);
  empty.destroy();
  let reads = 0;
  f.store.readDocStateAt = async () => {
    reads++;
    await paused.released;
    return base(snapshot);
  };
  const pending = Array.from({ length: 4 }, () => rejection(f.read(() => true)));
  try {
    expect(reads).toBe(4);
    await expect(f.read(() => true)).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    expect(reads).toBe(4);
    paused.release();
    expect(await Promise.all(pending)).toEqual([undefined, undefined, undefined, undefined]);
    expect(f.admission.used("hotDocLive")).toBe(0);
    expect(f.admission.used("controlIndex")).toBe(0);
  } finally {
    paused.release();
    await Promise.all(pending);
    f.close();
  }
});

for (const stage of ["base", "tail"] as const) {
  // Store 不能把超协议原始字节交给 Yjs；拒绝仍须释放已取得的临时预算。
  test(`${stage} 单条原始字节超限时明确拒绝且不消费正文`, async () => {
    const f = fixture();
    const empty = new Y.Doc(),
      snapshot = Y.encodeStateAsUpdate(empty);
    empty.destroy();
    const oversized = new Uint8Array(MAX_DOC_SNAPSHOT_BYTES + 1);
    let consumed = false;
    f.store.readDocStateAt = async () => base(stage === "base" ? oversized : snapshot);
    f.store.readUpdatesAfter = async () => [tail(oversized)];
    try {
      await expect(
        f.read(() => {
          consumed = true;
        }),
      ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
      expect(consumed).toBe(false);
      expect(f.admission.used("hotDocLive")).toBe(0);
      expect(f.admission.used("controlIndex")).toBe(0);
    } finally {
      f.close();
    }
  });
}

// 每页只取一条更新，防止 256 个传输上限更新在复制阶段同时驻留。
test("canonical 加连续 tail 逐条读取并返回真实已提交文本", async () => {
  const f = fixture(),
    doc = new Y.Doc();
  doc.getText("text").insert(0, "prefix");
  const snapshot = Y.encodeStateAsUpdate(doc),
    vector = Y.encodeStateVector(doc);
  doc.getText("text").insert(6, "-tail");
  const update = Y.encodeStateAsUpdate(doc, vector);
  doc.destroy();
  const limits: number[] = [];
  f.store.readDocStateAt = async () => base(snapshot);
  f.store.readUpdatesAfter = async (_docId, seq, limit) => {
    limits.push(limit);
    return seq === 0 ? [tail(update)] : [];
  };
  try {
    expect(await f.read((value, seq) => ({ text: value.getText("text").toString(), seq }))).toEqual({
      text: "prefix-tail",
      seq: 1,
    });
    expect(limits).toEqual([1, 1]);
    expect(f.admission.used("hotDocLive")).toBe(0);
    expect(f.admission.used("controlIndex")).toBe(0);
  } finally {
    f.close();
  }
});

// 单个更新合法也可能使累积 Doc 超限，须在解码预算内检查最终编码并明确拒绝。
test("canonical 与 tail 各自合规但累积正文超限时拒绝", async () => {
  const f = fixture(),
    doc = new Y.Doc();
  doc.getText("text").insert(0, "a".repeat(150000));
  const snapshot = Y.encodeStateAsUpdate(doc),
    vector = Y.encodeStateVector(doc);
  doc.getText("text").insert(150000, "b".repeat(150000));
  const update = Y.encodeStateAsUpdate(doc, vector);
  doc.destroy();
  f.store.readDocStateAt = async () => base(snapshot);
  f.store.readUpdatesAfter = async () => [tail(update)];
  try {
    await expect(f.read(() => true)).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
    expect(f.admission.used("hotDocLive")).toBe(0);
    expect(f.admission.used("controlIndex")).toBe(0);
  } finally {
    f.close();
  }
});

// 同字节重放与删除可使合法账本累计超过传输上限；读取必须按实际 canonical 大小判定。
test("重复更新与删除形成的大账本仍可读取小于上限的已提交正文", async () => {
  const f = await authorityFixture();
  const source = new Y.Doc();
  try {
    const key = scopeKey(f.scope),
      pointer = await f.store.readScopePointer(key);
    if (!pointer?.writerOwner) throw new Error("Missing active writer authority");
    source.getText("large").insert(0, "x".repeat(150000));
    const original = Y.encodeStateAsUpdate(source),
      vector = Y.encodeStateVector(source);
    source.getText("large").delete(0, 150000);
    const deleted = Y.encodeStateAsUpdate(source, vector);
    const updates = [original, original, deleted];
    expect(updates.reduce((sum, update) => sum + update.byteLength, 0)).toBeGreaterThan(MAX_DOC_SNAPSHOT_BYTES);
    for (const [index, bytes] of updates.entries()) {
      const result = await f.store.appendUpdates({
        scopeKey: key,
        epoch: pointer.writerEpoch,
        owner: pointer.writerOwner,
        batchId: `repeated-update-${index}`,
        digest: sha256Digest(bytes),
        expectedFrontiers: [{ docId: f.contentId, lastSeq: index }],
        updates: [{ docId: f.contentId, fromSeq: index + 1, bytes }],
      });
      expect(result.outcome).toBe("committed");
    }
    const before = f.admission.used("hotDocLive");
    expect(
      await readTextClaimDoc({
        store: f.store,
        admission: f.admission,
        docId: f.contentId,
        assertCurrent: () => {},
        consume(doc, seq) {
          return { text: doc.getText("large").toString(), seq, encodedBytes: Y.encodeStateAsUpdate(doc).byteLength };
        },
      }),
    ).toEqual({ text: "", seq: 3, encodedBytes: Y.encodeStateAsUpdate(source).byteLength });
    expect(f.admission.used("hotDocLive")).toBe(before);
  } finally {
    source.destroy();
    await f.close();
  }
});

// 小更新的编码字节和已证明不越限时，无需对每个前缀重新编码整 Doc，避免 tail 长度导致平方工作量。
test("连续小 tail 以保守字节上界验证而不反复编码全文", async () => {
  const f = fixture(),
    source = new Y.Doc();
  const snapshot = Y.encodeStateAsUpdate(source);
  const updates: Uint8Array[] = [];
  for (let index = 0; index < 200; index++) {
    const vector = Y.encodeStateVector(source);
    source.getText("text").insert(index, "x");
    updates.push(Y.encodeStateAsUpdate(source, vector));
  }
  source.destroy();
  f.store.readDocStateAt = async () => base(snapshot);
  f.store.readUpdatesAfter = async (_docId, seq) => (updates[seq] ? [tail(updates[seq]!, seq + 1)] : []);
  const encode = spyOn(Y, "encodeStateAsUpdate");
  try {
    expect(await f.read((doc) => doc.getText("text").toString())).toBe("x".repeat(200));
    expect(encode).not.toHaveBeenCalled();
    expect(f.admission.used("hotDocLive")).toBe(0);
    expect(f.admission.used("controlIndex")).toBe(0);
  } finally {
    encode.mockRestore();
    f.close();
  }
});
