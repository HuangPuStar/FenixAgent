import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { createLiveWriter, type LiveRecordValue, type LiveWriter } from "../sync/live/live-writer";
import { RUNTIME_DOC_LIMITS } from "../sync/live/runtime-doc";
import { buildDocId, scopeKey } from "../sync/protocol/identity";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type { GenerationEntryRefs, SyncDocRecord } from "../sync/store/types";

const scope = { organizationId: "org", rcsSessionId: "rcs-test" };
const key = scopeKey(scope);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function snapshot(records: readonly LiveRecordValue[] = []): Uint8Array {
  const doc = new Y.Doc();
  const values = new Y.Array<LiveRecordValue>();
  doc.getMap("root").set("records", values);
  values.push([...records]);
  const result = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return result;
}
function boundary(entryId: string, toolCallId: string, ordinal: number): LiveRecordValue {
  return {
    recordId: `${entryId}:${ordinal}`,
    entryId,
    contentSlot: "boundary",
    contentType: "tool-boundary",
    partIndex: ordinal,
    kind: "tool_boundary",
    payload: encoder.encode(JSON.stringify({ toolCallId, ordinal })),
  };
}
async function fixture() {
  let now = 1000;
  const clock = { now: () => now };
  const store = new MemoryProjectionStore({
    clock,
    digest: sha256Digest,
    capacity: DEFAULT_SYNC_CAPACITY,
    lifecycle: { sealGraceMs: 100, retireGraceMs: 100 },
  });
  async function seed(generation: string, history: readonly LiveRecordValue[][]) {
    const lease = await store.acquireWriter(key, "seed", 1000);
    const pointer = await store.readScopePointer(key);
    const id = (kind: "content" | "runtime" | "control" | "directory", index: number) =>
      buildDocId({ kind, generation, blockIndex: index, nonce: "test" });
    const entryRefs: GenerationEntryRefs = {
      controlDocId: id("control", 0),
      directoryDocId: id("directory", 0),
      runtimeDocId: id("runtime", 0),
      contentDocIds: history.map((_, index) => id("content", index)),
    };
    const record = {
      scopeKey: key,
      generation,
      acpSessionId: "acp",
      loadId: "load",
      state: "staging" as const,
      importEndOrdinal: history.length,
      entryRefs,
      createdAt: now,
    };
    await store.createGeneration({ scopeKey: key, epoch: lease.epoch, generation: record });
    await store.commitGeneration({
      scopeKey: key,
      epoch: lease.epoch,
      newGeneration: record,
      entryClosure: entryRefs,
      expectedCurrent: pointer?.currentGeneration ?? null,
      expectedPointerRevision: pointer?.pointerRevision ?? 0,
      retired: [],
    });
    async function put(docId: string, kind: "content" | "runtime", index: number, values: readonly LiveRecordValue[]) {
      const bytes = snapshot(values);
      const doc: SyncDocRecord = {
        scopeKey: key,
        generation,
        docId,
        kind,
        state: kind === "content" ? "sealed" : "active",
        snapshot: bytes,
        hash: sha256Digest(bytes),
        baseSeq: 0,
        finalSeq: kind === "content" ? 0 : null,
        blockIndex: index,
        ordinalStart: null,
        ordinalEnd: null,
        dependsOn: [],
      };
      if (kind === "content") await store.putSealedIfAbsent({ scopeKey: key, epoch: lease.epoch, doc });
      else await store.createDoc({ scopeKey: key, epoch: lease.epoch, doc });
    }
    await put(entryRefs.runtimeDocId, "runtime", 0, []);
    for (const [index, values] of history.entries()) await put(id("content", index), "content", index, values);
    await store.releaseWriter(lease);
    now += 1;
  }
  let serial = 0;
  function writer(): LiveWriter {
    return createLiveWriter({
      scope,
      store,
      clock,
      digest: sha256Digest,
      random: deterministicRandomSource(`writer-${serial++}`),
      capacity: DEFAULT_SYNC_CAPACITY,
      merge: { maxDelayMs: 600000, maxBytes: 1000000 },
      limits: RUNTIME_DOC_LIMITS,
      rotation: {
        clock,
        random: deterministicRandomSource("rotate"),
        limits: RUNTIME_DOC_LIMITS,
        maxResidentMs: 600000,
        maxTransactions: 1000,
      },
    });
  }
  function all(generation: string): LiveRecordValue[] {
    return store
      .exportCommittedState()
      .docs.filter((doc) => doc.generation === generation && doc.kind === "content")
      .sort((a, b) => a.blockIndex - b.blockIndex)
      .flatMap((stored) => {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, stored.baseSnapshot);
        for (const update of store.exportCommittedState().updates.filter((update) => update.docId === stored.docId))
          Y.applyUpdate(doc, update.bytes);
        const records = doc.getMap("root").get("records");
        const values = records instanceof Y.Array ? (records.toArray() as LiveRecordValue[]) : [];
        doc.destroy();
        return values;
      });
  }
  return { seed, writer, all };
}
async function tool(writer: LiveWriter, id: string, ordinal?: number) {
  await writer.accept({
    turnId: "turn",
    entryId: "e",
    contentSlot: "text",
    contentType: "text/plain",
    kind: "semantic",
    semantic: {
      kind: "tool",
      payload: {
        entityId: id,
        boundary: true,
        ...(ordinal === undefined ? {} : { boundaryOrdinal: ordinal }),
        metadata: { status: "running" },
      },
    },
  });
}
function markers(records: readonly LiveRecordValue[]) {
  return records
    .filter((record) => record.kind === "tool_boundary")
    .map((record) => JSON.parse(decoder.decode(record.payload)) as { toolCallId: string; ordinal: number });
}

