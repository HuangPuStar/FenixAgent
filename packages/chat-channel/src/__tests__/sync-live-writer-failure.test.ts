import { expect, test } from "bun:test";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { LIVE_WRITER_LEASE_TTL_MS } from "../sync/live/live-writer";
import { scopeKey } from "../sync/protocol/identity";
import { fixture, contentObjectInput as object } from "./sync-live-admission-fixture";
import { writerFailureFixture } from "./sync-live-writer-failure-fixture";

const narrowCapacity = {
  ...DEFAULT_SYNC_CAPACITY,
  inputs: { ...DEFAULT_SYNC_CAPACITY.inputs, activeHardEncodedBytes: 2000 },
};

/** 稳定来源身份让重试仅补回被拒的文本，保留已提交对象。 */
function bufferedText() {
  return {
    kind: "text-delta" as const,
    turnId: "turn",
    entryId: "next",
    contentSlot: "text",
    contentType: "text/plain",
    delta: "y".repeat(1000),
  };
}

/** 先写半满内容块，使缓冲冲刷必须经过自动轮换。 */
async function fillContent(f: Awaited<ReturnType<typeof writerFailureFixture>>) {
  await f.writer.accept({
    ...object("before"),
    object: { value: { value: "x".repeat(1000) }, meta: { kind: "history_object", entryId: "before" } },
  });
}

