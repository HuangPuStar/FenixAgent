import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createAppWithDatabase } from "../app";
import { loadConfig } from "../config";
import { createDatabase } from "../db/client";
import { migrateConnection } from "../db/migrate";
import { opensandboxServer, sandboxBinding } from "../db/schema";
import { createSecretBox } from "../security/secret-box";
import { AllocationService } from "../services/allocation-service";
import { COUNT_ATTEMPT_METADATA_KEY, CountRecoveryService } from "../services/count-recovery-service";
import { PoolService } from "../services/pool-service";
import { ProxyService } from "../services/proxy-service";
import { ReconciliationWorker, SandboxLifecycleService } from "../services/sandbox-lifecycle-service";
import { ServerService } from "../services/server-service";

const handles: ReturnType<typeof createDatabase>[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.sqlite.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(remote: (url: URL, init?: RequestInit) => Promise<Response>, databasePath = ":memory:") {
  const handle = createDatabase(databasePath);
  handles.push(handle);
  migrateConnection(handle.db, handle.sqlite);
  const config = loadConfig({
    SERVER_API_KEY_ENCRYPTION_KEY: "0".repeat(32),
    CLUSTER_SERVICE_API_KEY: "count-recovery-test",
    FRP_TOKEN: "test",
    FRP_PUBLIC_ADDRESS: "localhost",
  });
  new PoolService(handle.db).create({ id: "p", name: "Pool" });
  const servers = new ServerService(handle.db, createSecretBox(config.serverApiKeyEncryptionKey));
  servers.create({
    id: "n",
    pool_id: "p",
    name: "Node",
    base_url: "http://node",
    workspace_root: "/workspace",
    api_key: "test-node-key",
    max_sandboxes: 10,
  });
  handle.db.update(opensandboxServer).set({ healthStatus: "healthy" }).run();
  const fetchImpl = Object.assign(
    (url: Parameters<typeof fetch>[0], init?: RequestInit) => remote(new URL(String(url)), init),
    { preconnect: fetch.preconnect },
  );
  const allocations = new AllocationService(handle.db, handle.sqlite, config);
  const recovery = new CountRecoveryService(handle.db, config, servers, allocations, fetchImpl);
  const lifecycle = new SandboxLifecycleService(handle.db, handle.sqlite, config, servers, fetchImpl);
  const app = createAppWithDatabase(config, handle.db, handle.sqlite, {
    fetch: fetchImpl,
    countRecovery: recovery,
    lifecycle,
  });
  const req = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
    app.handle(
      new Request(`http://cluster${path}`, {
        method,
        headers: { Authorization: "Bearer count-recovery-test", "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const row = () => handle.db.select().from(sandboxBinding).where(eq(sandboxBinding.sandboxId, "job")).get()!;
  const allocate = () => {
    allocations.allocate("p", "job", true);
    return allocations.find("job")!;
  };
  const create = (etag: string, conditional = true) =>
    req(
      "/api/v1/sandboxes/job/proxy/v1/sandboxes",
      "POST",
      { image: { uri: "alpine" }, metadata: { owner: "caller" } },
      conditional ? { "If-None-Match": "*", "If-Match": JSON.stringify(etag) } : {},
    );
  return { ...handle, config, servers, allocations, fetchImpl, recovery, lifecycle, app, req, row, allocate, create };
}

function discovered(attemptId: string, id = "native") {
  return Response.json({
    items: [{ id, metadata: { [COUNT_ATTEMPT_METADATA_KEY]: attemptId } }],
    pagination: { totalItems: 1, hasNextPage: false },
  });
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(1);
  expect(predicate()).toBe(true);
}

// 原生成功后所有关联和收尾写入失败，仍需保留原生响应供调用方使用。
test("native success survives both association and finish write failures", async () => {
  const f = fixture(async (_url, init) => {
    if (init?.method !== "POST") return discovered(f.row().attemptId!);
    f.sqlite.exec(`CREATE TRIGGER block_completion BEFORE UPDATE ON sandbox_binding
      WHEN OLD.state = 'creating' BEGIN SELECT RAISE(ABORT, 'completion unavailable'); END`);
    return Response.json({ id: "native" }, { status: 201 });
  });
  const binding = f.allocate();
  const response = await f.create(binding.allocation_etag);
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ id: "native" });
  expect(f.row().state).toBe("creating");
  f.sqlite.exec("DROP TRIGGER block_completion");
  await f.recovery.reconcileDue();
  expect(f.row()).toMatchObject({ state: "active", providerSandboxId: "native" });
});

// 仅管理创建添加持久尝试标记，旧代理请求保留调用方原有元数据。
test("only conditional count creates attach the persisted attempt metadata", async () => {
  const bodies: unknown[] = [];
  const f = fixture(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ id: `native-${bodies.length}` }, { status: 201 });
  });
  const binding = f.allocate();
  expect((await f.create(binding.allocation_etag)).status).toBe(201);
  expect(bodies[0]).toMatchObject({
    metadata: { owner: "caller", "opensandbox.cluster.attempt_id": f.row().attemptId },
  });
  f.allocations.release("job");
  const legacy = f.allocate();
  expect((await f.create(legacy.allocation_etag, false)).status).toBe(201);
  expect(bodies[1]).toMatchObject({ metadata: { owner: "caller" } });
  expect((bodies[1] as { metadata: unknown }).metadata).toEqual({ owner: "caller" });
});

