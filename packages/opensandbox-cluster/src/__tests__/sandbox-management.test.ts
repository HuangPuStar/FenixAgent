import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createAppWithDatabase } from "../app";
import { loadConfig } from "../config";
import { createDatabase } from "../db/client";
import { migrateConnection } from "../db/migrate";
import { opensandboxServer, sandboxBinding } from "../db/schema";
import { createSecretBox } from "../security/secret-box";
import { PoolService } from "../services/pool-service";
import { ServerService } from "../services/server-service";

const handles: ReturnType<typeof createDatabase>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.sqlite.close();
});
function fixture(createResponse?: () => Promise<Response>) {
  const h = createDatabase(":memory:");
  handles.push(h);
  migrateConnection(h.db, h.sqlite);
  const config = {
    ...loadConfig({
      SERVER_API_KEY_ENCRYPTION_KEY: "0".repeat(32),
      CLUSTER_SERVICE_API_KEY: "test-key",
      FRP_TOKEN: "test",
      FRP_PUBLIC_ADDRESS: "localhost",
    }),
    databasePath: ":memory:",
  };
  const pools = new PoolService(h.db);
  pools.create({ id: "p", name: "Pool" });
  pools.create({ id: "other", name: "Other" });
  const servers = new ServerService(h.db, createSecretBox(config.serverApiKeyEncryptionKey));
  servers.create({
    id: "n",
    pool_id: "p",
    name: "Node",
    base_url: "http://node",
    workspace_root: "/workspace",
    api_key: "node-secret",
    max_sandboxes: 10,
  });
  h.db.update(opensandboxServer).set({ healthStatus: "healthy" }).run();
  const remote = Object.assign(
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/v1/sandboxes" && init?.method === "POST")
        return createResponse
          ? createResponse()
          : Response.json({ id: "native", status: { state: "Running" } }, { status: 201 });
      if (pathname === "/v1/sandboxes")
        return Response.json({
          items: [{ id: "native", status: { state: "Running" } }],
          pagination: { totalItems: 1, hasNextPage: false },
        });
      return pathname === "/v1/sandboxes/native"
        ? Response.json({ id: "native", status: { state: "Running" } })
        : new Response(null, { status: 404 });
    },
    { preconnect: fetch.preconnect },
  );
  const app = createAppWithDatabase(config, h.db, h.sqlite, { fetch: remote });
  const req = (
    path: string,
    method = "GET",
    body?: unknown,
    authenticated = true,
    extraHeaders: Record<string, string> = {},
  ) =>
    app.handle(
      new Request(`http://cluster${path}`, {
        method,
        headers: {
          ...(authenticated ? { Authorization: "Bearer test-key" } : {}),
          "Content-Type": "application/json",
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const allocate = (id: string) => req(`/api/v1/pools/p/sandboxes/${id}/allocate`, "POST");
  return { ...h, req, allocate };
}
// 管理列表必须鉴权，过滤和分页只返回对应池、节点的绑定。
test("lists allocations with authentication, filters and pagination", async () => {
  const { req, allocate } = fixture();
  expect((await req("/api/v1/sandbox-allocations", "GET", undefined, false)).status).toBe(401);
  await allocate("b");
  await allocate("a");
  const res = await req("/api/v1/sandbox-allocations?pool_id=p&server_id=n&page=2&pageSize=1");
  expect(res.status).toBe(200);
  const data = (await res.json()) as { total: number; items: { pool_id: string }[] };
  expect(data.total).toBe(2);
  expect(data.items).toHaveLength(1);
  expect(data.items[0].pool_id).toBe("p");
  expect(
    ((await (await req("/api/v1/sandbox-allocations?pool_id=other")).json()) as { items: unknown[] }).items,
  ).toEqual([]);
  expect((await req("/api/v1/sandbox-allocations?page=0")).status).toBe(400);
});
// 代理成功创建后保存真实 ID，同时保持原生请求结果不变。
test("records count sandbox IDs without changing proxy responses", async () => {
  const { req, allocate, db } = fixture();
  await allocate("business");
  const res = await req("/api/v1/sandboxes/business/proxy/v1/sandboxes", "POST", { image: { uri: "alpine" } });
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({ id: "native", status: { state: "Running" } });
  expect(
    db.select().from(sandboxBinding).where(eq(sandboxBinding.sandboxId, "business")).get()?.providerSandboxId,
  ).toBe("native");
});
// 数量模式观察原生资源配额供管理页展示，不改变原生响应或数量调度。
test("records resource limits for new count sandboxes and leaves historical limits unknown", async () => {
  const { req, allocate } = fixture();
  await allocate("old");
  await allocate("new");
  const response = await req("/api/v1/sandboxes/new/proxy/v1/sandboxes", "POST", {
    image: { uri: "alpine" },
    resourceLimits: { cpu: "500m", memory: "512Mi", disk: "2Gi", gpu: "1" },
  });
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ id: "native", status: { state: "Running" } });
  const list = (await (await req("/api/v1/sandbox-allocations")).json()) as {
    items: { sandbox_id: string; resources: unknown }[];
  };
  expect(list.items.find((item) => item.sandbox_id === "new")?.resources).toEqual({
    cpu: 0.5,
    memoryMb: 512,
    diskGb: 2,
    gpuCount: 1,
  });
  expect(list.items.find((item) => item.sandbox_id === "old")?.resources).toBeNull();
});
// URL 编码的业务 ID 必须与分配接口使用同一个标识，不能在代理层查成另一条绑定。
test("routes encoded business identifiers through the same allocation", async () => {
  const { req, allocate } = fixture();
  await allocate(encodeURIComponent("job:one two"));
  const res = await req(`/api/v1/sandboxes/${encodeURIComponent("job:one two")}/proxy/v1/sandboxes`, "POST", {
    image: { uri: "alpine" },
  });
  expect(res.status).toBe(201);
});
// 旧页面不能释放被重新建立的绑定，即使新的真实 ID 恰好相同。
test("conditional release refuses a replaced count allocation", async () => {
  const { req, allocate } = fixture();
  await allocate("reused");
  await req("/api/v1/sandboxes/reused/proxy/v1/sandboxes", "POST", { image: { uri: "alpine" } });
  const snapshot = (await (await req("/api/v1/sandboxes/reused/allocation")).json()) as { allocation_etag: string };
  await req("/api/v1/sandboxes/reused/allocation", "DELETE");
  await allocate("reused");
  await req("/api/v1/sandboxes/reused/proxy/v1/sandboxes", "POST", { image: { uri: "alpine" } });
  const res = await req("/api/v1/sandboxes/reused/allocation", "DELETE", undefined, true, {
    "If-Match": JSON.stringify(snapshot.allocation_etag),
  });
  expect(res.status).toBe(409);
  expect((await req("/api/v1/sandboxes/reused/allocation")).status).toBe(200);
});
// 旧数量模式页面不能通过相同业务 ID 误删后来创建的资源模式沙盒。
test("conditional count release refuses a replacement in resource mode", async () => {
  const { req, allocate, db } = fixture();
  await allocate("reused");
  db.update(sandboxBinding)
    .set({
      allocationMode: "resources",
      providerSandboxId: "native",
      state: "active",
      cpu: 1,
      memoryMb: 1024,
      diskGb: 1,
      gpuCount: 0,
      requestHash: "replacement",
      expiresAt: Date.now() + 60000,
      leaseSeconds: 60,
    })
    .where(eq(sandboxBinding.sandboxId, "reused"))
    .run();
  const snapshot = (await (await req("/api/v1/sandboxes/reused/allocation")).json()) as { allocation_etag: string };
  const res = await req("/api/v1/sandboxes/reused/allocation", "DELETE", undefined, true, {
    "If-Match": JSON.stringify(snapshot.allocation_etag),
  });
  expect(res.status).toBe(409);
  expect(db.select().from(sandboxBinding).where(eq(sandboxBinding.sandboxId, "reused")).get()?.state).toBe("active");
});
// 未关联绑定一旦观察到真实沙盒，旧页面的释放必须失败；未变化的空绑定仍可释放。
test("conditional release protects newly associated count allocations", async () => {
  const { req, allocate } = fixture();
  await allocate("pending");
  const path = "/api/v1/sandboxes/pending/allocation";
  const snapshot = (await (await req(path)).json()) as { allocation_etag: string };
  expect(typeof snapshot.allocation_etag).toBe("string");
  await req("/api/v1/sandboxes/pending/proxy/v1/sandboxes", "POST", { image: { uri: "alpine" } });
  expect(
    (await req(path, "DELETE", undefined, true, { "If-Match": JSON.stringify(snapshot.allocation_etag) })).status,
  ).toBe(409);
  await allocate("empty");
  const emptyPath = "/api/v1/sandboxes/empty/allocation";
  const empty = (await (await req(emptyPath)).json()) as { allocation_etag: string };
  expect(
    (await req(emptyPath, "DELETE", undefined, true, { "If-Match": JSON.stringify(empty.allocation_etag) })).status,
  ).toBe(200);
});
// 管理页的新建必须在分配事务里拒绝已有绑定，未知结果也不能通过重开表单重复创建。
test("conditional allocation refuses existing count IDs without changing legacy idempotency", async () => {
  const { req, allocate } = fixture();
  await allocate("existing");
  const res = await req("/api/v1/pools/p/sandboxes/existing/allocate", "POST", undefined, true, {
    "If-None-Match": "*",
  });
  expect(res.status).toBe(409);
  expect((await allocate("existing")).status).toBe(200);
});

// 移除的清单和手工关联接口不能继续暴露。
test("removed inventory and association routes return 404", async () => {
  const { req } = fixture();
  expect((await req("/api/v1/servers/n/sandboxes")).status).toBe(404);
  expect((await req("/api/v1/sandboxes/job/provider-id", "PUT", { provider_sandbox_id: "native" })).status).toBe(404);
});
// 管理页的明确镜像失败释放本次绑定，旧代理调用仍保留原有绑定契约。
test("conditional native rejection rolls back only the management allocation", async () => {
  const { req, allocate } = fixture(async () =>
    Response.json(
      { detail: { code: "DOCKER::SANDBOX_IMAGE_PULL_FAILED", message: "image does not exist" } },
      { status: 500 },
    ),
  );
  for (const id of ["managed", "legacy"]) {
    await allocate(id);
    const snapshot = (await (await req("/api/v1/sandboxes/" + id + "/allocation")).json()) as {
      allocation_etag: string;
    };
    const res = await req(
      "/api/v1/sandboxes/" + id + "/proxy/v1/sandboxes",
      "POST",
      { image: { uri: "missing" } },
      true,
      id === "managed" ? { "If-None-Match": "*", "If-Match": JSON.stringify(snapshot.allocation_etag) } : {},
    );
    expect(res.status).toBe(500);
    expect((await req("/api/v1/sandboxes/" + id + "/allocation")).status).toBe(id === "managed" ? 404 : 200);
    expect(res.headers.get("X-Cluster-Create-Rejected")).toBe(id === "managed" ? "true" : null);
  }
});
// 并发请求不能重复创建；超时后清理本次绑定，不需要管理员手工解绑。
test("conditional create is claimed once and cleans transport failures", async () => {
  let posts = 0;
  let finish: () => void = () => {};
  const { req, allocate } = fixture(async () => {
    posts++;
    await new Promise<void>((r) => {
      finish = r;
    });
    throw new Error("timeout");
  });
  await allocate("job");
  const snapshot = (await (await req("/api/v1/sandboxes/job/allocation")).json()) as { allocation_etag: string };
  const headers = { "If-None-Match": "*", "If-Match": JSON.stringify(snapshot.allocation_etag) };
  const create = () =>
    req("/api/v1/sandboxes/job/proxy/v1/sandboxes", "POST", { image: { uri: "alpine" } }, true, headers);
  const first = create();
  for (let i = 0; i < 100 && posts === 0; i++) await Bun.sleep(1);
  expect((await create()).status).toBe(409);
  finish();
  const failed = await first;
  expect(failed.status).toBe(502);
  expect(failed.headers.get("X-Cluster-Create-Rejected")).toBe("true");
  expect((await create()).status).toBe(404);
  expect(posts).toBe(1);
  expect((await req("/api/v1/sandboxes/job/allocation")).status).toBe(404);
});
// 转发前节点不可用也属于确定未创建，管理请求应释放本次数量绑定。
test("conditional creation cleans its slot when the node is unavailable before forwarding", async () => {
  const { req, allocate, db } = fixture();
  await allocate("offline");
  const snapshot = (await (await req("/api/v1/sandboxes/offline/allocation")).json()) as { allocation_etag: string };
  db.update(opensandboxServer).set({ status: "disabled" }).run();
  const response = await req(
    "/api/v1/sandboxes/offline/proxy/v1/sandboxes",
    "POST",
    { image: { uri: "alpine" } },
    true,
    { "If-None-Match": "*", "If-Match": JSON.stringify(snapshot.allocation_etag) },
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("X-Cluster-Create-Rejected")).toBe("true");
  expect((await req("/api/v1/sandboxes/offline/allocation")).status).toBe(404);
});