for (const action of ["seal", "rotateRuntime"] as const) {
  // 原子路由事务在租约检查时拒绝，未发布任何后继的写者应能重新竞争写权。
  test(`${action} 路由提交前租约过期后同一 writer 可重新接管`, async () => {
    const f = await writerFailureFixture();
    try {
      await f.writer.accept(object("before"));
      const oldDocId = action === "seal" ? f.contentId : f.runtimeId;
      f.faults.beforeRoute = () => {
        f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
        return;
      };
      await expect(f.writer[action]()).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
      expect(await f.store.readSuccessor(scopeKey(f.scope), oldDocId)).toMatchObject({ state: "active", route: null });
      await f.writer.acquire();
      await f.writer[action]();
      await f.writer.accept(object("after"));
      expect((await f.readAll()).map((record) => JSON.parse(new TextDecoder().decode(record.payload)))).toEqual([
        { value: "before" },
        { value: "after" },
      ]);
    } finally {
      await f.close();
    }
  });

  // 路由已经发布时即使收到相同的过期错误，也不能跳过未完成封口继续写入。
  test(`${action} 路由提交后租约过期保持停写`, async () => {
    const f = await writerFailureFixture();
    try {
      await f.writer.accept(object("before"));
      const oldDocId = action === "seal" ? f.contentId : f.runtimeId;
      let routeInput: Parameters<typeof f.store.registerSuccessor>[0] | undefined;
      f.faults.beforeRoute = (input) => {
        routeInput = input;
        return;
      };
      f.faults.afterRoute = () => f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
      const pending = f.writer[action]();
      await expect(pending).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
      const failure: unknown = await pending.catch((error: unknown) => error);
      expect(routeInput).toBeDefined();
      expect(await f.store.readSuccessor(scopeKey(f.scope), oldDocId)).toMatchObject({
        docId: oldDocId,
        route: { successorDocId: routeInput!.successorDocId, expectedLastSeq: routeInput!.expectedLastSeq },
      });
      await expect(f.writer.acquire()).rejects.toBe(failure);
      await expect(f.writer.accept(object("blocked"))).rejects.toBe(failure);
      expect(await f.readAll()).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
}

// 内容路由与封口成功后目录尚未交接，租约过期不能重新开放未发布的 successor。
test("目录交接期间租约过期保持停写", async () => {
  const f = await writerFailureFixture();
  try {
    await f.writer.accept(object("before"));
    f.faults.beforeDirectoryAppend = () => f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
    const pending = f.writer.seal();
    await expect(pending).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    const failure: unknown = await pending.catch((error: unknown) => error);
    expect(await f.store.readSuccessor(scopeKey(f.scope), f.contentId)).toMatchObject({ state: "sealed" });
    await expect(f.writer.acquire()).rejects.toBe(failure);
    await expect(f.writer.accept(object("invisible"))).rejects.toBe(failure);
    expect(await f.readAll()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

// 屏障先冲刷文本，自动轮换的未提交过期不能被外围冲刷 catch 重新标成永久停写。
test("屏障冲刷触发自动轮换后正常过期仍可接管并重试文本", async () => {
  const f = await writerFailureFixture({ capacity: narrowCapacity });
  try {
    await fillContent(f);
    await f.writer.accept(bufferedText());
    f.faults.beforeRoute = () => {
      f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
      return;
    };
    await expect(f.writer.seal()).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    expect(await f.store.readSuccessor(scopeKey(f.scope), f.contentId)).toMatchObject({ state: "active", route: null });
    await f.writer.acquire();
    await f.writer.accept(object("after"));
    await f.writer.accept(bufferedText());
    await f.writer.seal();
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual([
      JSON.stringify({ value: "x".repeat(1000) }),
      JSON.stringify({ value: "after" }),
      "y".repeat(1000),
    ]);
  } finally {
    await f.close();
  }
});

// 定时器没有同步调用方接住异常，下一次写入仍须暴露原错，而重新竞争写权允许恢复。
test("后台冲刷的路由前过期保留原错且允许重新接管", async () => {
  const f = await writerFailureFixture({ capacity: narrowCapacity, maxDelayMs: 1 });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await fillContent(f);
    let entered: () => void = () => {};
    const routeEntered = new Promise<void>((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error("background flush did not reach route registration")), 1000);
      entered = () => {
        clearTimeout(deadline);
        resolve();
      };
    });
    f.faults.beforeRoute = () => {
      f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
      entered();
      return;
    };
    await f.writer.accept(bufferedText());
    await routeEntered;
    const pending = f.writer.seal();
    await expect(pending).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    const failure: unknown = await pending.catch((error: unknown) => error);
    await expect(f.writer.accept(object("observe"))).rejects.toBe(failure);
    await f.writer.acquire();
    await f.writer.accept(object("after"));
    expect(await f.readAll()).toHaveLength(2);
  } finally {
    clearTimeout(deadline);
    await f.close();
  }
});

// 重新竞争失败不能把故障清掉，只有成功恢复权威游标之后才可接收新输入。
test("冲刷过期后接管被占用仍保留原错直到成功重建", async () => {
  const f = await writerFailureFixture({ capacity: narrowCapacity });
  try {
    await fillContent(f);
    await f.writer.accept(bufferedText());
    f.faults.beforeRoute = () => {
      f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
      return;
    };
    const pending = f.writer.seal();
    await expect(pending).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    const failure: unknown = await pending.catch((error: unknown) => error);
    const other = await f.store.acquireWriter(scopeKey(f.scope), "other-writer", 1000);
    try {
      await expect(f.writer.acquire()).rejects.toMatchObject({ code: "SCOPE_BUSY" });
      await expect(f.writer.accept(object("blocked"))).rejects.toBe(failure);
    } finally {
      await f.store.releaseWriter(other);
    }
    await f.writer.acquire();
    await f.writer.accept(object("after"));
    expect(await f.readAll()).toHaveLength(2);
  } finally {
    await f.close();
  }
});

for (const phase of ["route", "directory", "unknown"] as const) {
  // 自动轮换的提交或不确定事实不能被可恢复过期例外放行，外围 catch 同样必须保持停写。
  test(`缓冲自动轮换在 ${phase} 阶段失去写权后禁止重新接管`, async () => {
    const f = await writerFailureFixture({ capacity: narrowCapacity });
    try {
      await fillContent(f);
      await f.writer.accept(bufferedText());
      const expire = () => f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
      if (phase === "route") f.faults.afterRoute = expire;
      else if (phase === "directory") f.faults.beforeDirectoryAppend = expire;
      else
        f.faults.beforeRoute = () => {
          expire();
          return { outcome: "unknown" };
        };
      const pending = f.writer.seal();
      await expect(pending).rejects.toMatchObject({
        code: phase === "unknown" ? "COMMIT_OUTCOME_UNKNOWN" : "LEASE_EXPIRED",
      });
      const failure: unknown = await pending.catch((error: unknown) => error);
      await expect(f.writer.acquire()).rejects.toBe(failure);
      await expect(f.writer.accept(object("blocked"))).rejects.toBe(failure);
      expect(await f.readAll()).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
}

// 先前未知的路由事务可能迟到提交；后续过期不能把已确认不存在误当作事务已结束。
test("未知路由回执后租约过期仍以未知结果停写", async () => {
  const f = await writerFailureFixture();
  try {
    let pendingRoute: Parameters<typeof f.store.registerSuccessor>[0] | undefined;
    f.faults.beforeRoute = (input) => {
      pendingRoute = input;
      f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
      return { outcome: "unknown" };
    };
    await expect(f.writer.seal()).rejects.toMatchObject({ code: "COMMIT_OUTCOME_UNKNOWN" });
    expect(pendingRoute).toBeDefined();
    expect(await f.store.readSuccessor(scopeKey(f.scope), f.contentId)).toMatchObject({ state: "active", route: null });
    await expect(f.writer.acquire()).rejects.toMatchObject({ code: "COMMIT_OUTCOME_UNKNOWN" });
    await expect(f.writer.accept(object("blocked"))).rejects.toMatchObject({ code: "COMMIT_OUTCOME_UNKNOWN" });
  } finally {
    await f.close();
  }
});

// 结果未知后的读取失败不能证明路由不存在，原始读取异常仍须保留用于诊断。
test("未知路由回执后读取失败保持未知结果停写", async () => {
  const f = await writerFailureFixture();
  try {
    f.faults.beforeRoute = () => {
      f.faults.failRouteRead = true;
      return { outcome: "unknown" };
    };
    const pending = f.writer.seal();
    await expect(pending).rejects.toMatchObject({ code: "COMMIT_OUTCOME_UNKNOWN", cause: f.readError });
    const failure: unknown = await pending.catch((error: unknown) => error);
    f.faults.failRouteRead = false;
    await expect(f.writer.acquire()).rejects.toBe(failure);
    await expect(f.writer.accept(object("blocked"))).rejects.toBe(failure);
    expect(await f.readAll()).toEqual([]);
  } finally {
    f.faults.failRouteRead = false;
    await f.close();
  }
});

for (const committed of [false, true]) {
  // 非确定异常可能发生在回执返回前，空路由也不能证明已发送的事务不会迟到提交。
  test(`路由登记异常后保持未知结果停写，实际已提交=${committed}`, async () => {
    const f = await writerFailureFixture();
    const replyError = new Error("route acknowledgement unavailable");
    let routeInput: Parameters<typeof f.store.registerSuccessor>[0] | undefined;
    try {
      f.faults.beforeRoute = (input) => {
        routeInput = input;
        if (!committed) throw replyError;
        return;
      };
      if (committed)
        f.faults.afterRoute = () => {
          throw replyError;
        };
      const pending = f.writer.seal();
      await expect(pending).rejects.toMatchObject({ code: "COMMIT_OUTCOME_UNKNOWN", cause: replyError });
      const failure: unknown = await pending.catch((error: unknown) => error);
      const state = await f.store.readSuccessor(scopeKey(f.scope), f.contentId);
      expect(routeInput).toBeDefined();
      expect(state).toMatchObject({
        docId: f.contentId,
        route: committed
          ? { successorDocId: routeInput!.successorDocId, expectedLastSeq: routeInput!.expectedLastSeq }
          : null,
      });
      await expect(f.writer.acquire()).rejects.toBe(failure);
      await expect(f.writer.accept(object("blocked"))).rejects.toBe(failure);
      expect(await f.readAll()).toEqual([]);
    } finally {
      await f.close();
    }
  });
}

// 批次探测与游标重载同时失败时，所有调用都必须保留首次停写错误的协议码和诊断链。
test("批次探测与游标重载均失败仍保留原始停写错误", async () => {
  const f = await fixture();
  try {
    f.faults.unknownAppendOnce = true;
    f.faults.failProbeReadOnce = true;
    f.faults.failReads = true;
    const pending = f.writer.accept(object("unknown"));
    await expect(pending).rejects.toMatchObject({ code: "COMMIT_OUTCOME_UNKNOWN" });
    const failure: unknown = await pending.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("Missing terminal error");
    expect(failure.cause).toBeInstanceOf(AggregateError);
    const diagnostic = failure.cause;
    if (!(diagnostic instanceof AggregateError)) throw new Error("Missing recovery diagnostics");
    expect(diagnostic.errors).toContain(f.probeError);
    expect(diagnostic.errors).not.toContain(failure);
    expect(
      diagnostic.errors.some((error: unknown) => error instanceof Error && error.message === "reload unavailable"),
    ).toBe(true);
    f.faults.failReads = false;
    await expect(f.writer.acquire()).rejects.toBe(failure);
    await expect(f.writer.accept(object("blocked"))).rejects.toBe(failure);
    expect(await f.readAll()).toEqual([]);
  } finally {
    f.faults.failReads = false;
    await f.close();
  }
});