// 历史空尝试标识没有可靠恢复依据，管理创建拒绝转发，旧式调用保留原契约。
test("historical allocations without attempt IDs reject conditional creates but preserve legacy creates", async () => {
  const bodies: unknown[] = [];
  const f = fixture(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "native" }, { status: 201 });
  });
  f.allocate();
  f.db.update(sandboxBinding).set({ attemptId: null }).where(eq(sandboxBinding.sandboxId, "job")).run();
  const binding = f.allocations.find("job")!;
  expect((await f.create(binding.allocation_etag)).status).toBe(409);
  expect(bodies).toEqual([]);
  expect(f.row()).toMatchObject({ state: "active", attemptId: null, providerSandboxId: null });
  const legacy = await f.create(binding.allocation_etag, false);
  expect(legacy.status).toBe(201);
  expect(await legacy.json()).toEqual({ id: "native" });
  expect(bodies).toEqual([{ image: { uri: "alpine" }, metadata: { owner: "caller" } }]);
  expect(f.row().providerSandboxId).toBe("native");
});

// 第一次关联事务短暂失败后重试同一 ID，不能重复发起原生创建。
test("retries a transient association write without repeating the native POST", async () => {
  let posts = 0;
  const f = fixture(async () => {
    posts++;
    return Response.json({ id: "native" }, { status: 201 });
  });
  let writes = 0;
  const remember = f.allocations.rememberProviderId.bind(f.allocations);
  spyOn(f.allocations, "rememberProviderId").mockImplementation((...args) => {
    if (++writes === 1) throw new Error("temporary association failure");
    remember(...args);
  });
  const binding = f.allocate();
  const proxy = new ProxyService(
    f.servers,
    f.allocations,
    1000,
    1000,
    f.fetchImpl,
    f.db,
    f.config,
    undefined,
    f.recovery,
  );
  const response = await proxy.proxy(
    new Request("http://cluster/v1/sandboxes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "If-None-Match": "*",
        "If-Match": JSON.stringify(binding.allocation_etag),
      },
      body: JSON.stringify({ image: { uri: "alpine" } }),
    }),
    "/v1/sandboxes",
    undefined,
    "job",
  );
  expect(response.status).toBe(201);
  expect(f.row().providerSandboxId).toBe("native");
  expect(writes).toBe(2);
  expect(posts).toBe(1);
});

// 关联写入持续失败后，通过服务端保存的尝试标记恢复绑定，不接管原生生命周期。
test("recovers a failed association through metadata without POST or DELETE retries", async () => {
  const methods: string[] = [];
  const f = fixture(async (url, init) => {
    methods.push(init?.method ?? "GET");
    if (init?.method === "POST") return Response.json({ id: "native" }, { status: 201 });
    const filter = new URLSearchParams(url.searchParams.get("metadata")!);
    expect(filter.get(COUNT_ATTEMPT_METADATA_KEY)).toBe(f.row().attemptId);
    expect(url.searchParams.get("page")).toBe("1");
    return discovered(f.row().attemptId!);
  });
  f.sqlite.exec(`CREATE TRIGGER block_id BEFORE UPDATE OF provider_sandbox_id ON sandbox_binding
    BEGIN SELECT RAISE(ABORT, 'association unavailable'); END`);
  const binding = f.allocate();
  expect((await f.create(binding.allocation_etag)).status).toBe(201);
  expect(f.row()).toMatchObject({ state: "uncertain", providerSandboxId: null });
  f.sqlite.exec("DROP TRIGGER block_id");
  await f.recovery.reconcileDue();
  expect(f.row()).toMatchObject({ state: "active", providerSandboxId: "native" });
  expect(methods).toEqual(["POST", "GET"]);
  expect(() => f.allocations.release("job", binding.allocation_etag)).toThrow();
});

