import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { readLegacyCommittedHistory } from "../channel/legacy-chat-history";
import { appendEntryText, ensureEntry, initChatDocStructure, setEntryStatus } from "../state/chat-writer";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { buildContentBlock } from "../sync/history/block-builder";
import { BlockBuildPool, deriveBuildPoolConfig } from "../sync/history/build-pool";
import { HistoryImportService } from "../sync/history/import-service";
import { HistorySpool } from "../sync/history/spool";
import { MemoryProjectionStore } from "../sync/store/memory-store";

// 真实导入链路必须把源角色写入 canonical content Doc，跨块切片与相同载荷也不得丢失角色。
test("历史源角色经过接收、分块与提交后完整保留", async () => {
  const root = await mkdtemp(join(tmpdir(), "history-role-"));
  const legacy = new Y.Doc();
  initChatDocStructure(legacy);
  for (const [entryId, role] of [
    ["callback_question", "user"],
    ["arbitrary:user", "assistant"],
  ] as const) {
    ensureEntry(legacy, { entryId, turnId: null, kind: "message", role });
    appendEntryText(legacy, entryId, "text:1", "text", "广州天气");
    setEntryStatus(legacy, entryId, "completed");
  }
  const capacity = {
    ...DEFAULT_SYNC_CAPACITY,
    inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, historyBlockTargetPayloadBytes: 1 },
  };
  const clock = { now: () => 1000 };
  const admission = new AdmissionController(capacity);
  const pool = new BlockBuildPool(deriveBuildPoolConfig(capacity.fairness), admission, clock);
  const store = new MemoryProjectionStore({
    clock,
    digest: sha256Digest,
    capacity,
    lifecycle: { sealGraceMs: 1000, retireGraceMs: 1000 },
  });
  const spool = new HistorySpool(
    { basePath: root, segmentBytes: 1024, taskQuotaBytes: 64 * 1024, processQuotaBytes: 256 * 1024 },
    clock,
  );
  const service = new HistoryImportService({
    store,
    spool,
    pool,
    clock,
    digest: sha256Digest,
    capacity,
    rand: deterministicRandomSource("role-import"),
    admission,
  });
  try {
    const { generation } = await service.begin({
      scope: { organizationId: "org-role", rcsSessionId: "rcs-role" },
      acpSessionId: "ses-role",
      owner: "role-test",
      leaseTtlMs: 60_000,
    });
    const source = readLegacyCommittedHistory(legacy, 2);
    for (const record of source) await service.accept(record.value, record.meta);
    await service.receivingComplete();
    await service.buildAndCommit();
    await service.finalize();
    const directory = await store.readDirectory({ generation, limit: 10 });
    expect(directory.entries).toHaveLength(4);
    const actual: unknown[] = [];
    for (const entry of directory.entries) {
      const state = await store.readDocStateAt(entry.docId, 0);
      if (!state) throw new Error("expected content snapshot");
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, state.snapshot);
        const records = doc.getMap("root").get("records") as Y.Array<Record<string, unknown>>;
        for (const record of records.toArray()) {
          actual.push([
            record.entryId,
            record.role,
            JSON.parse(new TextDecoder().decode(record.payload as Uint8Array)),
          ]);
        }
      } finally {
        doc.destroy();
      }
    }
    expect(actual).toEqual([
      ["callback_question", "user", "广州"],
      ["callback_question", "user", "天气"],
      ["arbitrary:user", "assistant", "广州"],
      ["arbitrary:user", "assistant", "天气"],
    ]);
    expect(spool.stats().totalBytes).toBe(0);
    expect(admission.used("historyBuild")).toBe(0);
  } finally {
    legacy.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

// 角色也是 canonical 内容的一部分，同载荷改角色重建后不得复用相同 CRDT struct 身份。
test("相同正文不同角色生成独立且确定的 canonical 字节", () => {
  const build = (role: "user" | "assistant") =>
    buildContentBlock({
      generation: "roles",
      blockIndex: 0,
      records: [
        {
          sourceOrdinal: 1,
          entryId: "same-id",
          entryOrder: 1,
          role,
          kind: "text_part",
          contentSlot: 0,
          partIndex: 0,
          payload: new TextEncoder().encode(JSON.stringify("同文")),
        },
      ],
      targetPayloadBytes: DEFAULT_SYNC_CAPACITY.inputs.historyBlockTargetPayloadBytes,
      hardLimitBytes: DEFAULT_SYNC_CAPACITY.inputs.historyBlockHardBytes,
      rand: deterministicRandomSource("role-bytes"),
      digest: sha256Digest,
    });
  const first = build("user");
  const again = build("user");
  const changed = build("assistant");
  expect(first.snapshot).toEqual(again.snapshot);
  expect(first.hash).not.toBe(changed.hash);
  const clientIds = [first, changed].map((block) => {
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, block.snapshot);
      return [...doc.store.clients.keys()];
    } finally {
      doc.destroy();
    }
  });
  expect(clientIds[0]).not.toEqual(clientIds[1]);
});
