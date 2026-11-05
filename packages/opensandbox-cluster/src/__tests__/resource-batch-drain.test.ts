import { expect, test } from "bun:test";
import { sandboxBinding } from "../db/schema";
import { ReconciliationWorker } from "../services/sandbox-lifecycle-service";
import { fixture, input } from "./managed-fixture";

// 同批协调中的写库故障不能提前结束 drain，其他节点查询仍须完成并持久化结果。
test("worker drains sibling resource lookups after a retry write fails", async () => {
  const secondLookup = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<Response>();
  let lookups = 0;
  let posts = 0;
  const { lifecycle, db, sqlite } = fixture(async (_url, init) => {
    if (init?.method === "POST") return Response.json({ id: `native-${++posts}` });
    if (++lookups === 1) return new Response(null, { status: 500 });
    secondLookup.resolve();
    return releaseSecond.promise;
  });
  await lifecycle.create("p", input("a"));
  await lifecycle.create("p", input("b"));
  db.update(sandboxBinding).set({ state: "uncertain", providerSandboxId: null, nextRetryAt: 0 }).run();
  sqlite.exec(`CREATE TRIGGER block_retry BEFORE UPDATE ON sandbox_binding
    WHEN NEW.last_error IS NOT NULL BEGIN SELECT RAISE(ABORT, 'retry database unavailable'); END`);
  const worker = new ReconciliationWorker(lifecycle);
  worker.start();
  let stopping: Promise<void> | undefined;
  try {
    await secondLookup.promise;
    stopping = worker.stop();
    const result = await Promise.race([stopping.then(() => "stopped"), Bun.sleep(10).then(() => "pending")]);
    expect(result).toBe("pending");
  } finally {
    sqlite.exec("DROP TRIGGER block_retry");
    releaseSecond.resolve(
      Response.json({ items: [{ id: "native-second" }], pagination: { totalItems: 1, hasNextPage: false } }),
    );
    await (stopping ?? worker.stop());
    for (let i = 0; i < 100 && lifecycle.find("b")?.provider_sandbox_id !== "native-second"; i++) await Bun.sleep(1);
  }
  expect(lifecycle.find("b")).toMatchObject({ state: "active", provider_sandbox_id: "native-second" });
});

// 等待所有并发操作后仍须上抛原始写库错误，不能把协调失败当作成功。
test("resource reconciliation preserves retry write errors after draining", async () => {
  const { lifecycle, db, sqlite } = fixture(async (_url, init) =>
    init?.method === "POST" ? Response.json({ id: "native" }) : new Response(null, { status: 500 }),
  );
  await lifecycle.create("p", input("a"));
  db.update(sandboxBinding).set({ state: "uncertain", providerSandboxId: null, nextRetryAt: 0 }).run();
  sqlite.exec(`CREATE TRIGGER block_retry BEFORE UPDATE ON sandbox_binding
    WHEN NEW.last_error IS NOT NULL BEGIN SELECT RAISE(ABORT, 'retry database unavailable'); END`);
  await expect(lifecycle.reconcileDue()).rejects.toMatchObject({
    errors: [expect.objectContaining({ message: "retry database unavailable" })],
  });
});
