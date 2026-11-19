import { expect, test } from "bun:test";
import * as Y from "yjs";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { sha256Digest } from "../sync/clock";
import { createTextClaim } from "../sync/live/text-claim";
import { records } from "../sync/live/writer-support";
import { buildDocId } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import { textClaimHandoffFixture } from "./sync-live-text-claim-handoff-fixture";
import { authorityFixture, text } from "./sync-live-writer-authority-fixture";

// 索引的存在不能绕过 canonical 核对的解码额度，过载拒绝后原写者仍应允许同键重试。
test("热池耗尽时 indexed claim 零正文读取且恢复后可重试", async () => {
  const f = await authorityFixture();
  let hold: ReturnType<typeof f.admission.reserve> | undefined;
  let replacement: ReturnType<typeof f.makeWriter> | undefined;
  try {
    await f.writer.accept(text("indexed"));
    await f.writer.seal();
    await f.writer.close();
    replacement = f.makeWriter();
    await replacement.acquire();
    const reads: string[] = [];
    const read = f.store.readDocStateAt.bind(f.store);
    f.store.readDocStateAt = async (...args) => {
      reads.push(args[0]);
      return read(...args);
    };
    hold = f.admission.reserve("hotDocLive", f.admission.available("hotDocLive"));
    await expect(replacement.accept(text("indexed"))).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    expect(reads).toEqual([]);
    hold.release();
    await replacement.accept(text("indexed"));
    const indexedDocId = f.store.exportCommittedState().refs[0]?.docId;
    expect(indexedDocId).toBeDefined();
    expect(reads).toContain(indexedDocId);
    expect((await f.readAll()).map((record) => record.entryId)).toEqual(["indexed"]);
    expect(f.store.exportCommittedState().refs).toHaveLength(1);
  } finally {
    hold?.release();
    await replacement?.close();
    await f.close();
  }
});

// 导入历史按 entryId 判重也要先获同一热池额度，不能因只缓存身份而漏计临时正文。
test("热池耗尽时导入历史判重零读取且释放后仍识别旧消息", async () => {
  const admission = new AdmissionController(DEFAULT_SYNC_CAPACITY);
  const store = new MemoryProjectionStore({
    clock: { now: () => 1000 },
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
  });
  const generation = "history-budget";
  const active = new Y.Doc({ guid: buildDocId({ kind: "content", generation, blockIndex: 1, nonce: "active" }) });
  const historical = new Y.Doc();
  records(historical, [{ kind: "text_part", entryId: "history-entry", contentSlot: 0 }]);
  const snapshot = Y.encodeStateAsUpdate(historical);
  historical.destroy();
  let reads = 0;
  store.readDocStateAt = async (docId) => {
    reads++;
    return { docId, snapshot, hash: sha256Digest(snapshot), baseSeq: 0, lastSeq: 0 };
  };
  const claims = createTextClaim({ store, admission, scopeKey: "history-org/history-session", digest: sha256Digest });
  const claim = () =>
    claims.claim({
      generation,
      entryId: "history-entry",
      contentSlot: "text",
      activeDoc: active,
      historyDocIds: ["history"],
    });
  const hold = admission.reserve("hotDocLive", admission.available("hotDocLive"));
  try {
    await expect(claim()).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    expect(reads).toBe(0);
    hold.release();
    expect(await claim()).toBe(false);
    expect(reads).toBe(1);
    expect(admission.used("hotDocLive")).toBe(0);
  } finally {
    hold.release();
    claims.reset();
    active.destroy();
    store.dispose();
  }
  expect(admission.used("controlIndex")).toBe(0);
});

// adapter 可保守不给覆盖证明；fallback 的正文解码仍必须独立计费，不能依赖 Store coverage 读时碰巧计费。
test("无覆盖证明的 legacy fallback 在热池耗尽时也不读取正文", async () => {
  const reads: string[] = [];
  const f = await textClaimHandoffFixture(
    (store) =>
      new Proxy(store, {
        get(target, property) {
          if (property === "readLiveTextCoverage") return async () => new Set<string>();
          if (property === "readDocStateAt")
            return async (...args: Parameters<typeof store.readDocStateAt>) => {
              reads.push(args[0]);
              return target.readDocStateAt(...args);
            };
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
  );
  let hold: ReturnType<typeof f.admission.reserve> | undefined;
  try {
    await f.append("legacy");
    await f.append("tail");
    await f.reopen(() => {
      const state = f.store.exportCommittedState();
      state.refs = [];
      f.store.restoreFromCommittedState(state);
    });
    reads.length = 0;
    hold = f.admission.reserve("hotDocLive", f.admission.available("hotDocLive"));
    await expect(f.append("legacy")).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    expect(reads).toEqual([]);
    hold.release();
    await f.append("legacy");
    expect(reads).toContain(f.contentId);
    expect((await f.readAll()).map((record) => record.entryId)).toEqual(["legacy", "tail"]);
    expect(f.admission.used("persistSeal")).toBe(0);
  } finally {
    hold?.release();
    await f.close();
  }
});
