import { expect, test } from "bun:test";
import * as Y from "yjs";
import { SyncProtocolError } from "../sync/protocol/errors";
import { encodeSyncFrame, MAX_DATA_FRAME_BYTES } from "../sync/protocol/frames";
import type { WriterLease } from "../sync/store/types";
import {
  ackAll,
  CONTENT_DOC,
  dataFrames,
  type Harness,
  helloFrame,
  RUNTIME_DOC,
  rejectionOf,
  SCOPE_KEY,
  setup,
  subscribeFrame,
  tightCapacity,
} from "./sync-runtime-scope-fixture";

const WINDOW_BYTES = 96 * 1024;

/** 用真实Store和Yjs事务观察可拆分tail及不可拆分单条update的线上行为。 */
async function connected(
  contentFirst = false,
  capacity = tightCapacity({ windowBytes: WINDOW_BYTES }),
): Promise<{ h: Harness; lease: WriterLease; doc: Y.Doc }> {
  const h = await setup({ capacity });
  h.runtime.attachTransport(h.transport);
  await h.runtime.onInboundBytes(encodeSyncFrame(helloFrame()));
  await h.runtime.onInboundBytes(
    encodeSyncFrame(subscribeFrame(contentFirst ? [CONTENT_DOC, RUNTIME_DOC] : [RUNTIME_DOC])),
  );
  await ackAll(h.runtime, dataFrames(h.transport, 0));
  const lease = await h.store.acquireWriter(SCOPE_KEY, "wire-window-writer", 30_000);
  return { h, lease, doc: new Y.Doc() };
}

/** 一次Store批次保留两个连续独立更新，避免把待测分帧提前放进fixture。 */
async function append(h: Harness, lease: WriterLease, updates: readonly Uint8Array[]): Promise<void> {
  const result = await h.store.appendUpdates({
    scopeKey: SCOPE_KEY,
    epoch: lease.epoch,
    owner: lease.owner,
    batchId: "wire-window-updates",
    digest: "wire-window-updates-digest",
    expectedFrontiers: [{ docId: RUNTIME_DOC, lastSeq: 0 }],
    updates: updates.map((bytes, index) => ({ docId: RUNTIME_DOC, fromSeq: index + 1, bytes })),
  });
  expect(result.outcome).toBe("committed");
}

for (const [windowBytes, partBytes, softBytes] of [
  [96 * 1024, 40 * 1024, 128 * 1024],
  [512 * 1024, 120 * 1024, 256 * 1024],
] as const) {
  // 两个单独可发的更新合并后超过窗口或协议帧上限，必须拆帧并经真实ACK还原全部内容。
  test(`${windowBytes / 1024} KiB connection splits a replace-content tail within both wire limits`, async () => {
    const base = tightCapacity({ windowBytes });
    const capacity = { ...base, inputs: { ...base.inputs, activeSoftPayloadBytes: softBytes } };
    const { h, lease, doc } = await connected(false, capacity);
    const mirror = new Y.Doc();
    try {
      const updates: Uint8Array[] = [];
      doc.on("update", (bytes: Uint8Array) => updates.push(bytes));
      doc.getText("body").insert(0, "a".repeat(partBytes));
      doc.transact(() => {
        doc.getText("body").delete(0, partBytes);
        doc.getText("body").insert(0, "b".repeat(partBytes));
      });
      expect(updates).toHaveLength(2);
      const wireLimit = Math.min(windowBytes, MAX_DATA_FRAME_BYTES);
      expect(Y.mergeUpdates(updates).byteLength * (4 / 3)).toBeGreaterThan(wireLimit);
      expect(Y.encodeStateAsUpdate(doc).byteLength).toBeLessThan(h.config.capacity.inputs.runtimeHardSnapshotBytes);
      await append(h, lease, updates);
      const from = h.transport.sent.length;
      await h.runtime.tick();
      const acknowledged = new Set<string>();
      for (let pass = 0; pass < 4; pass += 1) {
        const frames = dataFrames(h.transport, from).filter((frame) => !acknowledged.has(frame.deliveryId));
        for (const frame of frames) acknowledged.add(frame.deliveryId);
        await ackAll(h.runtime, frames);
        await h.runtime.tick();
      }
      const frames = dataFrames(h.transport, from);
      expect(frames.map((frame) => frame.type === "DOC_UPDATE" && [frame.fromSeq, frame.toSeq])).toEqual([
        [1, 1],
        [2, 2],
      ]);
      for (const frame of frames) {
        expect(encodeSyncFrame(frame).byteLength).toBeLessThanOrEqual(wireLimit);
        Y.applyUpdate(mirror, Buffer.from(frame.payload, "base64"));
      }
      expect(mirror.getText("body").toString()).toBe("b".repeat(partBytes));
      expect(h.runtime.transportDiagnostics()).toEqual({ outstandingBytes: 0, pendingTasks: 0, unackedDeliveries: 0 });
      expect(h.transport.closeReasons).toEqual([]);
    } finally {
      doc.destroy();
      mirror.destroy();
      await h.runtime.dispose();
    }
  });
}

