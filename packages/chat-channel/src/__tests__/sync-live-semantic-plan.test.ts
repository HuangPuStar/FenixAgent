import { expect, test } from "bun:test";
import * as Y from "yjs";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { planSemanticWrite } from "../sync/live/live-writer-semantic";
import type { LiveRecordValue, LiveWriterOptions } from "../sync/live/live-writer-types";
import { RUNTIME_DOC_LIMITS } from "../sync/live/runtime-doc";
import { records } from "../sync/live/writer-support";
import { authorityFixture } from "./sync-live-writer-authority-fixture";

const DESCRIPTOR = { kind: "tool", contentRef: "existing", digest: "digest", byteLength: 0, completedAt: 1000 };

/** 使用固定 clientID 与独立手工 record 算临界容量，避免把 planner 输出当期望值。 */
async function planFixture() {
  const f = await authorityFixture();
  const content = new Y.Doc();
  content.clientID = 0xffffffff;
  const runtime = new Y.Doc();
  const old: LiveRecordValue = {
    recordId: "old",
    entryId: "old",
    contentSlot: "text",
    contentType: "text/plain",
    partIndex: 0,
    kind: "text",
    payload: new TextEncoder().encode("old"),
  };
  records(content, [old]);
  const expected = new Y.Doc();
  Y.applyUpdate(expected, Y.encodeStateAsUpdate(content));
  expected.clientID = content.clientID;
  records(expected, [
    {
      recordId: "rec_0123456789abcdef",
      entryId: "tool",
      contentSlot: "final",
      contentType: "final-descriptor",
      partIndex: 0,
      kind: "final",
      payload: new TextEncoder().encode(JSON.stringify({ entityId: "tool", ...DESCRIPTOR })),
    },
  ]);
  const hardLimit = Y.encodeStateAsUpdate(expected).byteLength;
  expected.destroy();
  const options: LiveWriterOptions = {
    scope: f.scope,
    store: f.store,
    clock: f.clock,
    digest: sha256Digest,
    random: deterministicRandomSource("semantic-plan"),
    capacity: {
      ...DEFAULT_SYNC_CAPACITY,
      inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, activeHardEncodedBytes: hardLimit },
    },
    admission: f.admission,
    limits: RUNTIME_DOC_LIMITS,
    merge: { maxDelayMs: 1000, maxBytes: 1000 },
    rotation: {
      clock: f.clock,
      random: deterministicRandomSource("semantic-rotation"),
      limits: RUNTIME_DOC_LIMITS,
      maxResidentMs: 1000,
      maxTransactions: 1000,
    },
  };
  return {
    content,
    options,
    hardLimit,
    plan(overrides: Partial<LiveWriterOptions> = {}) {
      return planSemanticWrite({
        semantic: { kind: "final", payload: { entityId: "tool", finalDescriptor: DESCRIPTOR } },
        entryId: "entry",
        boundaryOrdinal: null,
        content: { docId: "content", kind: "content", doc: content, lastSeq: 0 },
        runtime: { docId: "runtime", kind: "runtime", doc: runtime, lastSeq: 0 },
        rotateRuntime: false,
        options: { ...options, ...overrides },
      });
    },
    async close() {
      content.destroy();
      runtime.destroy();
      await f.close();
    },
  };
}

// 快速上界超过硬限时必须退回精确预演，不能把实际上恰好能容纳的当前块误判为必须轮换。
test("语义预演在字节硬限临界点保留能恰好容纳的当前块", async () => {
  const f = await planFixture();
  try {
    const before = Y.encodeStateAsUpdate(f.content);
    expect(f.plan()).toMatchObject({ rotateContent: false, overflow: null });
    expect(Y.encodeStateAsUpdate(f.content)).toEqual(before);
    expect(
      f.plan({
        capacity: {
          ...f.options.capacity,
          inputs: { ...f.options.capacity.inputs, activeHardEncodedBytes: f.hardLimit - 1 },
        },
      }),
    ).toMatchObject({ rotateContent: true, overflow: null });
    expect(Y.encodeStateAsUpdate(f.content)).toEqual(before);
  } finally {
    await f.close();
  }
});

// 上界缓存只缓存字节计数，后续任意 Yjs 记录替换都必须重新检查现有 payload 容量。
test("缓存预演后替换现有记录不会绕过 payload 上限", async () => {
  const f = await planFixture();
  try {
    expect(f.plan().overflow).toBeNull();
    const target = records<LiveRecordValue>(f.content);
    if (!target) throw new Error("missing records");
    const previous = target.get(0);
    target.delete(0, 1);
    target.push([{ ...previous, payload: new Uint8Array(4096) }]);
    const before = Y.encodeStateAsUpdate(f.content);
    expect(
      f.plan({
        capacity: { ...DEFAULT_SYNC_CAPACITY, inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, payloadChunkMaxBytes: 1024 } },
      }),
    ).toMatchObject({ rotateContent: true, overflow: null });
    expect(Y.encodeStateAsUpdate(f.content)).toEqual(before);
  } finally {
    await f.close();
  }
});
