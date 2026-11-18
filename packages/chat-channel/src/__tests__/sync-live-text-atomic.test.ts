import { expect, test } from "bun:test";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { createLiveWriter, LIVE_WRITER_LEASE_TTL_MS } from "../sync/live/live-writer";
import { RUNTIME_DOC_LIMITS } from "../sync/live/runtime-doc";
import { createLiveIngress } from "../sync/runtime/ingress";
import type { CommitContentBatchInput } from "../sync/store/live-content-batch-types";
import { fixture } from "./sync-live-admission-fixture";

/** 用极小真实内容块稳定制造一条输入跨块；故障只控制事务边界或回执。 */
async function setup(mode: "expire" | "lost" | "unknown-expire" | "normal") {
  const f = await fixture();
  await f.writer.close();
  let calls = 0;
  let routes = 0;
  const store = new Proxy(f.store, {
    get(target, property) {
      if (property === "commitContentBatch")
        return async (input: CommitContentBatchInput) => {
          calls++;
          if (mode === "expire" && calls === 1) f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
          if (mode === "unknown-expire" && calls === 1) {
            f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
            return { outcome: "unknown" as const, frontiers: [] };
          }
          const result = await target.commitContentBatch(input);
          return mode === "lost" && calls === 1 ? { outcome: "unknown" as const, frontiers: [] } : result;
        };
      if (property === "registerSuccessor")
        return async (...args: Parameters<typeof target.registerSuccessor>) => {
          if (mode === "expire" && routes++ === 0) f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
          return target.registerSuccessor(...args);
        };
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const capacity = {
    ...DEFAULT_SYNC_CAPACITY,
    inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, activeHardEncodedBytes: 500, payloadChunkMaxBytes: 64 },
  };
  const clock = { now: () => 1000 };
  const writer = createLiveWriter({
    scope: f.scope,
    store,
    clock,
    digest: sha256Digest,
    random: deterministicRandomSource("atomic-text"),
    capacity,
    admission: f.admission,
    merge: { maxDelayMs: 600000, maxBytes: 64 },
    limits: RUNTIME_DOC_LIMITS,
    rotation: {
      clock,
      random: deterministicRandomSource("atomic-rotation"),
      limits: RUNTIME_DOC_LIMITS,
      maxResidentMs: 600000,
      maxTransactions: 1000,
    },
  });
  await writer.acquire();
  const ingress = createLiveIngress({ writer, maxRecords: 4, maxBytes: 1 << 20 });
  const text = async () => (await f.readAll()).map((record) => new TextDecoder().decode(record.payload)).join("");
  return {
    ...f,
    writer,
    ingress,
    text,
    calls: () => calls,
    async close() {
      await writer.close();
      await f.close();
    },
  };
}
const delta = "A".repeat(64) + "B".repeat(64) + "C".repeat(64);
const input = {
  kind: "text-delta" as const,
  turnId: "turn",
  entryId: "entry",
  contentSlot: "text",
  contentType: "text/plain",
  delta,
};

// 中间轮转前失权时整条输入不可见，重新接管后完整重发不会重复已提交前缀。
test("跨块文本租约失败不留前缀，重发整条输入恰好一次", async () => {
  const f = await setup("expire");
  try {
    const before = f.store.exportCommittedState();
    await expect(f.ingress.accept(input)).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    expect(f.ingress.lastIngressSeq()).toBe(0);
    expect(await f.text()).toBe("");
    expect(f.store.exportCommittedState()).toEqual(before);
    await f.writer.acquire();
    await f.ingress.accept(input);
    expect(await f.text()).toBe(delta);
    expect(f.ingress.lastIngressSeq()).toBe(1);
  } finally {
    await f.close();
  }
});

// 同批回执丢失只能核对固定物理字节，不得重新规划并重复追加任何分片。
test("跨块文本提交后回执丢失经已提交字节确认", async () => {
  const f = await setup("lost");
  try {
    await f.ingress.accept(input);
    expect(await f.text()).toBe(delta);
    expect(f.calls()).toBe(1);
    expect(f.ingress.lastIngressSeq()).toBe(1);
  } finally {
    await f.close();
  }
});

// 空探测不能证明未知请求已经结束，失权后仍须停写并保留不确定结果。
test("跨块文本未知提交后过期保持停写且没有部分正文", async () => {
  const f = await setup("unknown-expire");
  try {
    await expect(f.ingress.accept(input)).rejects.toMatchObject({ code: "COMMIT_OUTCOME_UNKNOWN" });
    expect(await f.text()).toBe("");
    await expect(f.writer.acquire()).rejects.toMatchObject({ code: "COMMIT_OUTCOME_UNKNOWN" });
    expect(f.ingress.lastIngressSeq()).toBe(0);
  } finally {
    await f.close();
  }
});

// 同文增量可以合法连续到达，批次原子性不得被实现成按正文去重。
test("两条相同跨块增量各保留一次", async () => {
  const f = await setup("normal");
  try {
    await f.ingress.accept(input);
    await f.ingress.accept(input);
    expect(await f.text()).toBe(delta + delta);
    expect(f.ingress.lastIngressSeq()).toBe(2);
  } finally {
    await f.close();
  }
});