// 暂时查不到结果会保留预留，稍后唯一匹配恢复时清除旧错误和退避信息。
test("clears retry diagnostics after a previously empty lookup recovers", async () => {
  let found = false;
  const f = fixture(async () =>
    found
      ? discovered(f.row().attemptId!)
      : Response.json({ items: [], pagination: { totalItems: 0, hasNextPage: false } }),
  );
  const binding = f.allocate();
  const original = f.allocations.beginCountCreate("job", binding.allocation_etag);
  f.allocations.finishCountCreate(original, false);
  await f.recovery.reconcileDue();
  expect(f.row().retryCount).toBe(1);
  expect(f.row().lastError).toBeTruthy();
  expect(f.row().nextRetryAt).not.toBeNull();
  found = true;
  f.db.update(sandboxBinding).set({ nextRetryAt: 0 }).where(eq(sandboxBinding.sandboxId, "job")).run();
  await f.recovery.reconcileDue();
  expect(f.row()).toMatchObject({
    state: "active",
    providerSandboxId: "native",
    retryCount: 0,
    nextRetryAt: null,
    lastError: null,
  });
});

// 重启丢失内存中的请求信息后，持久 creating 记录仍能与原生沙盒重新关联。
test("recovers a persisted creating allocation after reopening SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "count-recovery-"));
  directories.push(directory);
  const path = join(directory, "cluster.sqlite");
  const f = fixture(async () => new Response(null, { status: 500 }), path);
  const binding = f.allocate();
  f.allocations.beginCountCreate("job", binding.allocation_etag);
  const attemptId = f.row().attemptId!;
  const index = handles.findIndex((handle) => handle.sqlite === f.sqlite);
  if (index >= 0) handles.splice(index, 1);
  f.sqlite.close();
  const reopened = createDatabase(path);
  handles.push(reopened);
  const servers = new ServerService(reopened.db, createSecretBox(f.config.serverApiKeyEncryptionKey));
  const allocations = new AllocationService(reopened.db, reopened.sqlite, f.config);
  const remote = Object.assign(async () => discovered(attemptId), { preconnect: fetch.preconnect });
  await new CountRecoveryService(reopened.db, f.config, servers, allocations, remote).reconcileDue();
  expect(allocations.find("job")).toMatchObject({ state: "active", provider_sandbox_id: "native" });
});

// 原请求尚在途中时恢复器不能提前关联，避免观察到不完整的原生创建结果。
test("discovery waits until the original conditional POST settles", async () => {
  let complete!: (response: Response) => void;
  let posts = 0;
  let gets = 0;
  const f = fixture(async (_url, init) => {
    if (init?.method === "POST") {
      posts++;
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    }
    gets++;
    return discovered(f.row().attemptId!);
  });
  const binding = f.allocate();
  const creating = f.create(binding.allocation_etag);
  await until(() => posts === 1);
  await f.recovery.reconcileDue();
  expect(gets).toBe(0);
  expect(f.row().state).toBe("creating");
  complete(Response.json({ id: "native" }, { status: 201 }));
  expect((await creating).status).toBe(201);
  expect(f.row()).toMatchObject({ state: "active", providerSandboxId: "native" });
});

// 旧式无条件 POST 不能绕过管理创建的在途保护，在同一绑定上重复创建。
test("legacy create cannot bypass an in-flight conditional create", async () => {
  let complete!: (response: Response) => void;
  let posts = 0;
  const f = fixture(async () => {
    if (++posts === 1)
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    return Response.json({ id: "unexpected-second" }, { status: 201 });
  });
  const binding = f.allocate();
  const creating = f.create(binding.allocation_etag);
  await until(() => posts === 1);
  try {
    expect((await f.create(binding.allocation_etag, false)).status).toBe(409);
    expect(posts).toBe(1);
    expect(f.row()).toMatchObject({ state: "creating", providerSandboxId: null });
  } finally {
    complete(Response.json({ id: "native" }, { status: 201 }));
    await creating;
  }
  expect(f.row().providerSandboxId).toBe("native");
});

// 未知创建结果仍可能在节点运行，旧式 POST 也不能在同一绑定上重复创建。
test("legacy create cannot repeat an uncertain conditional create", async () => {
  let posts = 0;
  const f = fixture(async () => {
    posts++;
    return Response.json({ id: "unexpected" }, { status: 201 });
  });
  const binding = f.allocate();
  const original = f.allocations.beginCountCreate("job", binding.allocation_etag);
  f.allocations.finishCountCreate(original, false);
  expect((await f.create(binding.allocation_etag, false)).status).toBe(409);
  expect(posts).toBe(0);
  expect(f.row()).toMatchObject({ state: "uncertain", providerSandboxId: null });
});

