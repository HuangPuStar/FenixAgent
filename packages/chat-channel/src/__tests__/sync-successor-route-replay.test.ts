import { expect, test } from "bun:test";
import { AdmissionController, type ServerPoolName } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { sha256Digest } from "../sync/clock";
import { SyncProtocolError } from "../sync/protocol/errors";
import type { SyncDocRecord } from "../sync/store/types";
import { routeReplayFixture, textSnapshot, usage } from "./sync-route-replay-fixture";

/** 在指定预留点模拟池耗尽，其余 reserve 与 release 均由真实预算执行。 */
class FaultAdmission extends AdmissionController {
  remaining: number | null = null;

  override reserve(pool: ServerPoolName, bytes: number) {
    if (this.remaining !== null) {
      if (this.remaining === 0) throw new SyncProtocolError("ADMISSION_REJECTED");
      this.remaining -= 1;
    }
    return super.reserve(pool, bytes);
  }
}

// 路由已钉死也必须检查候选初始字节，不能把另一份快照报告为相同重试。
test("匹配路由拒绝不同初始字节且保留状态与额度", async () => {
  const f = await routeReplayFixture();
  try {
    await f.store.registerSuccessor(f.route(f.record(f.b, textSnapshot("base A"))));
    const before = f.store.exportCommittedState();
    const charged = usage(f.admission);
    await expect(f.store.registerSuccessor(f.route(f.record(f.b, textSnapshot("base B"))))).resolves.toEqual({
      outcome: "conflict",
    });
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(usage(f.admission)).toEqual(charged);
  } finally {
    f.dispose();
  }
});

// 重放以不可变初始快照为准，后继追加与再次封口后不能拿最终摘要误判相同输入。
test("匹配路由重放使用已更新和已封口目标的初始基线", async () => {
  const f = await routeReplayFixture();
  const initial = f.record(f.b);
  const input = f.route(initial);
  try {
    await f.store.registerSuccessor(input);
    await f.append(f.b, textSnapshot("successor tail"));
    const used = f.store.exportCommittedState();
    const usedCharge = usage(f.admission);
    await expect(f.store.registerSuccessor(input)).resolves.toEqual({ outcome: "already-committed" });
    expect(f.store.exportCommittedState()).toEqual(used);
    expect(usage(f.admission)).toEqual(usedCharge);
    await f.machine().seal({ ...f.request(), oldDocId: f.b, finalUpdateSeq: 1, successorDocId: f.id("c") });
    const final = await f.store.readDocStateAt(f.b, 1);
    expect(final?.hash).not.toBe(initial.hash);
    const before = f.store.exportCommittedState();
    const charged = usage(f.admission);
    await expect(f.store.registerSuccessor(input)).resolves.toEqual({ outcome: "already-committed" });
    await expect(f.store.registerSuccessor(f.route(f.record(f.b, final!.snapshot)))).resolves.toEqual({
      outcome: "conflict",
    });
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(usage(f.admission)).toEqual(charged);
    expect((await f.store.readDocStateAt(f.b, 0))?.snapshot).toEqual(f.empty);
    expect((await f.store.readUpdatesAfter(f.b, 0, 10)).length).toBe(1);
  } finally {
    f.dispose();
  }
});

// 纯路由原语允许缺失目标，后续带文档的封口重试必须真正补齐目标及可写 ledger。
test("纯路由登记后封口补齐缺失后继并可继续写入", async () => {
  const f = await routeReplayFixture();
  try {
    await expect(f.store.registerSuccessor(f.route())).resolves.toEqual({ outcome: "committed" });
    expect(await f.store.readDocStateAt(f.b, 0)).toBeNull();
    await f.machine().seal(f.request());
    expect((await f.store.readDocStateAt(f.b, 0))?.snapshot).toEqual(f.empty);
    await expect(f.append(f.b, textSnapshot("resumed"))).resolves.toMatchObject({ outcome: "committed" });
    expect((await f.store.readUpdatesAfter(f.b, 0, 10)).length).toBe(1);
    expect(await f.store.readSuccessor(f.key, f.a)).toMatchObject({ state: "sealed", route: { successorDocId: f.b } });
  } finally {
    f.dispose();
  }
});

// 补齐目标时 ledger 的额度也必须先到位，失败保留可恢复的纯路由且不留下文档或占用。
test("缺失目标补齐被额度拒绝后保留路由并可重试", async () => {
  const f = await routeReplayFixture();
  try {
    await f.store.registerSuccessor(f.route());
    const blocker = f.admission.reserve("controlIndex", f.admission.available("controlIndex"));
    const before = f.store.exportCommittedState();
    const charged = usage(f.admission);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        await expect(f.store.registerSuccessor(f.route(f.record(f.b)))).rejects.toMatchObject({
          code: "ADMISSION_REJECTED",
        });
        expect(f.store.exportCommittedState()).toEqual(before);
        expect(usage(f.admission)).toEqual(charged);
      }
    } finally {
      blocker.release();
    }
    await expect(f.store.registerSuccessor(f.route(f.record(f.b)))).resolves.toEqual({ outcome: "already-committed" });
    await expect(f.append(f.b, textSnapshot("resumed"))).resolves.toMatchObject({ outcome: "committed" });
    expect((await f.store.readUpdatesAfter(f.b, 0, 10)).length).toBe(1);
  } finally {
    f.dispose();
  }
});

