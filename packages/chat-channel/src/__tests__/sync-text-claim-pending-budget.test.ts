import { expect, test } from "bun:test";
import * as Y from "yjs";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { sha256Digest } from "../sync/clock";
import { createTextClaim } from "../sync/live/text-claim";
import { buildDocId, MAX_IDENTIFIER_BYTES } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import { gate, rejection } from "./sync-live-writer-authority-fixture";

/** 只暂停索引出口，保留真实 claim 生命周期及共享控制索引账目。 */
function fixture() {
  const capacity = {
    ...DEFAULT_SYNC_CAPACITY,
    serverPools: { ...DEFAULT_SYNC_CAPACITY.serverPools, controlIndex: 8192 },
  };
  const admission = new AdmissionController(capacity);
  const store = new MemoryProjectionStore({
    clock: { now: () => 1000 },
    digest: sha256Digest,
    capacity,
    lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
  });
  const generation = "pending-budget";
  const active = new Y.Doc({ guid: buildDocId({ kind: "content", generation, blockIndex: 0, nonce: "active" }) });
  const pauses: ReturnType<typeof gate>[] = [];
  store.locateRefs = async () => {
    const paused = gate();
    pauses.push(paused);
    await paused.released;
    return [];
  };
  const claims = createTextClaim({ store, admission, scopeKey: "pending-org/pending-session", digest: sha256Digest });
  return {
    claims,
    admission,
    pauses,
    claim(entryId: string) {
      return claims.claim({ generation, activeDoc: active, entryId, contentSlot: "text", historyDocIds: [] });
    },
    close() {
      claims.reset();
      active.destroy();
      store.dispose();
    },
  };
}

// 反复 reset 不能让仍等待 Store 的合法输入失去计费，最终应在新的读取开始前由共享池拒绝。
test("跨 reset 的独立 pending claim 持有额度直到原回执结清", async () => {
  const f = fixture();
  const pending: Promise<unknown>[] = [];
  try {
    for (let index = 0; index < 16; index++) {
      const entryId = `${index}:`.padEnd(MAX_IDENTIFIER_BYTES, "x");
      pending.push(rejection(f.claim(entryId)));
      f.claims.reset();
    }
    expect(f.admission.used("controlIndex")).toBeGreaterThan(0);
    expect(f.admission.used("controlIndex")).toBeLessThanOrEqual(8192);
    expect(f.pauses.length).toBeGreaterThan(0);
    expect(f.pauses.length).toBeLessThan(16);
    for (const paused of f.pauses) paused.release();
    const results = await Promise.all(pending);
    expect(
      results.some(
        (error) =>
          error !== null && typeof error === "object" && "code" in error && error.code === "ADMISSION_REJECTED",
      ),
    ).toBe(true);
    expect(f.admission.used("controlIndex")).toBe(0);
    expect(f.admission.used("hotDocLive")).toBe(0);
  } finally {
    for (const paused of f.pauses) paused.release();
    await Promise.all(pending);
    f.close();
  }
});

// 相同 key 的等待者只持有同一个输入，不应重复收取独立在途任务额度。
test("同键 pending claim 共用在途元数据预留", async () => {
  const f = fixture();
  const first = rejection(f.claim("same"));
  const before = f.admission.used("controlIndex");
  const second = rejection(f.claim("same"));
  try {
    expect(f.admission.used("controlIndex")).toBe(before);
    expect(f.pauses).toHaveLength(1);
    f.claims.reset();
    expect(f.admission.used("controlIndex")).toBeGreaterThan(0);
    for (const paused of f.pauses) paused.release();
    expect(await first).toMatchObject({ code: "GENERATION_MISMATCH" });
    expect(await second).toMatchObject({ code: "GENERATION_MISMATCH" });
    expect(f.admission.used("controlIndex")).toBe(0);
  } finally {
    for (const paused of f.pauses) paused.release();
    await Promise.all([first, second]);
    f.close();
  }
});