// 管理创建也不能越过更早在途的旧式请求，避免在同一绑定上再发一个 POST。
test("conditional create cannot overtake pending legacy creates", async () => {
  const complete: ((response: Response) => void)[] = [];
  let posts = 0;
  const f = fixture(async () => {
    posts++;
    if (posts <= 2)
      return new Promise<Response>((resolve) => {
        complete.push(resolve);
      });
    return Response.json({ id: "native" }, { status: 201 });
  });
  const binding = f.allocate();
  const first = f.create(binding.allocation_etag, false);
  await until(() => posts === 1);
  const second = f.create(binding.allocation_etag, false);
  await until(() => posts === 2);
  complete[1]!(new Response(null, { status: 500 }));
  await second;
  try {
    expect((await f.create(binding.allocation_etag)).status).toBe(409);
    expect(posts).toBe(2);
    expect(f.row()).toMatchObject({ state: "active", providerSandboxId: null });
  } finally {
    complete[0]!(new Response(null, { status: 500 }));
    await first;
  }
  expect((await f.create(binding.allocation_etag)).status).toBe(201);
  expect(posts).toBe(3);
});

// 空、歧义、未穷尽分页和错误标记都不能证明归属，自动协调须保留预留。
test.each([
  { name: "empty", items: [], pagination: { totalItems: 0, hasNextPage: false } },
  { name: "multiple", items: [{ id: "one" }, { id: "two" }], pagination: { totalItems: 2, hasNextPage: false } },
  { name: "more pages", items: [{ id: "one" }], pagination: { totalItems: 2, hasNextPage: true } },
  { name: "inconsistent total", items: [{ id: "one" }], pagination: { totalItems: 2, hasNextPage: false } },
  { name: "missing pagination", items: [{ id: "one" }] },
  {
    name: "wrong metadata",
    items: [{ id: "one", metadata: { [COUNT_ATTEMPT_METADATA_KEY]: "other" } }],
    pagination: { totalItems: 1, hasNextPage: false },
  },
])("retains unresolved count reservation: $name", async (result) => {
  const f = fixture(async () => Response.json(result));
  const binding = f.allocate();
  const original = f.allocations.beginCountCreate("job", binding.allocation_etag);
  f.allocations.finishCountCreate(original, false);
  await f.recovery.reconcileDue();
  expect(f.row()).toMatchObject({ state: "uncertain", providerSandboxId: null });
  expect(f.row().nextRetryAt!).toBeGreaterThan(Date.now());
  expect(f.allocations.find("job")).toBeDefined();
});

// 旧查询晚到不能把原生 ID 写入同一业务 ID 后来重新建立的绑定。
test("a late lookup cannot associate a replacement attempt", async () => {
  let complete!: (response: Response) => void;
  let lookups = 0;
  const f = fixture(async () => {
    lookups++;
    return new Promise<Response>((resolve) => {
      complete = resolve;
    });
  });
  const binding = f.allocate();
  const original = f.allocations.beginCountCreate("job", binding.allocation_etag);
  f.allocations.finishCountCreate(original, false);
  const looking = f.recovery.reconcileDue();
  await until(() => lookups === 1);
  f.allocations.release("job", binding.allocation_etag);
  f.allocate();
  const replacement = f.row().attemptId;
  complete(discovered(original.attemptId!));
  await looking;
  expect(f.row()).toMatchObject({ state: "active", attemptId: replacement, providerSandboxId: null });
});

// 非 JSON 的旧原生调用即使无法观察资源，也不能阻止记录响应中的真实 ID。
test("optional resource observation cannot discard a valid native ID", async () => {
  const f = fixture(async () => Response.json({ id: "native" }, { status: 201 }));
  f.allocate();
  const response = await f.app.handle(
    new Request("http://cluster/api/v1/sandboxes/job/proxy/v1/sandboxes", {
      method: "POST",
      headers: { Authorization: "Bearer count-recovery-test", "Content-Type": "text/plain" },
      body: "not JSON",
    }),
  );
  expect(response.status).toBe(201);
  expect(f.row().providerSandboxId).toBe("native");
});

// 资源协调失败不能让 stop 提前结束，仍须等待数量关联查询使用完数据库。
test("worker stop waits for count recovery after resource reconciliation rejects", async () => {
  let complete!: (response: Response) => void;
  let lookups = 0;
  const f = fixture(async () => {
    lookups++;
    return new Promise<Response>((resolve) => {
      complete = resolve;
    });
  });
  const binding = f.allocate();
  f.allocations.beginCountCreate("job", binding.allocation_etag);
  spyOn(f.lifecycle, "reconcileDue").mockRejectedValue(new Error("resource lookup unavailable"));
  const worker = new ReconciliationWorker(f.lifecycle, f.recovery);
  worker.start();
  await until(() => lookups === 1);
  let stopped = false;
  const stopping = worker.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(stopped).toBe(false);
  complete(discovered(f.row().attemptId!));
  await stopping;
  expect(f.row().providerSandboxId).toBe("native");
});
