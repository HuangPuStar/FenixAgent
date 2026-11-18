import { expect, test } from "bun:test";
import * as Y from "yjs";
import { sha256Digest } from "../sync/clock";
import { loadCommittedDoc } from "../sync/live/committed-doc";
import type { LiveInput } from "../sync/live/live-writer";
import { createRuntimeDoc, RUNTIME_DOC_LIMITS } from "../sync/live/runtime-doc";
import { buildDocId, scopeKey } from "../sync/protocol/identity";
import { fixture, contentObjectInput as object } from "./sync-live-admission-fixture";

const tool: LiveInput = {
  kind: "semantic",
  turnId: "turn",
  entryId: "tool",
  contentSlot: "tool",
  contentType: "application/json",
  semantic: { kind: "tool", payload: { entityId: "tool-one", metadata: {} } },
};
async function activeEntities(f: Awaited<ReturnType<typeof fixture>>) {
  const doc = f.store.exportCommittedState().docs.find((item) => item.kind === "runtime" && item.state === "active");
  if (!doc) throw new Error("Missing active runtime");
  const loaded = await loadCommittedDoc(f.store, doc.docId);
  if (!loaded) throw new Error("Missing runtime state");
  try {
    return createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS, loaded.doc)
      .exportForRotation()
      .map((record) => record.entityId)
      .sort();
  } finally {
    loaded.doc.destroy();
  }
}

// 新 writer 先补齐已登记 successor 的目录交接，额度恢复后不再误选 sealed 前代。
test("目录交接拒绝后重开能完成发布并继续追加", async () => {
  const f = await fixture();
  try {
    await f.writer.accept(object("before"));
    const hold = f.admission.reserve("hotDocLive", f.admission.available("hotDocLive"));
    try {
      await expect(f.writer.seal()).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    } finally {
      hold.release();
    }
    await f.reopen();
    await f.writer.accept(object("after"));
    expect((await f.readAll()).map((record) => JSON.parse(new TextDecoder().decode(record.payload)))).toEqual([
      { value: "before" },
      { value: "after" },
    ]);
  } finally {
    await f.close();
  }
});

// 成功轮换后的重开也必须追随 runtime 路由，不能把已封口入口当成当前写入点。
test("runtime 轮换后重开保留活动实体且可继续写入", async () => {
  const f = await fixture();
  try {
    await f.writer.accept(tool);
    await f.writer.rotateRuntime();
    await f.reopen();
    await f.writer.accept({ ...tool, semantic: { kind: "error", payload: { entityId: "error-two", metadata: {} } } });
    expect(await activeEntities(f)).toEqual(["error-two", "tool-one"]);
  } finally {
    await f.close();
  }
});

// successor 已处理过工具终态后不能重新搬运旧实体，否则会复活已经结束的工具。
test("runtime 重开不会复活前代已经完成的实体", async () => {
  const f = await fixture();
  try {
    await f.writer.accept(tool);
    await f.writer.rotateRuntime();
    await f.writer.accept({
      ...tool,
      semantic: { kind: "tool", payload: { entityId: "tool-one", terminal: true, metadata: {} } },
    });
    await f.reopen();
    await f.writer.accept({ ...tool, semantic: { kind: "error", payload: { entityId: "error-two", metadata: {} } } });
    expect(await activeEntities(f)).toEqual(["error-two"]);
  } finally {
    await f.close();
  }
});

for (const kind of ["content", "runtime"] as const) {
  // 路由已提交而封口被拒时，新 writer 必须沿固定谱系完成封口，不能另建空后继。
  test(`${kind} 停在 sealing 后重开可完成固定交接`, async () => {
    const f = await fixture();
    try {
      if (kind === "content") await f.writer.accept(object("before"));
      else await f.writer.accept(tool);
      f.faults.failSeal = true;
      await expect(kind === "content" ? f.writer.seal() : f.writer.rotateRuntime()).rejects.toMatchObject({
        code: "ADMISSION_REJECTED",
      });
      f.faults.failSeal = false;
      if (kind === "runtime") expect(await activeEntities(f)).toEqual(["tool-one"]);
      await f.reopen();
      if (kind === "content") {
        await f.writer.accept(object("after"));
        expect(await f.readAll()).toHaveLength(2);
      } else {
        await f.writer.accept({
          ...tool,
          semantic: { kind: "error", payload: { entityId: "error-two", metadata: {} } },
        });
        expect(await activeEntities(f)).toEqual(["error-two", "tool-one"]);
      }
    } finally {
      f.faults.failSeal = false;
      await f.close();
    }
  });
}

