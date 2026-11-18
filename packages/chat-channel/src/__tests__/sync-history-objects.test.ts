import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY as capacity } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { BlockBuildPool, deriveBuildPoolConfig } from "../sync/history/build-pool";
import { HistoryImportService } from "../sync/history/import-service";
import { HistorySpool } from "../sync/history/spool";
import { contentObjectPartSchema } from "../sync/protocol/content-object-parts";
import { MemoryProjectionStore } from "../sync/store/memory-store";

async function withImport(
  run: (
    service: HistoryImportService,
    store: MemoryProjectionStore,
    admission: AdmissionController,
    spool: HistorySpool,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "history-objects-"));
  const clock = { now: () => 1000 };
  const admission = new AdmissionController(capacity);
  const store = new MemoryProjectionStore({
    clock,
    digest: sha256Digest,
    capacity,
    lifecycle: { sealGraceMs: 1000, retireGraceMs: 1000 },
  });
  const pool = new BlockBuildPool(deriveBuildPoolConfig(capacity.fairness), admission, clock);
  const spool = new HistorySpool(
    {
      basePath: root,
      segmentBytes: capacity.concurrency.loadSpoolTaskBytes,
      taskQuotaBytes: capacity.concurrency.loadSpoolTaskBytes,
      processQuotaBytes: capacity.concurrency.loadSpoolProcessBytes,
    },
    clock,
  );
  const service = new HistoryImportService({
    store,
    spool,
    pool,
    clock,
    digest: sha256Digest,
    capacity,
    rand: deterministicRandomSource("objects"),
    admission,
  });
  try {
    await run(service, store, admission, spool);
  } finally {
    await service.abort(new Error("test fixture disposed"));
    await rm(root, { recursive: true, force: true });
  }
}
const begin = {
  scope: { organizationId: "org-objects", rcsSessionId: "rcs-objects" },
  acpSessionId: "ses-objects",
  owner: "objects",
  leaseTtlMs: 60000,
};

// 大工具对象先接纳原始尺寸，分片后的真实块必须能逐字节还原。
test("2MiB 工具对象跨块重组且释放大帧额度", async () => {
  await withImport(async (service, store, admission, spool) => {
    const original = { result: "天气🌤️".repeat(300000) };
    const { generation } = await service.begin(begin);
    await service.accept(original, { kind: "tool_object", entryId: "large-tool", sourceRevision: 2 });
    expect(service.status().receivedOrdinal).toBeGreaterThan(1);
    expect(admission.used("frameParse")).toBe(0);
    await service.receivingComplete();
    await service.buildAndCommit();
    const directory = await store.readDirectory({ generation, limit: 1024 });
    const chunks: Buffer[] = [];
    let objectDigest = "";
    let totalBytes = 0;
    let partCount = 0;
    for (const ref of directory.entries) {
      const state = await store.readDocStateAt(ref.docId, 0);
      if (!state) throw new Error("missing content block");
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, state.snapshot);
        const records = doc.getMap("root").get("records");
        if (!(records instanceof Y.Array)) throw new Error("missing records");
        for (const record of records.toArray()) {
          const part = contentObjectPartSchema.parse(JSON.parse(new TextDecoder().decode(record.payload)));
          expect(part.kind).toBe("tool_object");
          expect(part.partIndex).toBe(chunks.length);
          objectDigest = part.digest;
          totalBytes = part.totalBytes;
          partCount = part.partCount;
          chunks.push(Buffer.from(part.data, "base64"));
        }
      } finally {
        doc.destroy();
      }
    }
    const bytes = Buffer.concat(chunks);
    expect(bytes.byteLength).toBe(totalBytes);
    expect(chunks.length).toBe(partCount);
    expect(sha256Digest(bytes)).toBe(objectDigest);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(original);
    await service.finalize();
    expect(spool.stats().totalBytes).toBe(0);
  });
});

// 超限原始对象不能靠拆成小片绕过入口限制，失败后不保留暂存或额度。
test("历史对象分片前拒绝原始尺寸超限", async () => {
  await withImport(async (service, _store, admission, spool) => {
    await service.begin(begin);
    await expect(
      service.accept(
        { text: "x".repeat(capacity.inputs.maxRawAcpFrameBytes) },
        { kind: "tool_object", entryId: "too-large" },
      ),
    ).rejects.toMatchObject({ code: "CAPACITY_EXCEEDED" });
    expect(admission.used("frameParse")).toBe(0);
    expect(spool.stats().totalBytes).toBe(0);
  });
});

// 生产工厂必须把大帧额度注入导入层，不能只有直接构造的单测能接收大对象。
test("运行时工厂装配的大对象导入使用有效接纳额度", async () => {
  const { createSyncHistoryImport } = await import("../sync/runtime/scope-runtime");
  const { resolveSyncRuntimeConfig } = await import("../sync/runtime/config");
  const root = await mkdtemp(join(tmpdir(), "history-factory-"));
  const clock = { now: () => 1000 };
  const config = resolveSyncRuntimeConfig({
    lifecycle: { sealGraceMs: 1000, retireGraceMs: 1000 },
    spoolRootDir: root,
  });
  const store = new MemoryProjectionStore({ clock, digest: sha256Digest, capacity, lifecycle: config.lifecycle });
  const service = createSyncHistoryImport({
    scope: begin.scope,
    store,
    config,
    clock,
    digest: sha256Digest,
    random: deterministicRandomSource("factory"),
  });
  try {
    await service.begin(begin);
    await service.accept({ result: "x".repeat(2 * 1024 * 1024) }, { kind: "tool_object", entryId: "factory-large" });
    await service.receivingComplete();
    await service.buildAndCommit();
    await service.finalize();
    expect(service.status().state).toBe("importComplete");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
