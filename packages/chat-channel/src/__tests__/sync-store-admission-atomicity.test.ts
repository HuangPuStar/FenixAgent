import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdmissionController, type ServerPoolName } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { SyncProtocolError } from "../sync/protocol/errors";
import { scopeKey } from "../sync/protocol/identity";
import { resolveSyncRuntimeConfig } from "../sync/runtime/config";
import { createSyncScopeRuntime } from "../sync/runtime/scope-runtime";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { CommitGenerationInput, SyncDocRecord, SyncGenerationRecord } from "../sync/store/types";

/** 在任一额度申请处模拟池耗尽，其余计费与释放仍使用真实账本。 */
class FaultAdmission extends AdmissionController {
  remaining: number | null = null;
  override reserve(pool: ServerPoolName, bytes: number) {
    if (this.remaining !== null) {
      if (this.remaining === 0)
        throw new SyncProtocolError("ADMISSION_REJECTED", { message: "test capacity exhausted" });
      this.remaining--;
    }
    return super.reserve(pool, bytes);
  }
}

/** 先发布旧代，让失败后的指针、退休与重试都通过真实 Store 契约观测。 */
async function fixture() {
  const admission = new FaultAdmission(DEFAULT_SYNC_CAPACITY);
  const store = new MemoryProjectionStore({
    clock: { now: () => 1000 },
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
    memoryBudget: admission,
  });
  const lease = await store.acquireWriter("scope", "owner", 1000);
  const generation: SyncGenerationRecord = {
    scopeKey: "scope",
    generation: "old",
    acpSessionId: "ses_atomic",
    loadId: "load",
    state: "staging",
    importEndOrdinal: null,
    createdAt: 1000,
    entryRefs: { controlDocId: "control", directoryDocId: "directory", runtimeDocId: "runtime", contentDocIds: [] },
  };
  await store.createGeneration({ scopeKey: "scope", epoch: lease.epoch, generation });
  await store.commitGeneration({
    scopeKey: "scope",
    epoch: lease.epoch,
    newGeneration: generation,
    expectedCurrent: null,
    expectedPointerRevision: 0,
    entryClosure: generation.entryRefs,
    retired: [],
  });
  const usage = () =>
    ["controlIndex", "transportCache", "hotDocLive"].map((pool) => admission.used(pool as ServerPoolName));
  return { admission, store, lease, generation, usage };
}

for (const state of ["active", "sealed"] as const) {
  // 任一预留失败都须保持文档与 ledger 一致，恢复额度后可以正常重试。
  test(`${state} 文档登记在每个额度拒绝点均不留下半份记录`, async () => {
    let succeeded = false;
    for (let cutoff = 0; cutoff < 16 && !succeeded; cutoff++) {
      const f = await fixture();
      try {
        const snapshot = new Uint8Array([0, 0]);
        const doc: SyncDocRecord = {
          scopeKey: "scope",
          generation: "old",
          docId: "doc",
          kind: "content",
          state,
          snapshot,
          hash: sha256Digest(snapshot),
          baseSeq: 0,
          finalSeq: state === "sealed" ? 0 : null,
          blockIndex: 0,
          ordinalStart: 0,
          ordinalEnd: 0,
          dependsOn: [],
        };
        const input = { scopeKey: "scope", epoch: f.lease.epoch, doc };
        const register = () => (state === "active" ? f.store.createDoc(input) : f.store.putSealedIfAbsent(input));
        const before = f.store.exportCommittedState();
        const usage = f.usage();
        f.admission.remaining = cutoff;
        try {
          await register();
          succeeded = true;
        } catch (error) {
          expect(error).toMatchObject({ code: "ADMISSION_REJECTED" });
          expect(f.store.exportCommittedState()).toEqual(before);
          expect(f.usage()).toEqual(usage);
          f.admission.remaining = null;
          expect((await register()).outcome).toBe("committed");
          expect((await register()).outcome).toBe("already-committed");
          if (state === "active") {
            expect(
              (
                await f.store.appendUpdates({
                  scopeKey: "scope",
                  epoch: f.lease.epoch,
                  owner: "owner",
                  batchId: "batch",
                  digest: "digest",
                  expectedFrontiers: [{ docId: "doc", lastSeq: 0 }],
                  updates: [{ docId: "doc", fromSeq: 1, bytes: snapshot }],
                })
              ).outcome,
            ).toBe("committed");
          }
        }
      } finally {
        f.store.dispose();
      }
    }
    expect(succeeded).toBe(true);
  });
}

