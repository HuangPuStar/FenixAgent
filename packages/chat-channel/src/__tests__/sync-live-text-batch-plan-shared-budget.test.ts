import { expect, test } from "bun:test";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { planLiveTextBatch } from "../sync/live/text-batch-plan";
import { createLiveIngress } from "../sync/runtime/ingress";
import { fixture } from "./sync-live-admission-fixture";
import { textBatchFixture } from "./sync-live-text-batch-plan-fixture";

// 规划和Store共用进程预算；合法大输入须能完整入站提交，不能只在独立规划额度下成功。
test("commits near-four MiB ingress text with the shared default planner and Store budgets", async () => {
  const f = await fixture();
  try {
    const text = "x".repeat(4 * 1024 * 1024 - 1024);
    const ingress = createLiveIngress({
      writer: f.writer,
      maxRecords: 4,
      maxBytes: DEFAULT_SYNC_CAPACITY.concurrency.liveWaitPerScopeBytes,
    });
    await ingress.accept({
      kind: "text-delta",
      turnId: "turn",
      entryId: "entry",
      contentSlot: "text",
      contentType: "text/plain",
      delta: text,
    });
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload)).join("")).toBe(text);
    expect(ingress.lastIngressSeq()).toBe(1);
    expect(f.admission.used("hotDocLive")).toBeGreaterThan(0);
    expect(f.admission.used("persistSeal")).toBe(0);
  } finally {
    await f.close();
  }
  expect(f.admission.used("hotDocLive")).toBe(0);
  expect(f.admission.used("persistSeal")).toBe(0);
});

// 两个池各有职责和硬限；编码池不足不能挪用live池，已取得的部分也必须归还。
test.each([
  1024,
  10 * 1024 * 1024,
  14 * 1024 * 1024,
])("releases both pools after a %i B persistence budget rejects planning", async (persistSeal) => {
  const capacity = {
    ...DEFAULT_SYNC_CAPACITY,
    serverPools: { ...DEFAULT_SYNC_CAPACITY.serverPools, persistSeal },
    inputs: {
      ...DEFAULT_SYNC_CAPACITY.inputs,
      payloadChunkMaxBytes: 1,
      activeHardEncodedBytes: 1024,
      directoryHardBytes: 8192,
    },
  };
  const f = await textBatchFixture(capacity);
  try {
    await expect(planLiveTextBatch({ ...f, request: f.request("x".repeat(4000)) })).rejects.toMatchObject({
      code: "ADMISSION_REJECTED",
    });
    expect(f.admission.used("hotDocLive")).toBe(0);
    expect(f.admission.used("persistSeal")).toBe(0);
  } finally {
    f.cursor.doc.destroy();
    f.store.dispose();
  }
});
