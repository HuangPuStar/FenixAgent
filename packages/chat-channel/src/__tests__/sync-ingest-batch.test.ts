import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { sha256Digest } from "../sync/clock";
import { HistoryIngest } from "../sync/history/ingest";
import { admitHistoryObject } from "../sync/history/object-admission";
import { HistorySpool } from "../sync/history/spool";

const roots: string[] = [];
const spools: HistorySpool[] = [];
afterEach(async () => {
  for (const spool of spools.splice(0))
    for (const loadId of spool.stats().taskBytes.keys()) await spool.completeTask(loadId);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function staged() {
  const basePath = await mkdtemp(join(tmpdir(), "history-batch-"));
  roots.push(basePath);
  const clock = { now: () => 1 };
  const spool = new HistorySpool({ basePath, segmentBytes: 16, taskQuotaBytes: 1024, processQuotaBytes: 1024 }, clock);
  spools.push(spool);
  const ingest = new HistoryIngest({ spool, clock, digest: sha256Digest, capacity: DEFAULT_SYNC_CAPACITY });
  await ingest.begin({ scopeKey: "org/rcs", generation: "gen_batch", loadId: "load_batch" });
  for (const value of ["第一条", "second", "第三条"]) await ingest.accept(value, { kind: "history_object" });
  ingest.markReceivingComplete(3);
  return { ingest, spool, manifest: (await ingest.stagedManifest())! };
}

// 批量读取跨段记录仍须逐条保真，不可把临近消息混成一个载荷。
test("按连续序号批量读取跨段记录并保持调用方隔离", async () => {
  const { ingest } = await staged();
  const records = await ingest.readRecords([1, 2, 3]);
  expect(records.map((record) => JSON.parse(new TextDecoder().decode(record)))).toEqual(["第一条", "second", "第三条"]);
  records[0]!.fill(0);
  expect(JSON.parse(new TextDecoder().decode((await ingest.readRecords([1]))[0]))).toBe("第一条");
});

// 非连续或未知序号必须整批拒绝，不能用一个大范围顺便读出未请求内容。
test("批量读取拒绝缺口、乱序与未知序号", async () => {
  const { ingest } = await staged();
  for (const ordinals of [
    [1, 3],
    [2, 1],
    [1, 1],
    [3, 4],
  ])
    await expect(ingest.readRecords(ordinals)).rejects.toBeDefined();
});

// 合并 I/O 后仍须拒绝截断或释放的暂存数据，不能用部分结果掩盖失败。
test("批量读取截断和释放的暂存均失败", async () => {
  const { ingest, spool, manifest } = await staged();
  await truncate(manifest.segments.at(-1)!.path, 0);
  await expect(ingest.readRecords([1, 2, 3])).rejects.toMatchObject({ code: "IMPORT_INCOMPLETE" });
  await spool.completeTask("load_batch");
  await expect(ingest.readRecords([1])).rejects.toMatchObject({ code: "RESOURCE_RETIRED" });
});

// 复用已经校验的原始对象不能共享调用方缓冲，也不能绕过当前接收器的输入限制。
test("复用原始接纳结果仍隔离字节并校验容量身份", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "history-admitted-"));
  roots.push(basePath);
  const clock = { now: () => 1 };
  const spool = new HistorySpool({ basePath, segmentBytes: 128, taskQuotaBytes: 1024, processQuotaBytes: 1024 }, clock);
  spools.push(spool);
  const ingest = new HistoryIngest({ spool, clock, digest: sha256Digest, capacity: DEFAULT_SYNC_CAPACITY });
  await ingest.begin({ scopeKey: "org/rcs", generation: "gen_batch", loadId: "load_batch" });
  const value = { text: "保真正文" };
  const accepted = admitHistoryObject(value, DEFAULT_SYNC_CAPACITY);
  accepted.bytes.fill(0);
  value.text = "已被修改";
  await ingest.acceptAdmitted(accepted.payload, { kind: "history_object" });
  expect(JSON.parse(new TextDecoder().decode((await ingest.readRecords([1]))[0]))).toEqual({ text: "保真正文" });
  const otherCapacity = { ...DEFAULT_SYNC_CAPACITY, inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, jsonMaxDepth: 1 } };
  await expect(
    ingest.acceptAdmitted(admitHistoryObject({}, otherCapacity).payload, { kind: "history_object" }),
  ).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
});