// 连续轮换后的入口不变，恢复必须沿完整链找到唯一 active 尾块。
test("连续内容和 runtime 轮换后重开均可继续写入", async () => {
  const f = await fixture();
  try {
    await f.writer.accept(tool);
    for (let index = 0; index < 3; index++) {
      await f.writer.seal();
      await f.writer.rotateRuntime();
    }
    await f.reopen();
    await f.writer.accept(object("after"));
    await f.writer.accept({ ...tool, semantic: { kind: "error", payload: { entityId: "error-two", metadata: {} } } });
    expect(await f.readAll()).toHaveLength(1);
    expect(await activeEntities(f)).toEqual(["error-two", "tool-one"]);
  } finally {
    await f.close();
  }
});

// 路由读取必须按 scope 隔离；已知但无后继与未知文档不能混作同一种恢复依据。
test("后继读取区分未知文档且不会跨 scope 暴露路由", async () => {
  const f = await fixture();
  try {
    const before = f.store.exportCommittedState().docs.find((doc) => doc.docId === f.contentId);
    if (!before) throw new Error("Missing content");
    expect(await f.store.readSuccessor("another", f.contentId)).toBeNull();
    expect(await f.store.readSuccessor(before.scopeKey, "unknown")).toBeNull();
    expect(await f.store.readSuccessor(before.scopeKey, f.contentId)).toMatchObject({ state: "active", route: null });
    await f.writer.seal();
    expect(await f.store.readSuccessor(before.scopeKey, f.contentId)).toMatchObject({
      state: "sealed",
      route: { expectedLastSeq: 0 },
    });
  } finally {
    await f.close();
  }
});

// 空后继尚无任何事件时可补齐未完成的首次搬运；已有后续更新后不得再次重放前代。
test("恢复已登记的空 runtime 后继仅补齐首次活动实体交接", async () => {
  const f = await fixture();
  const key = scopeKey(f.scope);
  try {
    await f.writer.accept(tool);
    const old = await loadCommittedDoc(f.store, f.runtimeId);
    if (!old) throw new Error("Missing old runtime");
    try {
      const pointer = await f.store.readScopePointer(key);
      if (!pointer?.currentGeneration) throw new Error("Missing generation");
      const id = buildDocId({
        kind: "runtime",
        generation: pointer.currentGeneration,
        blockIndex: 0,
        nonce: "interrupted",
      });
      const empty = new Y.Doc();
      const snapshot = Y.encodeStateAsUpdate(empty);
      empty.destroy();
      await f.store.createDoc({
        scopeKey: key,
        epoch: pointer.writerEpoch,
        doc: {
          scopeKey: key,
          generation: pointer.currentGeneration,
          docId: id,
          kind: "runtime",
          state: "active",
          snapshot,
          hash: sha256Digest(snapshot),
          baseSeq: 0,
          finalSeq: null,
          blockIndex: 0,
          ordinalStart: null,
          ordinalEnd: null,
          dependsOn: [],
        },
      });
      await f.store.registerSuccessor({
        scopeKey: key,
        epoch: pointer.writerEpoch,
        predecessorDocId: f.runtimeId,
        successorDocId: id,
        expectedLastSeq: old.lastSeq,
      });
      const finalSnapshot = Y.encodeStateAsUpdate(old.doc);
      await f.store.sealDoc({
        scopeKey: key,
        epoch: pointer.writerEpoch,
        expectedLastSeq: old.lastSeq,
        docId: f.runtimeId,
        finalSnapshot,
        finalHash: sha256Digest(finalSnapshot),
        successorDocId: id,
        manifestChange: {},
      });
    } finally {
      old.doc.destroy();
    }
    await f.reopen();
    expect(await activeEntities(f)).toEqual(["tool-one"]);
    await f.writer.accept({
      ...tool,
      semantic: { kind: "tool", payload: { entityId: "tool-one", terminal: true, metadata: {} } },
    });
    await f.reopen();
    expect(await activeEntities(f)).toEqual([]);
  } finally {
    await f.close();
  }
});