// 不可拆分的已提交更新超过窗口时，tick必须关闭真实传输并清账，同时保留原始容量错误。
test("a terminal oversized tail closes its bound gateway before tick rejects", async () => {
  const { h, lease, doc } = await connected();
  try {
    doc.getText("body").insert(0, "x".repeat(80 * 1024));
    await append(h, lease, [Y.encodeStateAsUpdate(doc)]);
    const before = h.transport.sent.length;
    const error = await rejectionOf(h.runtime.tick());
    expect(error.code).toBe("CAPACITY_EXCEEDED");
    expect(h.transport.closeReasons).toHaveLength(1);
    expect(h.transport.closeReasons[0]).toContain("provider session");
    expect(h.runtime.transportDiagnostics()).toEqual({ outstandingBytes: 0, pendingTasks: 0, unackedDeliveries: 0 });
    await h.runtime.tick();
    await h.runtime.onInboundBytes(encodeSyncFrame(subscribeFrame([RUNTIME_DOC])));
    expect(h.transport.sent).toHaveLength(before);
    expect(h.transport.closeReasons).toHaveLength(1);
  } finally {
    doc.destroy();
    await h.runtime.dispose();
  }
});

// 历史base比新窗口大时，入站订阅也必须通过同一个关闭通知清理连接。
test("a terminal oversized base closes the gateway on the inbound subscription path", async () => {
  const h = await setup({ capacity: tightCapacity({ windowBytes: WINDOW_BYTES }), seedText: "x".repeat(80 * 1024) });
  try {
    h.runtime.attachTransport(h.transport);
    await h.runtime.onInboundBytes(encodeSyncFrame(helloFrame()));
    const error = await rejectionOf(h.runtime.onInboundBytes(encodeSyncFrame(subscribeFrame([CONTENT_DOC]))));
    expect(error.code).toBe("CAPACITY_EXCEEDED");
    expect(h.transport.closeReasons).toHaveLength(1);
    expect(h.runtime.transportDiagnostics()).toEqual({ outstandingBytes: 0, pendingTasks: 0, unackedDeliveries: 0 });
    await h.runtime.tick();
    expect(h.transport.closeReasons).toHaveLength(1);
  } finally {
    await h.runtime.dispose();
  }
});

// 容量错误也可能来自仍可用的Store读路径，不能仅按错误码把健康会话判为终态。
test("a nonterminal capacity read error preserves the connection and original error", async () => {
  const { h, doc } = await connected();
  const read = h.store.readUpdatesAfter.bind(h.store);
  const failure = new SyncProtocolError("CAPACITY_EXCEEDED", { message: "transient read capacity refusal" });
  try {
    h.store.readUpdatesAfter = async () => {
      throw failure;
    };
    expect(await rejectionOf(h.runtime.tick())).toBe(failure);
    expect(h.transport.closeReasons).toEqual([]);
    h.store.readUpdatesAfter = read;
    await h.runtime.tick();
    expect(h.transport.closeReasons).toEqual([]);
  } finally {
    h.store.readUpdatesAfter = read;
    doc.destroy();
    await h.runtime.dispose();
  }
});

