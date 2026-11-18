import { expect, test } from "bun:test";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { createSealingMachine, type SealRequest } from "../sync/live/sealing";
import { buildDocId, scopeKey } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { ProjectionStore, SealDocInput, WriterLease } from "../sync/store/types";

/** 使用真实提交与唯一路由，故障仅发生在存储读取和回执边界。 */
async function fixture() {
  const scope = { organizationId: "org_lifetime", rcsSessionId: "rcs_lifetime" };
  const key = scopeKey(scope);
  const generation = "gen_lifetime";
  let now = 1000;
  const clock = { now: () => now };
  const store = new MemoryProjectionStore({
    clock,
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
  });
  const lease = await store.acquireWriter(key, "first", 1000);
  const id = (nonce: string) => buildDocId({ kind: "runtime", generation, blockIndex: 0, nonce });
  const a = id("a");
  const b = id("b");
  const c = id("c");
  await store.createGeneration({
    scopeKey: key,
    epoch: lease.epoch,
    generation: {
      scopeKey: key,
      generation,
      acpSessionId: "ses_lifetime",
      loadId: "load_lifetime",
      state: "staging",
      importEndOrdinal: null,
      createdAt: now,
      entryRefs: { controlDocId: "control", directoryDocId: "directory", runtimeDocId: a, contentDocIds: [] },
    },
  });
  const empty = new Y.Doc();
  const snapshot = Y.encodeStateAsUpdate(empty);
  empty.destroy();
  await store.createDoc({
    scopeKey: key,
    epoch: lease.epoch,
    doc: {
      scopeKey: key,
      generation,
      docId: a,
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
    },
  });
  async function append(docId: string, text: string): Promise<void> {
    const state = await store.readDocStateAt(docId, 0);
    if (!state) throw new Error("Missing base");
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, state.snapshot);
      const updates = await store.readUpdatesAfter(docId, 0, 256);
      for (const update of updates) Y.applyUpdate(doc, update.bytes);
      const before = Y.encodeStateVector(doc);
      doc.getText("body").insert(doc.getText("body").length, text);
      const bytes = Y.encodeStateAsUpdate(doc, before);
      const pointer = await store.readScopePointer(key);
      if (!pointer?.writerOwner) throw new Error("Missing writer");
      await store.appendUpdates({
        scopeKey: key,
        epoch: pointer.writerEpoch,
        owner: pointer.writerOwner,
        batchId: `batch_${docId}_${updates.length}`,
        digest: sha256Digest(bytes),
        expectedFrontiers: [{ docId, lastSeq: updates.length }],
        updates: [{ docId, fromSeq: updates.length + 1, bytes }],
      });
    } finally {
      doc.destroy();
    }
  }
  await append(a, "first");
  const request = (oldDocId = a, successorDocId = b, writer: WriterLease = lease): SealRequest => ({
    scope,
    oldDocId,
    successorDocId,
    lease: writer,
    finalUpdateSeq: 1,
    successorInitialState: snapshot,
  });
  const machine = (target: ProjectionStore = store) =>
    createSealingMachine({
      store: target,
      clock,
      digest: sha256Digest,
      random: deterministicRandomSource("lifetime"),
    });
  return {
    store,
    lease,
    key,
    a,
    b,
    c,
    append,
    request,
    machine,
    advance: () => {
      now += 1001;
    },
  };
}

// 成功计划不绑定旧写者的内存 epoch，新取得的有效租约应按持久化幂等键完成确认。
test("已完成封口在新有效租约下仍可重复确认", async () => {
  const f = await fixture();
  try {
    const machine = f.machine();
    const first = await machine.seal(f.request());
    await f.store.releaseWriter(f.lease);
    const replacement = await f.store.acquireWriter(f.key, "replacement", 1000);
    expect(await machine.seal(f.request(f.a, f.b, replacement))).toEqual(first);
  } finally {
    f.store.dispose();
  }
});

