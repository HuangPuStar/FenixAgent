import { expect, test } from "bun:test";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import type { CommitContentBatchInput } from "../sync/store/live-content-batch-types";
import type { PlaneConnection, PlaneHarness } from "./sync-acceptance-planes-oracle";
import {
  createPlaneHarness,
  createPlaneStore,
  duplicateRecordIds,
  PlaneClock,
  TEXT_SLOT,
  textOfRecords,
  tightenWindow,
} from "./sync-acceptance-planes-oracle";

const WINDOW_BYTES = 64 * 1024;
const ENTRY_ID = "turn-1:assistant";
/** 各16KiB片都带不同序号和正文，独立暴露分片丢失、重排或重复。 */
const LARGE_DELTA = Array.from(
  { length: 16 },
  (_, index) => `${String(index).padStart(4, "0")}${String.fromCharCode(65 + index).repeat(16 * 1024 - 4)}`,
).join("");

/** 保留真实runtime、provider、transport、DocHub和Yjs镜像，观察真正上线并确认的字节。 */
async function assertCaughtUp(
  harness: PlaneHarness,
  client: PlaneConnection,
  expected: string,
  subscribeAll = false,
): Promise<void> {
  const docs = harness.docsOfKind("content");
  expect(docs.length).toBeGreaterThan(1);
  const canonical = (await Promise.all(docs.map((doc) => harness.canonicalRecords(doc.docId)))).flat();
  expect(textOfRecords(canonical, ENTRY_ID, TEXT_SLOT)).toBe(expected);
  expect(duplicateRecordIds(canonical)).toEqual([]);
  if (subscribeAll) {
    const remaining = docs.filter((doc) => doc.docId !== harness.seedContentDocId).map((doc) => doc.docId);
    await client.subscribe(remaining);
  }
  const subscribed = docs.filter((doc) => subscribeAll || doc.docId === harness.seedContentDocId);
  const allRecords = subscribed.flatMap((doc) => client.mirror.records(doc.docId));
  if (subscribeAll) expect(textOfRecords(allRecords, ENTRY_ID, TEXT_SLOT)).toBe(expected);
  expect(duplicateRecordIds(allRecords)).toEqual([]);
  for (const doc of docs) {
    const updates = await harness.store.readUpdatesAfter(doc.docId, 0, 1000);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.map((update) => update.updateSeq)).toEqual(
      Array.from({ length: updates.length }, (_, index) => index + 1),
    );
    expect(
      updates.every(
        (update) =>
          update.bytes.byteLength <=
          harness.config.capacity.inputs.payloadChunkMaxBytes + harness.config.capacity.inputs.recordHeaderMaxBytes,
      ),
    ).toBe(true);
    if (!subscribeAll && doc.docId !== harness.seedContentDocId) continue;
    expect(textOfRecords(client.mirror.records(doc.docId), ENTRY_ID, TEXT_SLOT)).toBe(
      textOfRecords(await harness.canonicalRecords(doc.docId), ENTRY_ID, TEXT_SLOT),
    );
    expect(client.applied.coverage(doc.docId).gaps).toEqual([]);
    expect(client.applied.duplicateUpdateSeqs(doc.docId)).toEqual([]);
    const acknowledgements = client.link.observedInbound.filter(
      (frame) => frame.type === "APPLY_ACK" && frame.docId === doc.docId && frame.result === "processed",
    );
    const confirmedDeliveries = new Set(
      acknowledgements.map((frame) => (frame.type === "APPLY_ACK" ? frame.deliveryId : "")),
    );
    expect(
      client.link.accepted.some(
        ({ frame }) =>
          ((frame.type === "DOC_UPDATE" && frame.docId === doc.docId && frame.toSeq === updates.at(-1)!.updateSeq) ||
            (frame.type === "DOC_BASE" && frame.docId === doc.docId && frame.baseSeq === updates.at(-1)!.updateSeq)) &&
          confirmedDeliveries.has(frame.deliveryId),
      ),
    ).toBe(true);
  }
  const wireUpdates = client.link.accepted.filter((record) => record.frame.type === "DOC_UPDATE");
  expect(wireUpdates.length).toBeGreaterThan(1);
  expect(wireUpdates.every((record) => record.bytes.byteLength <= WINDOW_BYTES)).toBe(true);
  expect(client.audit.outstandingBytes()).toBe(0);
  expect(client.gateway.outstandingDeliveries()).toBe(0);
  expect(client.audit.duplicateDeliveries).toEqual([]);
  expect(client.hub.queueDepth()).toBe(0);
  expect(client.fatal).toEqual([]);
  expect(client.link.closeReasons).toEqual([]);
}