// 并发tick里的迟到读取不能在连接清账后重新登记永远不会上线的投递。
test("a late tail read cannot recreate delivery accounting after another tick closes the session", async () => {
  const { h, lease, doc } = await connected(true);
  const content = new Y.Doc();
  const read = h.store.readUpdatesAfter.bind(h.store);
  let release!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let pending: Promise<void> | undefined;
  try {
    content.getArray("records").insert(0, [{ value: "late" }]);
    await h.store.appendUpdates({
      scopeKey: SCOPE_KEY,
      epoch: lease.epoch,
      owner: lease.owner,
      batchId: "late-content-tail",
      digest: "late-content-tail-digest",
      expectedFrontiers: [{ docId: CONTENT_DOC, lastSeq: 0 }],
      updates: [{ docId: CONTENT_DOC, fromSeq: 1, bytes: Y.encodeStateAsUpdate(content) }],
    });
    doc.getText("body").insert(0, "x".repeat(80 * 1024));
    await append(h, lease, [Y.encodeStateAsUpdate(doc)]);
    h.store.readUpdatesAfter = async (id, seq, limit) => {
      const result = await read(id, seq, limit);
      if (id === CONTENT_DOC) {
        entered();
        await paused;
      }
      return result;
    };
    pending = h.runtime.tick();
    await started;
    expect((await rejectionOf(h.runtime.tick())).code).toBe("CAPACITY_EXCEEDED");
    expect(h.runtime.transportDiagnostics()).toEqual({ outstandingBytes: 0, pendingTasks: 0, unackedDeliveries: 0 });
    release();
    await pending;
    expect(h.runtime.transportDiagnostics()).toEqual({ outstandingBytes: 0, pendingTasks: 0, unackedDeliveries: 0 });
    expect(h.transport.closeReasons).toHaveLength(1);
  } finally {
    release();
    await pending;
    h.store.readUpdatesAfter = read;
    content.destroy();
    doc.destroy();
    await h.runtime.dispose();
  }
});

// 同一趟已规划帧还没有交给网关时发生后续读错，必须明确终止而不是永久遗失投递与额度。
test("a later Doc read failure closes a partially planned pass and releases all delivery accounting", async () => {
  const { h, lease, doc } = await connected(true);
  const content = new Y.Doc();
  const read = h.store.readUpdatesAfter.bind(h.store);
  const failure = new SyncProtocolError("CAPACITY_EXCEEDED", { message: "second doc unavailable" });
  try {
    content.getArray("records").push([{ value: "content" }]);
    doc.getText("body").insert(0, "runtime");
    await h.store.appendUpdates({
      scopeKey: SCOPE_KEY,
      epoch: lease.epoch,
      owner: lease.owner,
      batchId: "partial-pump",
      digest: "partial-pump-digest",
      expectedFrontiers: [
        { docId: CONTENT_DOC, lastSeq: 0 },
        { docId: RUNTIME_DOC, lastSeq: 0 },
      ],
      updates: [
        { docId: CONTENT_DOC, fromSeq: 1, bytes: Y.encodeStateAsUpdate(content) },
        { docId: RUNTIME_DOC, fromSeq: 1, bytes: Y.encodeStateAsUpdate(doc) },
      ],
    });
    h.store.readUpdatesAfter = async (id, seq, limit) => {
      if (id === RUNTIME_DOC) throw failure;
      return read(id, seq, limit);
    };
    const from = h.transport.sent.length;
    expect(await rejectionOf(h.runtime.tick())).toBe(failure);
    expect(h.transport.closeReasons).toHaveLength(1);
    expect(h.runtime.transportDiagnostics()).toEqual({ outstandingBytes: 0, pendingTasks: 0, unackedDeliveries: 0 });
    h.store.readUpdatesAfter = read;
    await h.runtime.tick();
    h.time.advance(h.config.deadlines.ackMs + 1);
    await h.runtime.tick();
    expect(h.transport.sent).toHaveLength(from);
    expect(h.transport.closeReasons).toHaveLength(1);
    expect(h.runtime.transportDiagnostics()).toEqual({ outstandingBytes: 0, pendingTasks: 0, unackedDeliveries: 0 });
  } finally {
    h.store.readUpdatesAfter = read;
    content.destroy();
    doc.destroy();
    await h.runtime.dispose();
  }
});
