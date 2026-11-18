import { expect, test } from "bun:test";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { sha256Digest } from "../sync/clock";
import { createTextClaim } from "../sync/live/text-claim";
import { records } from "../sync/live/writer-support";
import { SyncProtocolError } from "../sync/protocol/errors";
import { buildDocId } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { DocStateSnapshot } from "../sync/store/types";

const generation = "claim-generation";
const activeDocId = buildDocId({ kind: "content", generation, blockIndex: 0, nonce: "active" });
const scopeKey = "claim-org/claim-session";

/** 在历史读取边界控制完成顺序，保留真实的声明状态机和 Yjs 历史解析。 */
function fixture() {
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
  store.readDocStateAt = (docId) =>
    new Promise((resolve, reject) => {
      pending.push({ docId, resolve, reject });
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
  store.readSuccessor = async () => ({
    scopeKey,
    generation,
    docId: activeDocId,
    kind: "content",
    state: "active",
    route: null,
  });
  const claims = createTextClaim({ store, scopeKey, digest: sha256Digest });
  return {
    claims,
    activeDoc,
    pending,
    claim(entryId: string, historyDocIds: readonly string[], contentSlot = "text") {
      return claims.claim({ generation, entryId, contentSlot, activeDoc, historyDocIds });
    },
    read(index: number) {
      const read = pending[index];
      if (!read) throw new Error("Expected a pending history read");
      return read;
    },
    close() {
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
      const previous = outcome(f.claim("same-entry", ["history-old"]));
      f.claims.reset();
      const current = outcome(f.claim("same-entry", ["history-new"]));
      expect(await f.claim("same-entry", ["history-new"])).toBe(false);
      if (oldFinishesFirst) {
        f.read(0).resolve(historyState("history-old", ["old-only"]));
        expectInvalidated(await previous);
      }
      const other = outcome(f.claim("old-only", ["history-new"]));
      f.read(1).resolve(historyState("history-new", ["new-only"]));
      expect(await current).toEqual({ value: true });
      expect(await other).toEqual({ value: true });
      if (!oldFinishesFirst) {
        f.read(0).resolve(historyState("history-old", ["old-only"]));
        expectInvalidated(await previous);
      }
      expect(await f.claim("new-only", ["history-new"])).toBe(false);
      expect(await f.claim("after-reset", ["history-new"])).toBe(true);
      expect(f.pending.map((read) => read.docId)).toEqual(["history-old", "history-new"]);
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
    const previous = outcome(f.claim("same-entry", ["history-old"]));
    f.claims.reset();
    const current = outcome(f.claim("same-entry", ["history-new"]));
    f.read(0).reject(readError);
    expectInvalidated(await previous, readError);
    expect(await f.claim("same-entry", ["history-new"])).toBe(false);
    const other = outcome(f.claim("new-only", ["history-new"]));
    expect(f.pending.map((read) => read.docId)).toEqual(["history-old", "history-new"]);
    f.read(1).resolve(historyState("history-new", ["new-only"]));
    expect(await current).toEqual({ value: true });
    expect(await other).toEqual({ value: false });
  } finally {
    f.close();
  }
});

// 当前代次读取失败保留原异常并释放占位，允许同一消息重新读取历史后判定。
test("当前历史失败后同键可重试并保留原始错误", async () => {
  const f = fixture();
  const readError = new Error("current history unavailable");
  try {
    const first = outcome(f.claim("same-entry", ["history-current"]));
    f.read(0).reject(readError);
    expect(await first).toEqual({ error: readError });
    const retried = f.claim("same-entry", ["history-current"]);
    f.read(1).resolve(historyState("history-current", []));
    expect(await retried).toBe(true);
    expect(await f.claim("same-entry", ["history-current"])).toBe(false);
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
    const historical = f.claim("history-entry", ["history-current"]);
    f.read(0).resolve(historyState("history-current", ["history-entry"]));
    expect(await historical).toBe(false);
    expect(await f.claim("different-entry", ["history-current"])).toBe(true);
  } finally {
    f.close();
  }
});