describe("第六轮：全闭包边界恢复", () => {
  // 写者必须读取所有 sealed 导入块，以历史最大 ordinal 续接，而不是在 active 尾块从零开始。
  test("R6 sealed 跨块历史 seed 加 recover 加新写者加轮转重放", async () => {
    const f = await fixture();
    await f.seed("g1", [[boundary("e", "t0", 0)], [boundary("e", "t1", 1)]]);
    const first = f.writer();
    await first.acquire();
    await tool(first, "t0");
    await tool(first, "t2");
    expect(markers(f.all("g1"))).toEqual([
      { toolCallId: "t0", ordinal: 0 },
      { toolCallId: "t1", ordinal: 1 },
      { toolCallId: "t2", ordinal: 2 },
    ]);
    await first.seal();
    await tool(first, "t3");
    await first.recover();
    await tool(first, "t2");
    await tool(first, "t4");
    await first.close();
    const second = f.writer();
    await second.acquire();
    await tool(second, "t1");
    await tool(second, "t5");
    expect(markers(f.all("g1"))).toEqual(
      Array.from({ length: 6 }, (_, ordinal) => ({ toolCallId: `t${ordinal}`, ordinal })),
    );
    await second.close();
  });

  // 显式 occurrence ordinal 区分同一 run 的同名工具；同一 occurrence 的重放仍幂等。
  test("R6 同名工具 occurrence 与重放", async () => {
    const f = await fixture();
    await f.seed("g1", [[boundary("e", "same", 0)]]);
    const writer = f.writer();
    await writer.acquire();
    await tool(writer, "same", 0);
    await tool(writer, "same", 1);
    await tool(writer, "same", 1);
    expect(markers(f.all("g1"))).toEqual([
      { toolCallId: "same", ordinal: 0 },
      { toolCallId: "same", ordinal: 1 },
    ]);
    await writer.close();
  });

  // generation 隔离：旧代次同名 entry/tool 不得压制新代次写入，也不得带入旧 ordinal。
  test("R6 generation 重建只 seed 当前闭包", async () => {
    const f = await fixture();
    await f.seed("g1", [[boundary("e", "old", 0), boundary("e", "old2", 1)]]);
    const first = f.writer();
    await first.acquire();
    await tool(first, "next");
    await first.close();
    await f.seed("g2", [[boundary("e", "new", 0)]]);
    const second = f.writer();
    await second.acquire();
    await tool(second, "old");
    expect(markers(f.all("g2"))).toEqual([
      { toolCallId: "new", ordinal: 0 },
      { toolCallId: "old", ordinal: 1 },
    ]);
    await second.close();
  });
});