// 换代失败必须同时保留旧指针、旧代状态和幂等记录，重试才不会进入幽灵已提交状态。
test("换代在每个额度拒绝点均保持发布状态与账本不变", async () => {
  let succeeded = false;
  for (let cutoff = 0; cutoff < 16 && !succeeded; cutoff++) {
    const f = await fixture();
    try {
      const generation = { ...f.generation, generation: "new", loadId: "new-load", importEndOrdinal: 12 };
      await f.store.createGeneration({ scopeKey: "scope", epoch: f.lease.epoch, generation });
      const input: CommitGenerationInput = {
        scopeKey: "scope",
        epoch: f.lease.epoch,
        newGeneration: generation,
        expectedCurrent: "old",
        expectedPointerRevision: 1,
        entryClosure: generation.entryRefs,
        retired: ["old"],
      };
      const before = f.store.exportCommittedState();
      const usage = f.usage();
      f.admission.remaining = cutoff;
      try {
        await f.store.commitGeneration(input);
        succeeded = true;
      } catch (error) {
        expect(error).toMatchObject({ code: "ADMISSION_REJECTED" });
        expect(f.store.exportCommittedState()).toEqual(before);
        expect(f.usage()).toEqual(usage);
        f.admission.remaining = null;
        expect((await f.store.commitGeneration(input)).outcome).toBe("committed");
        expect((await f.store.commitGeneration(input)).outcome).toBe("already-committed");
        expect((await f.store.readGeneration("scope", "old"))?.state).toBe("retired");
        expect((await f.store.readScopePointer("scope"))?.currentGeneration).toBe("new");
      }
    } finally {
      f.store.dispose();
    }
  }
  expect(succeeded).toBe(true);
});

// 默认 Store 也须共享 runtime 的额度，不能在控制索引池耗尽后继续取得写权。
test("未注入 Store 的运行时在共享内存池耗尽时拒绝写入", async () => {
  const clock = { now: () => 1000 };
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
  const hold = admission.reserve("controlIndex", DEFAULT_SYNC_CAPACITY.serverPools.controlIndex);
  const runtime = await createSyncScopeRuntime({
    scope: { organizationId: "org_atomic", rcsSessionId: "rcs_atomic" },
    config: resolveSyncRuntimeConfig({ lifecycle: { sealGraceMs: 100, retireGraceMs: 100 } }),
    clock,
    digest: sha256Digest,
    random: deterministicRandomSource("default-admission"),
    admission,
  });
  try {
    await expect(
      runtime.acceptIngress({
        kind: "text-delta",
        turnId: "turn",
        entryId: "entry",
        contentSlot: "text",
        contentType: "text/plain",
        delta: "test",
      }),
    ).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
  } finally {
    hold.release();
    await runtime.dispose();
  }
});

// 恢复非空 ledger 必须恢复真实字节计费，逐出后也须全部归还。
test("恢复带增量的文档保留 hotDocLive 计费", async () => {
  const f = await fixture();
  try {
    const snapshot = new Uint8Array([0, 0]);
    await f.store.createDoc({
      scopeKey: "scope",
      epoch: f.lease.epoch,
      doc: {
        scopeKey: "scope",
        generation: "old",
        docId: "doc",
        kind: "content",
        state: "active",
        snapshot,
        hash: sha256Digest(snapshot),
        baseSeq: 0,
        finalSeq: null,
        blockIndex: 0,
        ordinalStart: 0,
        ordinalEnd: 0,
        dependsOn: [],
      },
    });
    await f.store.appendUpdates({
      scopeKey: "scope",
      epoch: f.lease.epoch,
      owner: "owner",
      batchId: "batch",
      digest: "digest",
      expectedFrontiers: [{ docId: "doc", lastSeq: 0 }],
      updates: [{ docId: "doc", fromSeq: 1, bytes: snapshot }],
    });
    expect(f.admission.used("hotDocLive")).toBe(4);
    const committed = f.store.exportCommittedState();
    f.store.dispose();
    f.store.restoreFromCommittedState(committed);
    expect(f.admission.used("hotDocLive")).toBe(4);
  } finally {
    f.store.dispose();
  }
  expect(f.admission.used("hotDocLive")).toBe(0);
});