for (const cutoff of [0, 1, 2]) {
  // 依次拒绝字节、文档元数据和空 ledger 预留，任一失败都不得发布部分目标。
  test(`纯路由补齐在预留点 ${cutoff} 失败后保留完整恢复入口`, async () => {
    const admission = new FaultAdmission(DEFAULT_SYNC_CAPACITY);
    const f = await routeReplayFixture("runtime", admission);
    try {
      await f.store.registerSuccessor(f.route());
      const before = f.store.exportCommittedState();
      const charged = usage(admission);
      admission.remaining = cutoff;
      await expect(f.store.registerSuccessor(f.route(f.record(f.b)))).rejects.toMatchObject({
        code: "ADMISSION_REJECTED",
      });
      expect(f.store.exportCommittedState()).toEqual(before);
      expect(usage(admission)).toEqual(charged);
      admission.remaining = null;
      await expect(f.store.registerSuccessor(f.route(f.record(f.b)))).resolves.toEqual({
        outcome: "already-committed",
      });
      await expect(f.append(f.b, textSnapshot("recovered ledger"))).resolves.toMatchObject({ outcome: "committed" });
      expect((await f.store.readUpdatesAfter(f.b, 0, 10)).length).toBe(1);
    } finally {
      admission.remaining = null;
      f.dispose();
    }
  });
}

// SealRequest 无法携带 ordinal 与依赖，复用相同内容初始目标必须保留原有业务元数据。
test("封口复用内容后继时保留范围和依赖元数据", async () => {
  const f = await routeReplayFixture("content");
  const target = { ...f.record(f.b), ordinalStart: 10, ordinalEnd: 19, dependsOn: ["existing-dependency"] };
  try {
    await f.store.createDoc({ scopeKey: f.key, epoch: f.lease.epoch, doc: target });
    const before = f.store.exportCommittedState().docs.find((doc) => doc.docId === f.b);
    await f.machine().seal(f.request());
    expect(f.store.exportCommittedState().docs.find((doc) => doc.docId === f.b)).toEqual(before);
    await expect(f.append(f.b, textSnapshot("next block"))).resolves.toMatchObject({ outcome: "committed" });
  } finally {
    f.dispose();
  }
});

for (const routeState of ["new", "pinned", "used"] as const) {
  // 非内容文档的行索引不是 SealRequest 的身份字段，登记与恢复均须保留既有 0 值。
  test(`封口保留 runtime 后继的存量零号索引：${routeState}`, async () => {
    const f = await routeReplayFixture();
    try {
      const target = { ...f.record(f.b), blockIndex: 0 };
      await f.store.createDoc({ scopeKey: f.key, epoch: f.lease.epoch, doc: target });
      if (routeState !== "new") await f.store.registerSuccessor(f.route());
      if (routeState === "used") await f.append(f.b, textSnapshot("already resumed"));
      const before = f.store.exportCommittedState().docs.find((doc) => doc.docId === f.b);
      const ledger = await f.store.readUpdatesAfter(f.b, 0, 10);
      await f.machine().seal(f.request());
      expect(f.store.exportCommittedState().docs.find((doc) => doc.docId === f.b)).toEqual(before);
      expect(await f.store.readUpdatesAfter(f.b, 0, 10)).toEqual(ledger);
      const sealed = f.store.exportCommittedState();
      const charged = usage(f.admission);
      await expect(f.store.registerSuccessor(f.route(f.record(f.b)))).resolves.toEqual({
        outcome: "already-committed",
      });
      expect(f.store.exportCommittedState()).toEqual(sealed);
      expect(usage(f.admission)).toEqual(charged);
    } finally {
      f.dispose();
    }
  });
}

// 内容块的行索引仍是请求可以表达的块位，新绑定不能复用索引不同的初始目标。
test("新内容路由拒绝不同块位的既有目标", async () => {
  const f = await routeReplayFixture("content");
  try {
    await f.store.createDoc({ scopeKey: f.key, epoch: f.lease.epoch, doc: f.record(f.b) });
    const before = f.store.exportCommittedState();
    const charged = usage(f.admission);
    await expect(f.store.registerSuccessor(f.route({ ...f.record(f.b), blockIndex: 2 }))).resolves.toEqual({
      outcome: "conflict",
    });
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(usage(f.admission)).toEqual(charged);
  } finally {
    f.dispose();
  }
});

