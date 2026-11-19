import { expect, test } from "bun:test";
import * as Y from "yjs";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { sha256Digest } from "../sync/clock";
import { createTextClaim } from "../sync/live/text-claim";
import { records } from "../sync/live/writer-support";
import { SyncProtocolError } from "../sync/protocol/errors";
import { buildDocId } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { DocStateSnapshot } from "../sync/store/types";
import { withinDeadline } from "./sync-live-writer-authority-fixture";

const generation = "claim-generation";
const activeDocId = buildDocId({ kind: "content", generation, blockIndex: 0, nonce: "active" });
const scopeKey = "claim-org/claim-session";
const HISTORY = buildDocId({ kind: "content", generation, blockIndex: 0, nonce: "history" });
const OLD_HISTORY = buildDocId({ kind: "content", generation, blockIndex: 0, nonce: "history-old" });
const NEW_HISTORY = buildDocId({ kind: "content", generation, blockIndex: 0, nonce: "history-new" });
const CURRENT_HISTORY = buildDocId({ kind: "content", generation, blockIndex: 0, nonce: "history-current" });

/** 在历史读取边界控制完成顺序，保留真实的声明状态机和 Yjs 历史解析。 */
function fixture() {
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
  const store = new MemoryProjectionStore({
    clock: { now: () => 1000 },
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
  });
  const activeDoc = new Y.Doc({ guid: activeDocId });
  const pending: {
    docId: string;
    resolve: (value: DocStateSnapshot | null) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const started = new Map<number, () => void>();
  store.readDocStateAt = (docId) =>
    new Promise((resolve, reject) => {
      pending.push({ docId, resolve, reject });
      started.get(pending.length - 1)?.();
      started.delete(pending.length - 1);
    });
  store.readGeneration = async () => ({
    scopeKey,
    generation,
    acpSessionId: "claim-acp",
    loadId: "claim-load",
    state: "committed",
    importEndOrdinal: 0,
    createdAt: 1000,
    entryRefs: {
      controlDocId: "control",
      directoryDocId: "directory",
      runtimeDocId: "runtime",
      contentDocIds: [activeDocId],
    },
  });
  store.readSuccessor = async (_scope, docId) => ({
    scopeKey,
    generation,
    docId,
    kind: "content",
    state: docId === activeDocId ? "active" : "sealed",
    finalSeq: docId === activeDocId ? null : 0,
    route: null,
  });
  const claims = createTextClaim({ store, scopeKey, digest: sha256Digest, admission });
  return {
    claims,
    activeDoc,
    admission,
    pending,
    claim(entryId: string, historyDocIds: readonly string[], contentSlot = "text") {
      return claims.claim({ generation, entryId, contentSlot, activeDoc, historyDocIds });
    },
    /** 等待元数据预检完成后的真实 canonical 边界，再控制 reset 与回执次序。 */
    async read(index: number) {
      if (!pending[index]) await withinDeadline(new Promise<void>((resolve) => started.set(index, resolve)));
      const read = pending[index];
      if (!read) throw new Error("Expected a pending history read");
      return read;
    },
    close() {
      claims.reset();
      activeDoc.destroy();
      store.dispose();
    },
  };
}

/** 历史导入使用数字槽位，与实时的 text 槽位按稳定 entryId 对齐。 */
function historyState(docId: string, entryIds: readonly string[]): DocStateSnapshot {
  const doc = new Y.Doc({ guid: docId });
  try {
    records(
      doc,
      entryIds.map((entryId) => ({ kind: "text_part", entryId, contentSlot: 0 })),
    );
    const snapshot = Y.encodeStateAsUpdate(doc);
    return { docId, baseSeq: 0, lastSeq: 0, snapshot, hash: sha256Digest(snapshot) };
  } finally {
    doc.destroy();
  }
}

/** 立即接住预期拒绝，受控读取期间不会留下未处理的 Promise 异常。 */
function outcome(promise: Promise<boolean>): Promise<{ value: boolean } | { error: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

/** 旧代次只能报告重新判定所需的协议错误，不能冒充命中或漏过旧声明。 */
function expectInvalidated(result: Awaited<ReturnType<typeof outcome>>, cause?: unknown): void {
  expect(result).toHaveProperty("error");
  if (!("error" in result)) throw new Error("Expected invalidated text claim");
  expect(result.error).toBeInstanceOf(SyncProtocolError);
  expect(result.error).toMatchObject({
    code: "GENERATION_MISMATCH",
    retryable: true,
    safeContext: { docId: activeDocId },
  });
  if (cause !== undefined) expect(result.error).toHaveProperty("cause", cause);
}

for (const oldFinishesFirst of [true, false]) {
  // reset 后同键声明属于新代次，旧历史成功不得覆盖新缓存或返回旧判定。
  test(`旧历史${oldFinishesFirst ? "先" : "后"}完成时拒绝旧声明并保留新代次`, async () => {
    const f = fixture();
    try {
      const previous = outcome(f.claim("same-entry", [OLD_HISTORY]));
      await f.read(0);
      f.claims.reset();
      const current = outcome(f.claim("same-entry", [NEW_HISTORY]));
      const duplicate = outcome(f.claim("same-entry", [NEW_HISTORY]));
      await f.read(1);
      if (oldFinishesFirst) {
        (await f.read(0)).resolve(historyState(OLD_HISTORY, ["old-only"]));
        expectInvalidated(await previous);
      }
      const other = outcome(f.claim("old-only", [NEW_HISTORY]));
      (await f.read(1)).resolve(historyState(NEW_HISTORY, ["new-only"]));
      expect(await current).toEqual({ value: true });
      expect(await duplicate).toEqual({ value: false });
      expect(await other).toEqual({ value: true });
      if (!oldFinishesFirst) {
        (await f.read(0)).resolve(historyState(OLD_HISTORY, ["old-only"]));
        expectInvalidated(await previous);
      }
      expect(await f.claim("new-only", [NEW_HISTORY])).toBe(false);
      expect(await f.claim("after-reset", [NEW_HISTORY])).toBe(true);
      expect(f.pending.map((read) => read.docId)).toEqual([OLD_HISTORY, NEW_HISTORY]);
    } finally {
      f.close();
    }
  });
}

// 旧读取失败不能删除新代次同键占位，也不能清空新代次正在共享的历史读取。
test("旧历史失败不清理新声明或新历史任务", async () => {
  const f = fixture();
  const readError = new Error("old history unavailable");
  try {
    const previous = outcome(f.claim("same-entry", [OLD_HISTORY]));
    await f.read(0);
    f.claims.reset();
    const current = outcome(f.claim("same-entry", [NEW_HISTORY]));
    await f.read(1);
    (await f.read(0)).reject(readError);
    expectInvalidated(await previous, readError);
    const duplicate = outcome(f.claim("same-entry", [NEW_HISTORY]));
    const other = outcome(f.claim("new-only", [NEW_HISTORY]));
    expect(f.pending.map((read) => read.docId)).toEqual([OLD_HISTORY, NEW_HISTORY]);
    (await f.read(1)).resolve(historyState(NEW_HISTORY, ["new-only"]));
    expect(await current).toEqual({ value: true });
    expect(await duplicate).toEqual({ value: false });
    expect(await other).toEqual({ value: false });
  } finally {
    f.close();
  }
});

// 同一声明尚在读取时只能共享最终判定或失败，预留身份本身不构成已接纳的证据。
test("直接同键 claim 等待首个读取并共享原始失败", async () => {
  const f = fixture();
  const failure = new Error("lookup failed");
  try {
    const first = outcome(f.claim("pending", [HISTORY]));
    let settled = false;
    const second = outcome(f.claim("pending", [HISTORY])).then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    (await f.read(0)).reject(failure);
    expect(await first).toEqual({ error: failure });
    expect(await second).toEqual({ error: failure });
  } finally {
    f.close();
  }
});

// 等待同键不能跳过 projection 身份校验，错误代次不得借用当前代次的 pending 结果。
test("同键 pending 不为错误代次提供重复成功", async () => {
  const f = fixture();
  try {
    const current = outcome(f.claim("same-entry", [HISTORY]));
    const wrong = outcome(
      f.claims.claim({
        generation: "wrong-generation",
        entryId: "same-entry",
        contentSlot: "text",
        activeDoc: f.activeDoc,
        historyDocIds: [HISTORY],
      }),
    );
    (await f.read(0)).resolve(historyState(HISTORY, []));
    expect(await current).toEqual({ value: true });
    expect(await wrong).toMatchObject({ error: { code: "GENERATION_MISMATCH" } });
  } finally {
    f.close();
  }
});

// 判重缓存与声明共享现有控制索引池，超载拒绝不能留下占位，reset 必须归还全部缓存额度。
test("claim 缓存受控制索引预算约束且 reset 归还额度", async () => {
  const f = fixture();
  const hold = f.admission.reserve("controlIndex", f.admission.available("controlIndex"));
  try {
    await expect(f.claim("budgeted", [])).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    hold.release();
    expect(await f.claim("budgeted", [])).toBe(true);
    expect(f.admission.used("controlIndex")).toBeGreaterThan(0);
    f.claims.reset();
    expect(f.admission.used("controlIndex")).toBe(0);
    expect(await f.claim("budgeted", [])).toBe(true);
  } finally {
    hold.release();
    f.close();
  }
});

// 当前代次读取失败保留原异常并释放占位，允许同一消息重新读取历史后判定。
test("当前历史失败后同键可重试并保留原始错误", async () => {
  const f = fixture();
  const readError = new Error("current history unavailable");
  try {
    const first = outcome(f.claim("same-entry", [CURRENT_HISTORY]));
    (await f.read(0)).reject(readError);
    expect(await first).toEqual({ error: readError });
    const retried = f.claim("same-entry", [CURRENT_HISTORY]);
    (await f.read(1)).resolve(historyState(CURRENT_HISTORY, []));
    expect(await retried).toBe(true);
    expect(await f.claim("same-entry", [CURRENT_HISTORY])).toBe(false);
  } finally {
    f.close();
  }
});

// 正常占位、活跃记录和历史导入均保持幂等，不同消息或内容槽仍能独立接纳。
test("正常声明保留消息槽位与历史 entryId 幂等", async () => {
  const f = fixture();
  try {
    expect(await f.claim("new-entry", [])).toBe(true);
    expect(await f.claim("new-entry", [])).toBe(false);
    expect(await f.claim("new-entry", [], "reasoning")).toBe(true);
    records(f.activeDoc, [{ kind: "text", entryId: "active-entry", contentSlot: "text" }]);
    expect(await f.claim("active-entry", [])).toBe(false);
    const historical = f.claim("history-entry", [CURRENT_HISTORY]);
    (await f.read(0)).resolve(historyState(CURRENT_HISTORY, ["history-entry"]));
    expect(await historical).toBe(false);
    expect(await f.claim("different-entry", [CURRENT_HISTORY])).toBe(true);
  } finally {
    f.close();
  }
});