async function writable() {
  const basePath = await mkdtemp(join(tmpdir(), "history-write-batch-"));
  roots.push(basePath);
  const clock = { now: () => 1 };
  const spool = new HistorySpool({ basePath, segmentBytes: 8, taskQuotaBytes: 128, processQuotaBytes: 256 }, clock);
  spools.push(spool);
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
  const ingest = new HistoryIngest({ spool, clock, digest: sha256Digest, capacity: DEFAULT_SYNC_CAPACITY, admission });
  await ingest.begin({ scopeKey: "org/rcs", generation: "gen_batch", loadId: "load_batch" });
  const record = (text: string, entryId?: string) => ({
    payload: admitHistoryObject(text, DEFAULT_SYNC_CAPACITY).payload,
    meta: { kind: "history_object" as const, entryId },
  });
  return { ingest, spool, admission, record, basePath };
}

// 合并写入跨段后仍可独立定位每条记录，后续单条接收的编号也必须连续。
test("批量写入保留跨段字节区间、独立摘要和连续编号", async () => {
  const { ingest, record, admission } = await writable();
  const received = await ingest.acceptAdmittedBatch([record("中文", "a"), record("second", "b"), record("末条", "c")]);
  expect(received.map((item) => item.sourceOrdinal)).toEqual([1, 2, 3]);
  expect(received.map((item) => item.digest)).toEqual([
    sha256Digest(new TextEncoder().encode('"中文"')),
    sha256Digest(new TextEncoder().encode('"second"')),
    sha256Digest(new TextEncoder().encode('"末条"')),
  ]);
  expect((await ingest.readRecords([1, 2, 3])).map((bytes) => JSON.parse(new TextDecoder().decode(bytes)))).toEqual([
    "中文",
    "second",
    "末条",
  ]);
  expect((await ingest.accept("第四条", { kind: "history_object" })).sourceOrdinal).toBe(4);
  expect(admission.used("historyBuild")).toBe(0);
});

// 批内重复和共享预算不足都应在占编号之前拒绝，不能让拒绝记录在后续编号中留下缺口。
test("批次校验和预算拒绝均不消耗序号或泄漏额度", async () => {
  const { ingest, record, admission } = await writable();
  await expect(ingest.acceptAdmittedBatch([record("一", "a"), record("二", "a")])).rejects.toMatchObject({
    code: "DUPLICATE_OBJECT",
  });
  expect(ingest.status().lastOrdinal).toBe(0);
  const hold = admission.reserve("historyBuild", DEFAULT_SYNC_CAPACITY.serverPools.historyBuild);
  await expect(ingest.acceptAdmittedBatch([record("一"), record("二")])).rejects.toMatchObject({
    code: "ADMISSION_REJECTED",
  });
  expect(ingest.status().lastOrdinal).toBe(0);
  hold.release();
  expect((await ingest.accept("重试", { kind: "history_object" })).sourceOrdinal).toBe(1);
  expect(admission.used("historyBuild")).toBe(0);
});

// 磁盘配额失败属于整次导入撕裂，不能续写或返回部分成功；磁盘与内存额度都须归还。
test("批次磁盘配额失败释放全部额度并拒绝后续记录", async () => {
  const { ingest, spool, record, admission } = await writable();
  await expect(ingest.acceptAdmittedBatch([record("x".repeat(80)), record("y".repeat(80))])).rejects.toMatchObject({
    code: "CAPACITY_EXCEEDED",
  });
  expect(ingest.status().objectCount).toBe(0);
  expect(spool.stats().totalBytes).toBe(0);
  expect(admission.used("historyBuild")).toBe(0);
  await expect(ingest.accept("迟到", { kind: "history_object" })).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
});

// 实际文件系统写失败必须保留失败原因、释放副本与磁盘额度，并禁止继续写入撕裂任务。
test("批次文件写入失败归还预算并保留失败状态", async () => {
  const { ingest, spool, record, admission, basePath } = await writable();
  const taskPath = join(basePath, "load_batch");
  await rm(taskPath, { recursive: true });
  await writeFile(taskPath, "blocked directory");
  await expect(ingest.acceptAdmittedBatch([record("一"), record("二")])).rejects.toMatchObject({
    code: "STAGING_FAILED",
  });
  expect(ingest.status().objectCount).toBe(0);
  expect(spool.stats().totalBytes).toBe(0);
  expect(admission.used("historyBuild")).toBe(0);
  await expect(ingest.accept("迟到", { kind: "history_object" })).rejects.toMatchObject({ code: "STAGING_FAILED" });
});

// 尾批只有一条时同样会复制字节，不能借单条分支绕过共享构建额度。
test("单条尾批在复制前也必须取得构建额度", async () => {
  const { ingest, record, admission } = await writable();
  const hold = admission.reserve("historyBuild", DEFAULT_SYNC_CAPACITY.serverPools.historyBuild);
  await expect(ingest.acceptAdmittedBatch([record("尾批")])).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
  expect(ingest.status().lastOrdinal).toBe(0);
  hold.release();
  expect(admission.used("historyBuild")).toBe(0);
});