// 单条大delta仍须分成可通过连接窗口的物理updates，否则已订阅客户端会永久停在空正文。
test("one atomic 256 KiB delta catches up through a real 64 KiB runtime/client window", async () => {
  const harness = await createPlaneHarness({ windowBytes: WINDOW_BYTES, seed: "live-text-window" });
  try {
    const client = harness.primary!;
    await client.handshake();
    await client.subscribe();
    await harness.writeText(LARGE_DELTA);
    const committed = textOfRecords(await harness.canonicalRecords(harness.seedContentDocId), ENTRY_ID, TEXT_SLOT);
    expect(committed.length).toBeGreaterThan(0);
    expect(textOfRecords(client.mirror.records(harness.seedContentDocId), ENTRY_ID, TEXT_SLOT)).toBe(committed);
    await assertCaughtUp(harness, client, LARGE_DELTA, true);
  } finally {
    await harness.disposeAll();
  }
});

// 新Doc首次订阅会发送完整base；用可放入窗口的尾块验证同一256KiB输入全部正文最终可见。
test("all content blocks of one 256 KiB delta arrive in order with bounded pieces and a 64 KiB window", async () => {
  const capacity = {
    ...DEFAULT_SYNC_CAPACITY,
    inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, payloadChunkMaxBytes: 15 * 1024 },
  };
  const harness = await createPlaneHarness({
    capacity: tightenWindow(WINDOW_BYTES, capacity),
    seed: "live-text-window-complete",
  });
  try {
    const client = harness.primary!;
    await client.handshake();
    await client.subscribe();
    await harness.writeText(LARGE_DELTA);
    await assertCaughtUp(harness, client, LARGE_DELTA, true);
  } finally {
    await harness.disposeAll();
  }
});

// 慢端不apply就没有ACK；恢复后须按原连续片序追平，不能产生窗口死锁或重复正文。
test("a paused 64 KiB client resumes and acknowledges every piece of one large atomic delta", async () => {
  const harness = await createPlaneHarness({ windowBytes: WINDOW_BYTES, seed: "live-text-window-slow" });
  try {
    const client = harness.primary!;
    await client.handshake();
    await client.subscribe();
    const priorAcks = client.link.observedInbound.filter((frame) => frame.type === "APPLY_ACK").length;
    const appliedBytesBeforePause = client.hub.loadedBytes();
    client.pause();
    await harness.writeText(LARGE_DELTA);
    expect(client.audit.outstandingBytes()).toBeGreaterThan(0);
    expect(client.audit.outstandingBytes()).toBeLessThanOrEqual(WINDOW_BYTES);
    expect(client.link.observedInbound.filter((frame) => frame.type === "APPLY_ACK")).toHaveLength(priorAcks);
    const partial = textOfRecords(client.mirror.records(harness.seedContentDocId), ENTRY_ID, TEXT_SLOT);
    expect(client.hub.loadedBytes()).toBe(appliedBytesBeforePause);
    expect(client.hub.queueDepth()).toBeGreaterThan(0);
    expect(LARGE_DELTA.startsWith(partial)).toBe(true);
    expect(partial.length).toBeLessThan(LARGE_DELTA.length);
    client.resume();
    await harness.pump();
    await assertCaughtUp(harness, client, LARGE_DELTA, true);
    expect(client.link.observedInbound.filter((frame) => frame.type === "APPLY_ACK").length).toBeGreaterThan(priorAcks);
  } finally {
    await harness.disposeAll();
  }
});

// 整批回执丢失时每片都须以固定batch身份确认，不能只探测首片或重新执行整条输入。
test("probes every piece after an unknown multi-update commit and continues from the confirmed frontier", async () => {
  const clock = new PlaneClock();
  const base = createPlaneStore(tightenWindow(WINDOW_BYTES), clock);
  const probes: string[] = [];
  let commits = 0;
  const store = new Proxy(base, {
    get(target, property) {
      if (property === "commitContentBatch")
        return async (input: CommitContentBatchInput) => {
          commits += 1;
          const result = await target.commitContentBatch(input);
          return commits === 1 ? { outcome: "unknown" as const, frontiers: [] } : result;
        };
      if (property === "readUpdatesAfter")
        return async (...args: Parameters<typeof target.readUpdatesAfter>) => {
          if (args[2] === 1) probes.push(`${args[0]}:${args[1]}`);
          return await target.readUpdatesAfter(...args);
        };
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const harness = await createPlaneHarness({
    store,
    clock,
    windowBytes: WINDOW_BYTES,
    seed: "live-text-window-unknown",
  });
  try {
    const client = harness.primary!;
    await client.handshake();
    await client.subscribe();
    await harness.writeText(LARGE_DELTA);
    expect(commits).toBe(1);
    const seedUpdates = await store.readUpdatesAfter(harness.seedContentDocId, 0, 1000);
    expect(seedUpdates.length).toBeGreaterThan(1);
    for (const doc of harness.docsOfKind("content")) {
      const updates = await store.readUpdatesAfter(doc.docId, 0, 1000);
      for (const update of updates) expect(probes).toContain(`${doc.docId}:${update.updateSeq - 1}`);
    }
    await harness.writeText("|after-unknown|");
    expect(commits).toBe(2);
    await assertCaughtUp(harness, client, `${LARGE_DELTA}|after-unknown|`, true);
  } finally {
    await harness.disposeAll();
    base.dispose();
  }
});
