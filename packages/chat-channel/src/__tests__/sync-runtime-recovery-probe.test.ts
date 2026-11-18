import { expect, test } from "bun:test";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { loadCommittedDoc } from "../sync/live/committed-doc";
import { createRuntimeDoc, RUNTIME_DOC_LIMITS } from "../sync/live/runtime-doc";
import { restoreRuntimeSuccessor } from "../sync/live/runtime-recovery";
import { SyncProtocolError } from "../sync/protocol/errors";
import { fixture } from "./sync-live-admission-fixture";

// 后继已有终态更新就是交接完成的证据，历史快照不可读也不应触发无用回放或复活实体。
test("runtime 后继已有提交时不依赖两代快照并保留实体终态", async () => {
  const f = await fixture();
  try {
    const tool = {
      kind: "semantic" as const,
      turnId: "turn",
      entryId: "tool",
      contentSlot: "tool",
      contentType: "application/json",
      semantic: { kind: "tool" as const, payload: { entityId: "tool-one", metadata: {} } },
    };
    await f.writer.accept(tool);
    await f.writer.rotateRuntime();
    await f.writer.accept({
      ...tool,
      semantic: { ...tool.semantic, payload: { ...tool.semantic.payload, terminal: true } },
    });
    const next = f.store.exportCommittedState().docs.find((doc) => doc.kind === "runtime" && doc.state === "active");
    if (!next) throw new Error("Missing runtime successor");
    const store = new Proxy(f.store, {
      get(target, property) {
        if (property === "readDocStateAt")
          return async () => {
            throw new Error("snapshot unavailable");
          };
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await restoreRuntimeSuccessor({
      options: {
        store,
        scope: f.scope,
        limits: RUNTIME_DOC_LIMITS,
        capacity: DEFAULT_SYNC_CAPACITY,
        random: deterministicRandomSource("runtime-probe"),
        digest: sha256Digest,
      },
      previousId: f.runtimeId,
      nextId: next.docId,
      renew: async () => {
        throw new Error("unexpected transfer write");
      },
      stop: (code, message, cause) => new SyncProtocolError(code, { message, cause }),
    });
    const loaded = await loadCommittedDoc(f.store, next.docId);
    if (!loaded) throw new Error("Missing committed runtime");
    try {
      expect(createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS, loaded.doc).exportForRotation()).toEqual([]);
    } finally {
      loaded.doc.destroy();
    }
  } finally {
    await f.close();
  }
});

// 多段后继已有实体基线与更新，恢复中断后从旧入口重试仍保留原前沿，不重放历史实体。
test("多段 runtime 恢复中途失败后重试保留已有实体和更新前沿", async () => {
  const f = await fixture();
  const event = (entityId: string) => ({
    kind: "semantic" as const,
    turnId: "turn",
    entryId: entityId,
    contentSlot: "tool",
    contentType: "application/json",
    semantic: { kind: "tool" as const, payload: { entityId, metadata: {} } },
  });
  try {
    await f.writer.accept(event("one"));
    await f.writer.rotateRuntime();
    const middle = f.store.exportCommittedState().docs.find((doc) => doc.kind === "runtime" && doc.state === "active");
    if (!middle) throw new Error("Missing middle runtime");
    await f.writer.accept(event("two"));
    await f.writer.rotateRuntime();
    const tail = f.store.exportCommittedState().docs.find((doc) => doc.kind === "runtime" && doc.state === "active");
    if (!tail) throw new Error("Missing tail runtime");
    f.faults.failProbeDocOnce = tail.docId;
    await expect(f.reopen()).rejects.toBe(f.probeError);
    await f.writer.acquire();
    await f.writer.accept(event("three"));
    const loaded = await loadCommittedDoc(f.store, tail.docId);
    if (!loaded) throw new Error("Missing recovered runtime");
    try {
      expect(
        createRuntimeDoc("runtime", RUNTIME_DOC_LIMITS, loaded.doc)
          .exportForRotation()
          .map((record) => record.entityId)
          .sort(),
      ).toEqual(["one", "three", "two"]);
    } finally {
      loaded.doc.destroy();
    }
    expect((await f.store.readUpdatesAfter(middle.docId, 0, 256)).length).toBe(1);
    expect((await f.store.readUpdatesAfter(tail.docId, 0, 256)).length).toBe(1);
  } finally {
    await f.close();
  }
});