// 自建 Store 的作用域结束后必须归还索引额度，包括引导尚未完成便失败的路径。
test("默认 Store 随运行时释放其持有的内存额度", async () => {
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
  const runtime = await createSyncScopeRuntime({
    scope: { organizationId: "org_owned", rcsSessionId: "rcs_owned" },
    config: resolveSyncRuntimeConfig({ lifecycle: { sealGraceMs: 100, retireGraceMs: 100 } }),
    clock: { now: () => 1000 },
    digest: sha256Digest,
    random: deterministicRandomSource("owned"),
    admission,
  });
  try {
    await expect(
      runtime.acceptIngress({
        kind: "text-delta",
        turnId: "turn",
        entryId: "entry",
        contentSlot: "text",
        contentType: "text/plain",
        delta: "test",
      }),
    ).rejects.toBeInstanceOf(SyncProtocolError);
    expect(admission.used("controlIndex")).toBeGreaterThan(0);
  } finally {
    await runtime.dispose();
  }
  expect(admission.used("controlIndex")).toBe(0);
});

// 注入的 Store 属于共享缓存，单连接结束不得销毁共享的投影或额度。
test("运行时不释放调用方注入的共享 Store", async () => {
  const f = await fixture();
  const before = f.store.exportCommittedState();
  const runtime = await createSyncScopeRuntime({
    scope: { organizationId: "org_shared", rcsSessionId: "rcs_shared" },
    config: resolveSyncRuntimeConfig({ lifecycle: { sealGraceMs: 100, retireGraceMs: 100 } }),
    clock: { now: () => 1000 },
    digest: sha256Digest,
    random: deterministicRandomSource("shared"),
    store: f.store,
    admission: f.admission,
  });
  try {
    await runtime.dispose();
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(f.admission.used("controlIndex")).toBeGreaterThan(0);
  } finally {
    f.store.dispose();
  }
});

// 默认 Store 的导入也由运行时持有，源暂停时关闭仍须立即释放已缓存的导入额度。
for (const sharedStore of [false, true]) {
  test(`关闭运行时取消暂停的导入，注入 Store=${sharedStore}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "owned-import-"));
    const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
    const store = sharedStore
      ? new MemoryProjectionStore({
          clock: { now: () => 1000 },
          digest: sha256Digest,
          capacity: DEFAULT_SYNC_CAPACITY,
          lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
          memoryBudget: admission,
        })
      : undefined;
    const scope = { organizationId: "org_import", rcsSessionId: "rcs_import" };
    const runtime = await createSyncScopeRuntime({
      scope,
      config: resolveSyncRuntimeConfig({ spoolRootDir: root, lifecycle: { sealGraceMs: 100, retireGraceMs: 100 } }),
      clock: { now: () => 1000 },
      digest: sha256Digest,
      random: deterministicRandomSource("owned-import"),
      admission,
      store,
    });
    const paused = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    try {
      await runtime.history.begin({ scope, acpSessionId: "ses_import", owner: "owner", leaseTtlMs: 1000 });
      async function* source() {
        yield { value: "first", meta: { kind: "history_object" as const } };
        paused.resolve();
        await resume.promise;
        yield { value: "late", meta: { kind: "history_object" as const } };
      }
      const receiving = runtime.history.acceptRecords(source()).catch((error: unknown) => error);
      await paused.promise;
      expect(admission.used("historyBuild")).toBeGreaterThan(0);
      if (store)
        await expect(store.acquireWriter(scopeKey(scope), "blocked", 1000)).rejects.toMatchObject({
          code: "SCOPE_BUSY",
        });
      await runtime.dispose();
      expect(admission.used("historyBuild")).toBe(0);
      if (store) {
        expect(admission.used("controlIndex")).toBeGreaterThan(0);
        const replacement = await store.acquireWriter(scopeKey(scope), "replacement", 1000);
        await store.releaseWriter(replacement);
        expect(runtime.history.status().state).toBe("failed");
      } else expect(admission.used("controlIndex")).toBe(0);
      resume.resolve();
      expect(await receiving).toBeInstanceOf(SyncProtocolError);
    } finally {
      resume.resolve();
      await runtime.history.abort(new Error("test cleanup"));
      await runtime.dispose();
      store?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}
