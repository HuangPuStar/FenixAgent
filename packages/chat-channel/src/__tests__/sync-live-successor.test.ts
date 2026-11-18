import { expect, test } from "bun:test";
import * as Y from "yjs";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { loadCommittedDoc } from "../sync/live/committed-doc";
import { recoverLiveSuccessors } from "../sync/live/live-successor";
import { createSealingMachine } from "../sync/live/sealing";
import { buildDocId, type DocKind, scopeKey } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { ProjectionStore, SyncSuccessorState } from "../sync/store/types";

/** 真实存储与封口机；遍历单独计费，避免存储的常驻用量掩盖恢复额度。 */
async function lineage(length = 4, visitSlots = 1, linked = true) {
  const scope = { organizationId: "org_successor", rcsSessionId: "rcs_successor" };
  const key = scopeKey(scope);
  const generation = "gen_successor";
  const clock = { now: () => 1000 };
  const store = new MemoryProjectionStore({
    clock,
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
  });
  const lease = await store.acquireWriter(key, "successor-test", 1000);
  const docId = (nonce: string, kind: DocKind = "runtime", gen = generation) =>
    buildDocId({ kind, generation: gen, blockIndex: 0, nonce });
  const ids = Array.from({ length }, (_, index) => docId(`doc-${index}`));
  const entryRefs = {
    controlDocId: docId("control", "control"),
    directoryDocId: docId("directory", "directory"),
    runtimeDocId: ids[0],
    contentDocIds: [],
  };
  await store.createGeneration({
    scopeKey: key,
    epoch: lease.epoch,
    generation: {
      scopeKey: key,
      generation,
      acpSessionId: "ses_successor",
      loadId: "load_successor",
      state: "staging",
      importEndOrdinal: null,
      createdAt: 1000,
      entryRefs,
    },
  });
  const empty = new Y.Doc();
  const snapshot = Y.encodeStateAsUpdate(empty);
  empty.destroy();
  for (const id of ids) {
    await store.createDoc({
      scopeKey: key,
      epoch: lease.epoch,
      doc: {
        scopeKey: key,
        generation,
        docId: id,
        kind: "runtime",
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
  const admission = new AdmissionController({
    ...DEFAULT_SYNC_CAPACITY,
    serverPools: { ...DEFAULT_SYNC_CAPACITY.serverPools, controlIndex: (128 + ids[0].length * 2) * visitSlots },
  });
  const sealing = createSealingMachine({
    store,
    clock,
    digest: sha256Digest,
    random: deterministicRandomSource("seal"),
  });
  const callbacks: [string, string][] = [];
  const link = async (previous: string, next: string) => {
    await store.registerSuccessor({
      scopeKey: key,
      epoch: lease.epoch,
      predecessorDocId: previous,
      successorDocId: next,
      expectedLastSeq: 0,
    });
    await store.sealDoc({
      scopeKey: key,
      epoch: lease.epoch,
      docId: previous,
      successorDocId: next,
      expectedLastSeq: 0,
      finalSnapshot: snapshot,
      finalHash: sha256Digest(snapshot),
      manifestChange: {},
    });
  };
  if (linked) for (let index = 1; index < ids.length; index++) await link(ids[index - 1], ids[index]);
  return {
    store,
    ids,
    key,
    lease,
    scope,
    sealing,
    admission,
    callbacks,
    link,
    recover(overrides: Partial<Parameters<typeof recoverLiveSuccessors>[0]> = {}) {
      return recoverLiveSuccessors({
        store,
        scope,
        lease,
        sealing,
        startDocId: ids[0],
        admission,
        onSuccessor: async (previous, next) => {
          callbacks.push([previous, next]);
        },
        ...overrides,
      });
    },
    async close() {
      await store.releaseWriter(lease);
      store.dispose();
    },
  };
}

// 只容纳一次访问的额度也应走完整条谱系，不能在每次重开时重复卡在首个后继。
test("恢复长 successor 链只需一次访问额度并按序交接", async () => {
  const f = await lineage();
  try {
    expect(await f.recover()).toBe(f.ids[3]);
    expect(f.callbacks).toEqual([
      [f.ids[0], f.ids[1]],
      [f.ids[1], f.ids[2]],
      [f.ids[2], f.ids[3]],
    ]);
    expect(f.admission.used("controlIndex")).toBe(0);
  } finally {
    await f.close();
  }
});

for (const field of ["scopeKey", "docId", "kind", "generation"] as const) {
  // 存储返回的后续节点必须重新核对隔离边界，不能先发布合法前缀再发现跨谱系数据。
  test(`后继记录 ${field} 越界时整条恢复拒绝且不交接`, async () => {
    const f = await lineage(4, 8);
    const invalid = {
      scopeKey: "other-org/other-session",
      docId: f.ids[3],
      kind: "content",
      generation: "gen_other",
    } as const;
    const store: ProjectionStore = new Proxy(f.store, {
      get(target, property) {
        if (property === "readSuccessor")
          return async (key: string, docId: string): Promise<SyncSuccessorState | null> => {
            const state = await target.readSuccessor(key, docId);
            if (!state || docId !== f.ids[2]) return state;
            return { ...state, [field]: invalid[field] };
          };
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      await expect(f.recover({ store })).rejects.toMatchObject({ code: "GENERATION_MISMATCH" });
      expect(f.callbacks).toEqual([]);
      expect(f.admission.used("controlIndex")).toBe(0);
    } finally {
      await f.close();
    }
  });
}

for (const field of ["kind", "generation"] as const) {
  // 路由目标的 ID 自身也须同代同类，不能仅信任随后读取的元数据。
  test(`后继路由的 ${field} 越界时拒绝合法前缀交接`, async () => {
    const f = await lineage(4, 8);
    try {
      await f.link(
        f.ids[3],
        buildDocId({
          kind: field === "kind" ? "content" : "runtime",
          generation: field === "generation" ? "gen_other" : "gen_successor",
          blockIndex: 0,
          nonce: "foreign",
        }),
      );
      await expect(f.recover()).rejects.toMatchObject({ code: "GENERATION_MISMATCH" });
      expect(f.callbacks).toEqual([]);
      expect(f.admission.used("controlIndex")).toBe(0);
    } finally {
      await f.close();
    }
  });
}

// 未知后继不是可写尾部，必须在发布先前交接之前停止，不能捏造新的活动入口。
test("缺失后继在交接前拒绝并归还额度", async () => {
  const f = await lineage(4, 8);
  try {
    await f.link(
      f.ids[3],
      buildDocId({ kind: "runtime", generation: "gen_successor", blockIndex: 0, nonce: "missing" }),
    );
    await expect(f.recover()).rejects.toMatchObject({ code: "DOC_NOT_FOUND" });
    expect(f.callbacks).toEqual([]);
    expect(f.admission.used("controlIndex")).toBe(0);
  } finally {
    await f.close();
  }
});

// 预检后出现的新路由未经过循环校验，本轮不能把旧尾部或新目标宣称为可写入口。
test("交接期间尾部意外延伸时拒绝返回未验证尾部", async () => {
  const f = await lineage(2);
  try {
    await expect(
      f.recover({
        onSuccessor: async () => {
          await f.link(f.ids[1], f.ids[0]);
        },
      }),
    ).rejects.toMatchObject({ code: "MALFORMED_FRAME" });
    expect(f.admission.used("controlIndex")).toBe(0);
  } finally {
    await f.close();
  }
});

// 回到中间节点的循环必须在任何交接发布之前被拒绝，且不能泄漏额度。
test("循环 successor 链在交接前拒绝并归还额度", async () => {
  const f = await lineage(4, 8);
  try {
    await f.link(f.ids[3], f.ids[1]);
    await expect(f.recover()).rejects.toMatchObject({ code: "MALFORMED_FRAME" });
    expect(f.callbacks).toEqual([]);
    expect(f.admission.used("controlIndex")).toBe(0);
  } finally {
    await f.close();
  }
});

// 交接发布失败保留原始异常，释放遍历额度后重试仍可到达活动尾部。
test("交接失败归还额度并允许沿相同链重试", async () => {
  const f = await lineage();
  const failure = new Error("handoff unavailable");
  try {
    await expect(f.recover({ onSuccessor: async () => Promise.reject(failure) })).rejects.toBe(failure);
    expect(f.admission.used("controlIndex")).toBe(0);
    expect(await f.recover()).toBe(f.ids[3]);
    expect(f.admission.used("controlIndex")).toBe(0);
  } finally {
    await f.close();
  }
});

// 存储读取失败不得被包装或吞掉，也不能留下会阻止恢复重试的访问预留。
test("后继读取失败归还额度且不发布交接", async () => {
  const f = await lineage(4, 8);
  const failure = new Error("successor read unavailable");
  const store: ProjectionStore = new Proxy(f.store, {
    get(target, property) {
      if (property === "readSuccessor")
        return async (key: string, docId: string) => {
          if (docId === f.ids[2]) throw failure;
          return target.readSuccessor(key, docId);
        };
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    await expect(f.recover({ store })).rejects.toBe(failure);
    expect(f.callbacks).toEqual([]);
    expect(f.admission.used("controlIndex")).toBe(0);
    expect(await f.recover()).toBe(f.ids[3]);
  } finally {
    await f.close();
  }
});

// 未完成封口必须复用登记时的截止序号和后继零号基线，后继已有更新也不能被重置。
test("恢复 sealing 保留非零截止与后继原始基线", async () => {
  const f = await lineage(2, 1, false);
  const old = new Y.Doc();
  const next = new Y.Doc();
  try {
    for (const [doc, docId, count] of [
      [old, f.ids[0], 2],
      [next, f.ids[1], 1],
    ] as const) {
      for (let seq = 1; seq <= count; seq++) {
        doc.getMap("values").set("count", seq);
        const bytes = Y.encodeStateAsUpdate(doc);
        await f.store.appendUpdates({
          scopeKey: f.key,
          epoch: f.lease.epoch,
          owner: f.lease.owner,
          batchId: `${docId}-${seq}`,
          digest: sha256Digest(bytes),
          expectedFrontiers: [{ docId, lastSeq: seq - 1 }],
          updates: [{ docId, fromSeq: seq, bytes }],
        });
      }
    }
    await f.store.registerSuccessor({
      scopeKey: f.key,
      epoch: f.lease.epoch,
      predecessorDocId: f.ids[0],
      successorDocId: f.ids[1],
      expectedLastSeq: 2,
    });
    expect(await f.recover()).toBe(f.ids[1]);
    expect(await f.store.readSuccessor(f.key, f.ids[0])).toMatchObject({
      state: "sealed",
      route: { expectedLastSeq: 2 },
    });
    const sealed = await loadCommittedDoc(f.store, f.ids[0]);
    const active = await loadCommittedDoc(f.store, f.ids[1]);
    if (!sealed || !active) throw new Error("Missing recovered documents");
    try {
      expect(sealed.lastSeq).toBe(2);
      expect(sealed.doc.getMap("values").get("count")).toBe(2);
      expect(active.lastSeq).toBe(1);
      expect(active.doc.getMap("values").get("count")).toBe(1);
    } finally {
      sealed.doc.destroy();
      active.doc.destroy();
    }
    expect(f.callbacks).toEqual([[f.ids[0], f.ids[1]]]);
    expect(f.admission.used("controlIndex")).toBe(0);
  } finally {
    old.destroy();
    next.destroy();
    await f.close();
  }
});

// 基线读取位于交接执行阶段，失败也必须释放访问额度，且不能把未封口前驱发布出去。
test("恢复封口读取基线失败后释放额度且可重试", async () => {
  const f = await lineage(2, 1, false);
  const failure = new Error("successor base unavailable");
  const store: ProjectionStore = new Proxy(f.store, {
    get(target, property) {
      if (property === "readDocStateAt") return async () => Promise.reject(failure);
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    await f.store.registerSuccessor({
      scopeKey: f.key,
      epoch: f.lease.epoch,
      predecessorDocId: f.ids[0],
      successorDocId: f.ids[1],
      expectedLastSeq: 0,
    });
    await expect(f.recover({ store })).rejects.toBe(failure);
    expect(f.callbacks).toEqual([]);
    expect(f.admission.used("controlIndex")).toBe(0);
    expect(await f.recover()).toBe(f.ids[1]);
    expect(f.admission.used("controlIndex")).toBe(0);
  } finally {
    await f.close();
  }
});
