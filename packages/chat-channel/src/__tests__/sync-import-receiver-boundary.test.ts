import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { sha256Digest } from "../sync/clock";
import { HistoryImportReceiver, type HistoryInputRecord } from "../sync/history/import-receiver";
import { HistoryIngest } from "../sync/history/ingest";
import { AdmittedHistoryPayload, admitHistoryObject } from "../sync/history/object-admission";
import { HistorySpool } from "../sync/history/spool";

/** 用真实暂存与计费验证 await 两侧的接收状态。 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "receiver-boundary-"));
  const capacity = {
    ...DEFAULT_SYNC_CAPACITY,
    inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, historyBlockTargetPayloadBytes: 4096 },
  };
  const admission = new AdmissionController(capacity);
  const clock = { now: () => 1000 };
  const spool = new HistorySpool(
    { basePath: root, segmentBytes: 65536, taskQuotaBytes: 8 * 1024 * 1024, processQuotaBytes: 8 * 1024 * 1024 },
    clock,
  );
  const ingest = new HistoryIngest({ spool, clock, digest: sha256Digest, capacity, admission });
  await ingest.begin({ scopeKey: "scope", generation: "generation", loadId: "load" });
  const accepted: number[] = [];
  const receiver = new HistoryImportReceiver({
    ingest,
    capacity,
    admission,
    digest: sha256Digest,
    onAccepted(record) {
      accepted.push(record.sourceOrdinal);
    },
  });
  return {
    capacity,
    admission,
    ingest,
    receiver,
    accepted,
    async close() {
      await spool.completeTask("load");
      await rm(root, { recursive: true, force: true });
    },
  };
}

// 批次 flush 暂停期间源替换字符串，已接纳的字节仍须对应同一个原始值。
test("flush await 前后的分片与接纳值保持一致", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const batch = f.ingest.acceptAdmittedBatch.bind(f.ingest);
  const gate = spyOn(f.ingest, "acceptAdmittedBatch").mockImplementation(async (pending) => {
    entered.resolve();
    await resume.promise;
    return batch(pending);
  });
  const original = "original-".repeat(2000);
  const mutable: HistoryInputRecord = { value: original, meta: { kind: "text_part", entryId: "large" } };
  const receiving = f.receiver.acceptRecords([{ value: "pending", meta: { kind: "history_object" } }, mutable]);
  try {
    await entered.promise;
    mutable.value = "replacement-".repeat(3000);
    resume.resolve();
    await receiving;
    const records = await f.ingest.readRecords(f.accepted);
    expect(
      records
        .slice(1)
        .map((bytes) => JSON.parse(new TextDecoder().decode(bytes)))
        .join(""),
    ).toBe(original);
    expect(f.admission.used("historyBuild")).toBe(0);
  } finally {
    resume.resolve();
    gate.mockRestore();
    await f.close();
  }
});

// 取消不能让迟到的分片回调继续登记，剩余分片也不能继续写入退休的导入。
test("取消在途大对象后停止后续分片与接收回调", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const accept = f.ingest.accept.bind(f.ingest);
  const gate = spyOn(f.ingest, "accept").mockImplementation(async (value, meta) => {
    entered.resolve();
    await resume.promise;
    return accept(value, meta);
  });
  const size = f.capacity.inputs.largeFrameThresholdBytes + 1024;
  const receiving = f.receiver.accept({ result: "x".repeat(size) }, { kind: "tool_object", entryId: "tool" });
  const outcome = receiving.catch((error: unknown) => error);
  try {
    await entered.promise;
    expect(f.admission.used("frameParse")).toBeGreaterThan(0);
    f.receiver.abort();
    resume.resolve();
    expect(await outcome).toMatchObject({ code: "IMPORT_INCOMPLETE" });
    expect(f.accepted).toEqual([]);
    expect(f.ingest.status().lastOrdinal).toBe(1);
    expect(f.admission.used("frameParse")).toBe(0);
    expect(f.admission.used("historyBuild")).toBe(0);
  } finally {
    resume.resolve();
    gate.mockRestore();
    await f.close();
  }
});

// frameParse 池耗尽时不能先分配整份复制缓冲，额度拒绝必须发生在 copy 边界之前。
test("大对象额度不足时不复制私有 canonical 字节", () => {
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
  const hold = admission.reserve("frameParse", DEFAULT_SYNC_CAPACITY.serverPools.frameParse);
  const copy = spyOn(AdmittedHistoryPayload.prototype, "bytesFor");
  try {
    expect(() =>
      admitHistoryObject(
        "x".repeat(DEFAULT_SYNC_CAPACITY.inputs.largeFrameThresholdBytes + 1),
        DEFAULT_SYNC_CAPACITY,
        admission,
      ),
    ).toThrow();
    expect(copy).not.toHaveBeenCalled();
  } finally {
    copy.mockRestore();
    hold.release();
  }
});

// 复制异常不能泄漏先前取得的解析池预留，原始异常须继续上抛。
test("大对象复制失败释放解析池额度并保留原始错误", () => {
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
  const failure = new Error("copy failed");
  let reservedDuringCopy = 0;
  const copy = spyOn(AdmittedHistoryPayload.prototype, "bytesFor").mockImplementation(() => {
    reservedDuringCopy = admission.used("frameParse");
    throw failure;
  });
  try {
    expect(() =>
      admitHistoryObject(
        "x".repeat(DEFAULT_SYNC_CAPACITY.inputs.largeFrameThresholdBytes + 1),
        DEFAULT_SYNC_CAPACITY,
        admission,
      ),
    ).toThrow(failure);
    expect(reservedDuringCopy).toBeGreaterThan(0);
    expect(admission.used("frameParse")).toBe(0);
  } finally {
    copy.mockRestore();
  }
});
