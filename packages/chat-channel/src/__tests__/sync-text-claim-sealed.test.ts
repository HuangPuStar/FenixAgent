import { expect, test } from "bun:test";
import { TEXT_CLAIM_REPLAY_MAX_BYTES } from "../sync/capacity/text-claim-reservations";
import { isTextClaimInvalidated } from "../sync/live/text-claim";
import { readTextClaimDoc } from "../sync/live/text-claim-read";
import { MAX_DOC_SNAPSHOT_BYTES } from "../sync/protocol/frames";
import { gate, rejection, withinDeadline } from "./sync-live-writer-authority-fixture";
import { sealedClaimFixture } from "./sync-text-claim-sealed-fixture";

for (const indexed of [false, true]) {
  // 旧已封口块的超大中间态不再影响判重，索引和旧扫描都必须只消费最终 canonical。
  test(`${indexed ? "索引" : "旧扫描"}判重从已封口最终状态读取且不重放旧 tail`, async () => {
    const f = await sealedClaimFixture(indexed);
    const read = f.store.readDocStateAt.bind(f.store),
      updates = f.store.readUpdatesAfter.bind(f.store);
    const snapshots: number[] = [],
      tails: string[] = [];
    f.store.readDocStateAt = async (id, seq) => {
      snapshots.push(seq);
      return read(id, seq);
    };
    f.store.readUpdatesAfter = async (...args) => {
      tails.push(args[0]);
      return updates(...args);
    };
    const hot = f.admission.used("hotDocLive");
    try {
      expect(f.batch.updates.every((bytes) => bytes.length <= MAX_DOC_SNAPSHOT_BYTES)).toBe(true);
      expect(f.batch.intermediateBytes).toBeGreaterThan(TEXT_CLAIM_REPLAY_MAX_BYTES);
      expect(f.batch.snapshot.length).toBeLessThan(MAX_DOC_SNAPSHOT_BYTES);
      expect(await f.claims.claim(f.input)).toBe(false);
      expect(snapshots).toEqual([4]);
      expect(tails).toEqual([]);
      expect(f.admission.used("hotDocLive")).toBe(hot);
    } finally {
      await f.close();
    }
  });
}

// final 缺失不能退回旧 base，恢复最终快照后同一声明应重新读取而不是缓存失败。
test("已封口 final 缺失明确失败且恢复后同键可重试", async () => {
  const f = await sealedClaimFixture(true),
    read = f.store.readDocStateAt.bind(f.store);
  const snapshots: number[] = [];
  let missing = true;
  f.store.readDocStateAt = async (id, seq) => {
    snapshots.push(seq);
    return missing && seq === 4 ? null : read(id, seq);
  };
  try {
    await expect(f.claims.claim(f.input)).rejects.toMatchObject({ code: "DOC_NOT_FOUND" });
    missing = false;
    expect(await f.claims.claim(f.input)).toBe(false);
    expect(snapshots).toEqual([4, 4]);
  } finally {
    await f.close();
  }
});

// 曾经存在但已从最终 canonical 删除的记录不能通过旧 ledger 或索引冒充已提交文本。
test("已封口索引仍须在最终 canonical 中解析原记录身份", async () => {
  const f = await sealedClaimFixture(true);
  try {
    const snapshot = f.store.exportCommittedState();
    snapshot.refs[0] = { ...snapshot.refs[0], recordId: "first-0" };
    f.store.restoreFromCommittedState(snapshot);
    await expect(f.claims.claim(f.input)).rejects.toMatchObject({ code: "MALFORMED_FRAME" });
  } finally {
    await f.close();
  }
});

