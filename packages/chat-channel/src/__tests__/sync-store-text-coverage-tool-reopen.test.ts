import { expect, test } from "bun:test";
import { captureChange } from "../sync/live/change-capture";
import { loadCommittedDoc } from "../sync/live/committed-doc";
import { records } from "../sync/live/writer-support";
import { scopeKey } from "../sync/protocol/identity";
import { textClaimHandoffFixture } from "./sync-live-text-claim-handoff-fixture";

// 普通工具追加只撤回当前块证明，不能让大量已索引前驱在后续接管时重新回放。
test("千块索引历史经过通用工具追加后两次接管均跳过旧正文", async () => {
  const reads: string[] = [];
  const f = await textClaimHandoffFixture(
    (store) =>
      new Proxy(store, {
        get(target, property) {
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
  try {
    for (let index = 0; index < 1000; index++) await f.append(`indexed-${index}`);
    const key = scopeKey(f.scope),
      pointer = await f.store.readScopePointer(key);
    const active = f.store.exportCommittedState().docs.find((doc) => doc.kind === "content" && doc.state === "active")!;
    const loaded = await loadCommittedDoc(f.store, active.docId);
    const updates = [];
    for (const [index, kind] of (["tool_boundary", "final"] as const).entries()) {
      const bytes = captureChange(loaded!.doc, () =>
        records(loaded!.doc, [
          {
            recordId: `tool-${index}`,
            entryId: "tool",
            contentSlot: "tool",
            contentType: "application/json",
            partIndex: 0,
            kind,
            payload: new Uint8Array([1]),
          },
        ]),
      )!;
      updates.push({ docId: active.docId, fromSeq: active.lastSeq + index + 1, bytes });
    }
    loaded!.doc.destroy();
    expect(
      (
        await f.store.appendUpdates({
          scopeKey: key,
          epoch: pointer!.writerEpoch,
          owner: pointer!.writerOwner!,
          batchId: "normal-tools",
          digest: "normal-tools",
          expectedFrontiers: [{ docId: active.docId, lastSeq: active.lastSeq }],
          updates,
        })
      ).outcome,
    ).toBe("committed");
    for (const entry of ["fresh-first", "fresh-second"]) {
      await f.reopen();
      const predecessors = new Set(
        f.store
          .exportCommittedState()
          .docs.filter((doc) => doc.kind === "content" && doc.state === "sealed")
          .map((doc) => doc.docId),
      );
      reads.length = 0;
      await f.append(entry);
      expect(reads.filter((doc) => predecessors.has(doc))).toEqual([]);
    }
    await f.append("indexed-500");
    expect((await f.readAll()).filter((record) => record.kind === "text")).toHaveLength(1002);
  } finally {
    await f.close();
  }
});