// 完成后的再次调用必须读取持久化路由，不得把本机保存的大块计划当成存储可用的证据。
test("已完成计划的再次确认保留权威路由读取错误", async () => {
  const f = await fixture();
  const failure = new Error("route unavailable");
  let unavailable = false;
  const wrapped = new Proxy(f.store, {
    get(target, property) {
      if (property === "readSuccessor")
        return (...args: Parameters<MemoryProjectionStore["readSuccessor"]>) =>
          unavailable ? Promise.reject(failure) : target.readSuccessor(...args);
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    const machine = f.machine(wrapped);
    await machine.seal(f.request());
    unavailable = true;
    await expect(machine.seal(f.request())).rejects.toBe(failure);
    expect(machine.phase).toBe("failed");
  } finally {
    f.store.dispose();
  }
});

for (const fresh of [false, true]) {
  // 后继再次封口后其 hash 已改变，旧计划只能经已登记路由确认，不能重建或覆盖后继。
  test(`后继再次封口后重复确认前代，使用新协议机=${fresh}`, async () => {
    const f = await fixture();
    try {
      const machine = f.machine();
      const first = await machine.seal(f.request());
      await f.append(f.b, "second");
      await machine.seal(f.request(f.b, f.c));
      const before = f.store.exportCommittedState();
      expect(await (fresh ? f.machine() : machine).seal(f.request())).toEqual(first);
      expect(f.store.exportCommittedState()).toEqual(before);
    } finally {
      f.store.dispose();
    }
  });
}

// 放弃本机计划缓存不能绕过存储 fencing，过期租约仍不得重复确认已经完成的封口。
test("已完成封口的重复确认仍拒绝过期租约", async () => {
  const f = await fixture();
  try {
    const machine = f.machine();
    await machine.seal(f.request());
    f.advance();
    await expect(machine.seal(f.request())).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
  } finally {
    f.store.dispose();
  }
});

// 即使旧凭据的描述未过期，存储中的新 epoch 也必须拦住旧写者的幂等确认。
test("已完成封口的重复确认仍拒绝被接管的旧 epoch", async () => {
  const f = await fixture();
  try {
    const machine = f.machine();
    await machine.seal(f.request());
    await f.store.releaseWriter(f.lease);
    await f.store.acquireWriter(f.key, "replacement", 1000);
    await expect(machine.seal(f.request())).rejects.toMatchObject({ code: "WRITER_EPOCH_LOST" });
  } finally {
    f.store.dispose();
  }
});

// 已提交的后继和截止点保持唯一，换 nonce 的请求不能为旧前代留下第二个后继。
test("已完成封口拒绝改换其已登记的后继", async () => {
  const f = await fixture();
  try {
    const machine = f.machine();
    const first = await machine.seal(f.request());
    await expect(machine.seal(f.request(f.a, f.c))).rejects.toMatchObject({ code: "DIGEST_CONFLICT" });
    expect(machine.phase).toBe("sealed");
    expect(await machine.seal(f.request())).toEqual(first);
    expect(await f.store.readSuccessor(f.key, f.a)).toMatchObject({
      route: { successorDocId: f.b, expectedLastSeq: 1 },
    });
    expect(await f.store.readDocStateAt(f.c, 0)).toBeNull();
  } finally {
    f.store.dispose();
  }
});

for (const committed of [false, true]) {
  // 未知回执只能按同计划重试或权威确认，本次调用结束后再次确认仍应得到相同封口结果。
  test(`未知封口回执保持幂等，实际已提交=${committed}`, async () => {
    const f = await fixture();
    let lost = false;
    const wrapped = new Proxy(f.store, {
      get(target, property) {
        if (property === "sealDoc")
          return async (input: SealDocInput) => {
            if (lost) return target.sealDoc(input);
            lost = true;
            if (committed) await target.sealDoc(input);
            return { outcome: "unknown" as const, finalSeq: input.expectedLastSeq };
          };
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      const machine = f.machine(wrapped);
      const first = await machine.seal(f.request());
      expect(await machine.seal(f.request())).toEqual(first);
      expect(await f.store.readSuccessor(f.key, f.a)).toMatchObject({ state: "sealed" });
    } finally {
      f.store.dispose();
    }
  });
}