for (const finalSeq of [null, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
  // 不可用封口前沿不能被当成 seq0 或无限查询，拒绝应发生在 canonical 字节读取之前。
  test(`已封口非法 finalSeq=${String(finalSeq)} 明确拒绝且归还预算`, async () => {
    const f = await sealedClaimFixture(true),
      metadata = f.store.readSuccessor.bind(f.store);
    const hot = f.admission.used("hotDocLive"),
      control = f.admission.used("controlIndex");
    let reads = 0;
    f.store.readSuccessor = async (...args) => {
      const state = await metadata(...args);
      return state && { ...state, finalSeq };
    };
    f.store.readDocStateAt = async () => {
      reads++;
      return null;
    };
    try {
      await expect(
        readTextClaimDoc({
          store: f.store,
          admission: f.admission,
          scopeKey: f.key,
          docId: f.contentId,
          assertCurrent: () => {},
          consume: () => true,
        }),
      ).rejects.toMatchObject({ code: "MALFORMED_FRAME" });
      expect(reads).toBe(0);
      expect(f.admission.used("hotDocLive")).toBe(hot);
      expect(f.admission.used("controlIndex")).toBe(control);
    } finally {
      await f.close();
    }
  });
}

// 导入块的 finalSeq=0 也是有效最终状态，不能用 truthy 分支把它当成缺失前沿。
test("seq0 已封口导入块直接读取最终 canonical", async () => {
  const f = await sealedClaimFixture(true);
  const snapshot = f.store.exportCommittedState(),
    old = snapshot.docs.find((doc) => doc.docId === f.contentId)!;
  Object.assign(old, { baseSeq: 0, finalSeq: 0, lastSeq: 0, baseSnapshot: old.snapshot, baseHash: old.hash });
  snapshot.updates = snapshot.updates.filter((update) => update.docId !== old.docId);
  snapshot.successors[0].route.expectedLastSeq = 0;
  f.store.restoreFromCommittedState(snapshot);
  const read = f.store.readDocStateAt.bind(f.store),
    snapshots: number[] = [];
  f.store.readDocStateAt = async (id, seq) => {
    snapshots.push(seq);
    return read(id, seq);
  };
  f.store.readUpdatesAfter = async () => {
    throw new Error("sealed final must not read tail");
  };
  try {
    expect(await f.claims.claim(f.input)).toBe(false);
    expect(snapshots).toEqual([0]);
  } finally {
    await f.close();
  }
});

// Store 不能把另一个提交前沿伪装成请求的 final，避免以旧状态确认引用。
test("已封口 canonical 返回错误前沿时拒绝判重", async () => {
  const f = await sealedClaimFixture(true),
    read = f.store.readDocStateAt.bind(f.store);
  f.store.readDocStateAt = async (id, seq) => {
    const value = await read(id, seq);
    return value && { ...value, lastSeq: 3 };
  };
  try {
    await expect(f.claims.claim(f.input)).rejects.toMatchObject({ code: "SEQUENCE_GAP" });
  } finally {
    await f.close();
  }
});

for (const authority of ["scope", "generation", "kind"] as const) {
  // 生命周期元数据必须与已鉴权 scope 和原 Doc 身份一致，不能以跨域 canonical 确认文本。
  test(`已封口 ${authority} 元数据越界时零正文读取`, async () => {
    const f = await sealedClaimFixture(true),
      metadata = f.store.readSuccessor.bind(f.store);
    let reads = 0;
    f.store.readSuccessor = async (...args) => {
      const state = await metadata(...args);
      if (!state) return null;
      if (authority === "scope") return { ...state, scopeKey: "another-scope" };
      if (authority === "generation") return { ...state, generation: "another-generation" };
      return { ...state, kind: "runtime" };
    };
    f.store.readDocStateAt = async () => {
      reads++;
      return null;
    };
    try {
      await expect(
        readTextClaimDoc({
          store: f.store,
          admission: f.admission,
          scopeKey: f.key,
          docId: f.contentId,
          assertCurrent: () => {},
          consume: () => true,
        }),
      ).rejects.toMatchObject({ code: "GENERATION_MISMATCH" });
      expect(reads).toBe(0);
    } finally {
      await f.close();
    }
  });
}

// reset 后已封口读取的迟到回执也不能跨 token 恢复身份缓存。
test("已封口 canonical 的迟到回执在 reset 后失效并完整归还预算", async () => {
  const f = await sealedClaimFixture(true),
    paused = gate(),
    read = f.store.readDocStateAt.bind(f.store);
  const hot = f.admission.used("hotDocLive"),
    control = f.admission.used("controlIndex");
  f.store.readDocStateAt = async (...args) => {
    paused.enter();
    await paused.released;
    return read(...args);
  };
  const pending = rejection(f.claims.claim(f.input));
  try {
    await withinDeadline(paused.entered);
    f.claims.reset();
    paused.release();
    expect(isTextClaimInvalidated(await pending)).toBe(true);
    expect(f.admission.used("hotDocLive")).toBe(hot);
    expect(f.admission.used("controlIndex")).toBe(control);
  } finally {
    paused.release();
    await pending;
    await f.close();
  }
});