for (const mismatch of ["scope", "generation", "kind", "id", "blockIndex"] as const) {
  // 已有路由不能绕过身份约束；相同字节也不允许替换租户、代次或文档身份。
  test(`匹配路由重放拒绝不兼容身份：${mismatch}`, async () => {
    const f = await routeReplayFixture(mismatch === "blockIndex" ? "content" : "runtime");
    try {
      await f.store.registerSuccessor(f.route(f.record(f.b)));
      const candidate: SyncDocRecord = {
        ...f.record(f.b),
        ...(mismatch === "scope" ? { scopeKey: "other/scope" } : {}),
        ...(mismatch === "generation" ? { generation: "other-generation" } : {}),
        ...(mismatch === "kind" ? { kind: "content" } : {}),
        ...(mismatch === "id" ? { docId: f.id("other") } : {}),
        ...(mismatch === "blockIndex" ? { blockIndex: 2 } : {}),
      };
      const before = f.store.exportCommittedState();
      const charged = usage(f.admission);
      const result = f.store.registerSuccessor(f.route(candidate));
      if (mismatch === "blockIndex") await expect(result).resolves.toEqual({ outcome: "conflict" });
      else await expect(result).rejects.toMatchObject({ code: "GENERATION_MISMATCH" });
      expect(f.store.exportCommittedState()).toEqual(before);
      expect(usage(f.admission)).toEqual(charged);
    } finally {
      f.dispose();
    }
  });
}

// 已钉死路由仍受租约与 owner 换代的 epoch fencing 限制，旧写者不能借幂等分支继续登记。
test("匹配路由重放保留到期与 owner 接管 fencing", async () => {
  const f = await routeReplayFixture();
  try {
    await f.store.registerSuccessor(f.route(f.record(f.b)));
    f.advance(10001);
    const before = f.store.exportCommittedState();
    const charged = usage(f.admission);
    await expect(f.store.registerSuccessor(f.route(f.record(f.b)))).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(usage(f.admission)).toEqual(charged);
    const replacement = await f.store.acquireWriter(f.key, "replacement", 10000);
    const afterTakeover = f.store.exportCommittedState();
    await expect(f.store.registerSuccessor(f.route(f.record(f.b)))).rejects.toMatchObject({
      code: "WRITER_EPOCH_LOST",
    });
    expect(f.store.exportCommittedState()).toEqual(afterTakeover);
    await expect(f.store.registerSuccessor({ ...f.route(f.record(f.b)), epoch: replacement.epoch })).resolves.toEqual({
      outcome: "already-committed",
    });
  } finally {
    f.dispose();
  }
});

// 新代提交后旧路由的 candidate 不能跳过 generation 可写性检查而补写过期目标。
test("匹配路由带文档重放拒绝已经退休的代次", async () => {
  const f = await routeReplayFixture();
  try {
    await f.store.registerSuccessor(f.route());
    const next = { ...f.generation, generation: "next-generation", loadId: "next-load" };
    await f.store.createGeneration({ scopeKey: f.key, epoch: f.lease.epoch, generation: next });
    await f.store.commitGeneration({
      scopeKey: f.key,
      epoch: f.lease.epoch,
      expectedCurrent: f.generation.generation,
      expectedPointerRevision: 1,
      newGeneration: next,
      entryClosure: next.entryRefs,
      retired: [f.generation.generation],
    });
    const before = f.store.exportCommittedState();
    const charged = usage(f.admission);
    await expect(f.store.registerSuccessor(f.route(f.record(f.b)))).rejects.toMatchObject({ code: "RESOURCE_RETIRED" });
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(usage(f.admission)).toEqual(charged);
  } finally {
    f.dispose();
  }
});

// 新绑定仍只能接入未写过的相同初始目标，不能把别的内容或已使用目标变成下一写入点。
test("新路由拒绝不同初始字节和已有更新的目标", async () => {
  const f = await routeReplayFixture();
  try {
    const target = f.record(f.b, textSnapshot("pre-registered"));
    await f.store.createDoc({ scopeKey: f.key, epoch: f.lease.epoch, doc: target });
    const before = f.store.exportCommittedState();
    const charged = usage(f.admission);
    await expect(f.store.registerSuccessor(f.route(f.record(f.b)))).resolves.toEqual({ outcome: "conflict" });
    expect(f.store.exportCommittedState()).toEqual(before);
    expect(usage(f.admission)).toEqual(charged);
    await f.append(f.b, textSnapshot("used"));
    const used = f.store.exportCommittedState();
    const usedCharge = usage(f.admission);
    await expect(f.store.registerSuccessor(f.route(target))).resolves.toEqual({ outcome: "conflict" });
    expect(f.store.exportCommittedState()).toEqual(used);
    expect(usage(f.admission)).toEqual(usedCharge);
    expect((await f.store.readDocStateAt(f.b, 0))?.hash).toBe(sha256Digest(target.snapshot));
  } finally {
    f.dispose();
  }
});
