import { expect, test } from "bun:test";
import { textClaimHandoffFixture } from "./sync-live-text-claim-handoff-fixture";

// 首次判重排除活跃块后，轮转会把它变成可能含无索引文本的前驱，必须增量补读。
test("旧 active 轮转后新增前驱中的无索引文本仍判重", async () => {
  const f = await textClaimHandoffFixture();
  try {
    await f.append("legacy-active");
    await f.reopen(() => {
      const state = f.store.exportCommittedState();
      state.refs = [];
      f.store.restoreFromCommittedState(state);
    });
    await f.append("unrelated");
    await f.append("legacy-active");
    expect((await f.readAll()).map((record) => record.entryId)).toEqual(["legacy-active", "unrelated"]);
  } finally {
    await f.close();
  }
});

// 流式文本后续冲刷会把唯一 ref 移到新尾块，同身份的合法新定位不应撤回旧块的完整覆盖证明。
test("合法同身份引用移到新尾块后接管跳过旧块且重发不重复", async () => {
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
    await f.append("same");
    await f.writer.accept({
      kind: "text-delta",
      turnId: "same",
      entryId: "same",
      contentSlot: "text",
      contentType: "text/plain",
      delta: "continued",
    });
    await f.append("other");
    const original = f.store.exportCommittedState();
    const fragments = await f.readAll();
    const target = original.refs.find((ref) => ref.recordId === fragments[1]?.recordId)?.docId;
    expect(target).toBeDefined();
    expect(target).not.toBe(f.contentId);
    await f.reopen();
    reads.length = 0;
    await f.append("fresh");
    expect(reads).not.toContain(f.contentId);
    expect(reads).not.toContain(target);
    await f.append("same");
    expect(reads).not.toContain(f.contentId);
    expect((await f.readAll()).map((record) => record.entryId)).toEqual(["same", "same", "other", "fresh"]);
  } finally {
    await f.close();
  }
});

// Store 对整块索引覆盖的证明允许接管后新消息跳过所有现代块正文，规模不应放大 replay 读取。
test("全部 indexed 前驱接管后新声明不读取任何前驱正文", async () => {
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
    for (let index = 0; index < 32; index++) await f.append(`indexed-${index}`);
    await f.reopen();
    const predecessors = new Set(
      f.store
        .exportCommittedState()
        .docs.filter((doc) => doc.kind === "content" && doc.state === "sealed")
        .map((doc) => doc.docId),
    );
    reads.length = 0;
    await f.append("fresh");
    expect(reads.filter((docId) => predecessors.has(docId))).toEqual([]);
    expect((await f.readAll()).map((record) => record.entryId)).toHaveLength(33);
  } finally {
    await f.close();
  }
});
