import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createAppWithDatabase } from "../app";
import { sandboxBinding } from "../db/schema";
import { fixture, input } from "./managed-fixture";

// 节点明确拒绝镜像拉取时返回具体错误，并移除本次预留，允许修正参数后重试。
test("rejected image creates return errors without retaining allocations", async () => {
  let fail = true;
  const { lifecycle, servers } = fixture(async () =>
    fail
      ? Response.json({ code: "DOCKER::SANDBOX_IMAGE_PULL_FAILED", message: "image does not exist" }, { status: 500 })
      : Response.json({ id: "native-1" }),
  );
  await expect(lifecycle.create("p", input("invalid"))).rejects.toMatchObject({
    code: "CREATE_FAILED",
    message: "image does not exist",
  });
  expect(lifecycle.find("invalid")).toBeUndefined();
  fail = false;
  await lifecycle.create("p", input("invalid"));
  expect(servers.findById("n")?.allocatedResources).toEqual({ cpu: 0.1, memoryMb: 10, diskGb: 1, gpuCount: 0 });
});
// 显式删除资源沙盒必须在远端确认消失后移除记录，终态记录同样允许删除。
test("managed DELETE removes active and terminal records after confirmed destruction", async () => {
  let gone = false;
  const remote = Object.assign(
    async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.method === "POST") return Response.json({ id: "native-1" });
      if (init?.method === "DELETE") {
        gone = true;
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: gone ? 404 : 200 });
    },
    { preconnect: fetch.preconnect },
  );
  const { db, sqlite, config, lifecycle } = fixture(remote);
  const app = createAppWithDatabase(config, db, sqlite, { fetch: remote, lifecycle });
  const remove = (id: string) =>
    app.handle(
      new Request(`http://cluster/api/v2/sandboxes/${id}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer test-key" },
      }),
    );
  await lifecycle.create("p", input("active"));
  expect((await remove("active")).status).toBe(204);
  expect(lifecycle.find("active")).toBeUndefined();
  for (const state of ["expired", "released", "failed"]) {
    gone = false;
    await lifecycle.create("p", input(state));
    db.update(sandboxBinding).set({ state }).where(eq(sandboxBinding.sandboxId, state)).run();
    expect((await remove(state)).status).toBe(204);
    expect(lifecycle.find(state)).toBeUndefined();
  }
});
// HTTP 创建错误和空清单都不能证明远端未创建，删除必须保留预留等待后续确认。
test("HTTP create errors retain reservations after empty discovery", async () => {
  const { lifecycle, servers } = fixture(async (_url, init) =>
    init?.method === "POST"
      ? new Response(null, { status: 500 })
      : Response.json({ items: [], pagination: { hasNextPage: false, totalItems: 0 } }),
  );
  await lifecycle.create("p", input("unknown"));
  expect(await lifecycle.remove("unknown")).toMatchObject({ state: "releasing" });
  expect(lifecycle.find("unknown")?.state).toBe("releasing");
  expect(servers.findById("n")?.allocatedResources?.cpu).toBe(0.1);
  await expect(lifecycle.create("p", input("full", 0.3))).rejects.toMatchObject({ code: "NO_CAPACITY" });
});
// 四维容量必须在同一节点满足，最后一张 GPU 并发只能创建一个。
test("reserves decimals and the final GPU without overselling", async () => {
  let serial = 0;
  const { lifecycle } = fixture(async () => Response.json({ id: `native-${++serial}` }));
  expect((await lifecycle.create("p", input("a", 0.1))).state).toBe("active");
  expect((await lifecycle.create("p", input("b", 0.2))).state).toBe("active");
  await expect(lifecycle.create("p", input("c"))).rejects.toMatchObject({ code: "NO_CAPACITY" });
  const other = fixture();
  const results = await Promise.allSettled([
    other.lifecycle.create("p", input("g1", 0.1, 1)),
    other.lifecycle.create("p", input("g2", 0.1, 1)),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
});
// 结果未知且元数据查询为空时继续占用，重复请求不能重发创建。
test("unknown creates retain reservations across reconciliation", async () => {
  let posts = 0;
  const { lifecycle } = fixture(async (_url, init) => {
    if (init?.method === "POST") {
      posts++;
      throw new Error("timeout");
    }
    return Response.json({ items: [] });
  });
  expect((await lifecycle.create("p", input("a"))).state).toBe("uncertain");
  await lifecycle.reconcile("a");
  await lifecycle.create("p", input("a"));
  expect(posts).toBe(1);
  await lifecycle.release("a");
  expect(lifecycle.find("a")?.state).toBe("releasing");
  await expect(lifecycle.create("p", input("full", 0.3))).rejects.toMatchObject({ code: "NO_CAPACITY" });
});
// 已知远端 ID 删除并确认不存在后归还额度，同时保留终态阻止自动重建。
test("release and expiry finalize only with confirmed absence", async () => {
  let destroyed = false;
  let serial = 0;
  const { lifecycle, db } = fixture(async (_url, init) => {
    if (init?.method === "POST") return Response.json({ id: `native-${++serial}` });
    if (init?.method === "DELETE") {
      destroyed = true;
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: destroyed ? 404 : 200 });
  });
  await lifecycle.create("p", input("a"));
  await lifecycle.release("a");
  expect(lifecycle.find("a")?.state).toBe("released");
  await expect(lifecycle.create("p", input("a"))).rejects.toMatchObject({ code: "ALLOCATION_RELEASED" });
  await lifecycle.create("p", input("b"));
  db.update(sandboxBinding).set({ expiresAt: 0 }).where(eq(sandboxBinding.sandboxId, "b")).run();
  await lifecycle.reconcileDue();
  expect(lifecycle.find("b")?.state).toBe("expired");
});
// 容量下调不能侵占既有资源预留。
test("capacity mutation cannot shrink below reserved resources", async () => {
  const { lifecycle, servers } = fixture();
  await lifecycle.create("p", input("a", 0.2));
  expect(() => servers.update("n", { cpu_capacity: 0.1 })).toThrow("capacity");
});
// 池默认租期变更后省略租期的重试沿用首次值，显式修改租期冲突。
test("idempotence retains resolved lease and rejects changed explicit lease", async () => {
  const { lifecycle, pools } = fixture();
  await lifecycle.create("p", { ...input("a"), lease_seconds: 60 });
  pools.update("p", { default_lease_seconds: 120 });
  expect((await lifecycle.create("p", input("a"))).state).toBe("active");
  await expect(lifecycle.create("p", { ...input("a"), lease_seconds: 120 })).rejects.toMatchObject({
    code: "IDEMPOTENCY_CONFLICT",
  });
});
// 删除失败不能归还 GPU 或其他维度的预留。
test("failed deletion keeps all reservations", async () => {
  const { lifecycle } = fixture(async (_url, init) =>
    init?.method === "POST" ? Response.json({ id: "native" }) : new Response(null, { status: 503 }),
  );
  await lifecycle.create("p", input("a", 0.1, 1));
  expect((await lifecycle.release("a")).state).toBe("releasing");
  await expect(lifecycle.create("p", input("b", 0.1, 1))).rejects.toMatchObject({ code: "NO_CAPACITY" });
});
// 释放意图先于迟到创建结果时，不得恢复 active，必须删除迟到资源。
test("late successful create honors durable release intent", async () => {
  let complete: (r: Response) => void = () => {};
  let deleted = false;
  const { lifecycle } = fixture(async (_url, init) => {
    if (init?.method === "POST")
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    if (init?.method === "DELETE") {
      deleted = true;
      return new Response(null, { status: 204 });
    }
    if (deleted) return new Response(null, { status: 404 });
    return Response.json({ items: [] });
  });
  const creating = lifecycle.create("p", input("a"));
  await lifecycle.release("a");
  expect(lifecycle.find("a")?.state).toBe("releasing");
  complete(Response.json({ id: "late-native" }));
  await creating;
  expect(deleted).toBe(true);
  expect(lifecycle.find("a")?.state).toBe("released");
});
// 四维预算每一维均独立拒绝超额申请。
test("every resource dimension is independently enforced", async () => {
  for (const [key, value] of Object.entries({ cpu: 0.4, memoryMb: 101, diskGb: 11, gpuCount: 2 })) {
    const { lifecycle } = fixture();
    const request = input("a");
    Object.assign(request.resources, { [key]: value });
    await expect(lifecycle.create("p", request)).rejects.toMatchObject({ code: "NO_CAPACITY" });
  }
});
// 元数据能找到容器时，原始创建请求尚未结束也不能提前归还额度。
test("metadata discovery cannot finalize while original POST remains pending", async () => {
  let complete: (r: Response) => void = () => {};
  let deleted = false;
  const { lifecycle } = fixture(async (_url, init) => {
    if (init?.method === "POST")
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    if (init?.method === "DELETE") {
      deleted = true;
      return new Response(null, { status: 204 });
    }
    return deleted ? new Response(null, { status: 404 }) : Response.json({ items: [{ id: "late" }] });
  });
  const creating = lifecycle.create("p", input("a"));
  await lifecycle.release("a");
  expect(deleted).toBe(false);
  expect(lifecycle.find("a")?.state).toBe("releasing");
  complete(Response.json({ id: "late" }));
  await creating;
  expect(lifecycle.find("a")?.state).toBe("released");
});
// HTTP 的资源模式创建返回直接 DTO，旧 allocation 可读取新增模式字段。
test("managed HTTP routes expose raw DTO and secure the existing proxy", async () => {
  let serial = 0;
  const fetchImpl = Object.assign(
    async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
      init?.method === "POST" ? Response.json({ id: `native-${++serial}` }) : Response.json({ ok: true }),
    { preconnect: fetch.preconnect },
  );
  const { db, sqlite, config, lifecycle } = fixture(fetchImpl);
  const app = createAppWithDatabase(config, db, sqlite, { fetch: fetchImpl, lifecycle });
  const headers = { Authorization: "Bearer test-key", "Content-Type": "application/json" };
  const req = (path: string, method = "GET", body?: unknown) =>
    app.handle(
      new Request("http://cluster" + path, { method, headers, body: body ? JSON.stringify(body) : undefined }),
    );
  const create = await req("/api/v2/pools/p/sandboxes", "POST", input("business"));
  expect(create.status).toBe(201);
  const dto = (await create.json()) as { sandbox_id: string; success?: boolean };
  expect(dto.sandbox_id).toBe("business");
  expect(dto.success).toBeUndefined();
  expect(create.headers.get("location")).toBe("/api/v2/sandboxes/business");
  const allocation = (await (await req("/api/v1/sandboxes/business/allocation")).json()) as { allocation_mode: string };
  expect(allocation.allocation_mode).toBe("resources");
  expect((await req("/api/v1/servers/n/resources")).status).toBe(200);
  const prefix = "/api/v1/sandboxes/business/proxy";
  expect((await req(prefix + "/v1/sandboxes/native-1")).status).toBe(200);
  expect((await req(prefix + "/v1/sandboxes/other")).status).toBe(403);
  expect((await req(prefix + "/v1/sandboxes/native-1", "DELETE")).status).toBe(403);
  expect((await req("/api/v1/servers/n/proxy/v1/sandboxes")).status).toBe(403);
  expect((await req(prefix + "/v1/sandboxes/native-1/renew-expiration", "POST", {})).status).toBe(403);
  expect((await req("/api/v1/pools/p/sandboxes/legacy/allocate", "POST")).status).toBe(409);
});
// 并发 HTTP 请求竞争最后一张 GPU，只能有一个成功且只发送一次远端 POST。
test("HTTP concurrent final GPU is admitted exactly once", async () => {
  let posts = 0;
  const fetchImpl = Object.assign(
    async () => {
      posts++;
      return Response.json({ id: "native" });
    },
    { preconnect: fetch.preconnect },
  );
  const { db, sqlite, config, lifecycle } = fixture(fetchImpl);
  const app = createAppWithDatabase(config, db, sqlite, { fetch: fetchImpl, lifecycle });
  const request = (id: string) =>
    app.handle(
      new Request("http://cluster/api/v2/pools/p/sandboxes", {
        method: "POST",
        headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
        body: JSON.stringify(input(id, 0.1, 1)),
      }),
    );
  const results = await Promise.all([request("a"), request("b")]);
  expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  expect(posts).toBe(1);
});
// 节点更新不能通过数量字段重新打开资源池通用代理，两种模式切换都要求先移空节点。
test("HTTP configuration cannot bypass the pool scheduling authority", async () => {
  let posts = 0;
  const fetchImpl = Object.assign(
    async () => {
      posts++;
      return Response.json({ id: "native" });
    },
    { preconnect: fetch.preconnect },
  );
  const { db, sqlite, config, lifecycle, servers, pools } = fixture(fetchImpl);
  const app = createAppWithDatabase(config, db, sqlite, { fetch: fetchImpl, lifecycle });
  const req = (path: string, body: unknown, method = "PUT") =>
    app.handle(
      new Request("http://cluster" + path, {
        method,
        headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const updated = await req("/api/v1/servers/n", { max_sandboxes: 10 });
  expect(updated.status).toBe(200);
  expect(await updated.json()).toMatchObject({ maxSandboxes: null });
  expect((await req("/api/v1/servers/n/proxy/v1/sandboxes", {}, "POST")).status).toBe(403);
  expect(posts).toBe(0);
  expect((await req("/api/v1/pools/p", { scheduling_mode: "count" })).status).toBe(409);
  pools.create({ id: "count-p", name: "Count" });
  servers.create({
    id: "count-n",
    pool_id: "count-p",
    name: "Count",
    base_url: "http://node",
    workspace_root: "/data",
    api_key: "test",
    max_sandboxes: 1,
  });
  expect(
    (
      await req("/api/v1/pools/count-p", {
        scheduling_mode: "resources",
        default_lease_seconds: 60,
        max_lease_seconds: 60,
      })
    ).status,
  ).toBe(409);
});
// 正式 tunnel 注册接口按池模式传递四维容量，不要求数量模式字段。
test("HTTP registers a resource tunnel node without max_sandboxes", async () => {
  const fetchImpl = Object.assign(async () => Response.json({ id: "tunnel-native" }), { preconnect: fetch.preconnect });
  const { db, sqlite, config, lifecycle } = fixture(fetchImpl);
  const app = createAppWithDatabase(config, db, sqlite, { fetch: fetchImpl, lifecycle });
  const req = (path: string, body: unknown) =>
    app.handle(
      new Request("http://cluster" + path, {
        method: "POST",
        headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const response = await req("/api/v1/servers", {
    id: "tunnel-n",
    pool_id: "p",
    name: "Tunnel",
    transport_mode: "tunnel",
    workspace_root: "/data",
    api_key: "test",
    cpu_capacity: 1,
    memory_capacity_mb: 100,
    disk_capacity_gb: 10,
    gpu_capacity: 2,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ transportMode: "tunnel", cpuCapacity: 1, maxSandboxes: null });
  const { opensandboxTunnelConnection } = await import("../db/schema");
  const now = Date.now();
  db.insert(opensandboxTunnelConnection)
    .values({
      serverId: "tunnel-n",
      frpRunId: "run",
      status: "connected",
      healthStatus: "healthy",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const request = input("tunnel-business", 0.4, 2);
  const created = await req("/api/v2/pools/p/sandboxes", request);
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({ server_id: "tunnel-n" });
});
// 租期终态错误码必须经过 v1 代理保持结构，不能降级为普通 PROXY_ERROR。
test("HTTP proxy preserves managed terminal codes", async () => {
  const fetchImpl = Object.assign(async () => Response.json({ id: "native" }), { preconnect: fetch.preconnect });
  const { db, sqlite, config, lifecycle } = fixture(fetchImpl);
  await lifecycle.create("p", input("expired-business"));
  db.update(sandboxBinding).set({ expiresAt: 0 }).run();
  const app = createAppWithDatabase(config, db, sqlite, { fetch: fetchImpl, lifecycle });
  const result = await app.handle(
    new Request("http://cluster/api/v1/sandboxes/expired-business/proxy/v1/sandboxes/native/resume", {
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
    }),
  );
  expect(result.status).toBe(410);
  expect(await result.json()).toMatchObject({ error: { code: "LEASE_EXPIRED" } });
  for (const [state, code, status] of [
    ["released", "ALLOCATION_RELEASED", 410],
    ["failed", "CREATE_FAILED", 409],
  ] as const) {
    db.update(sandboxBinding).set({ state }).run();
    const terminal = await app.handle(
      new Request("http://cluster/api/v1/sandboxes/expired-business/proxy/v1/sandboxes/native", {
        headers: { Authorization: "Bearer test-key" },
      }),
    );
    expect(terminal.status).toBe(status);
    expect(await terminal.json()).toMatchObject({ error: { code } });
  }
});
// 首次删除返回处理中后，后台协调仍须兑现删除意图，不能只留下终态记录。
test("asynchronous deletion removes history after a later confirmation", async () => {
  let confirm = false;
  const { lifecycle, db } = fixture(async (_url, init) =>
    init?.method === "POST" ? Response.json({ id: "native" }) : new Response(null, { status: confirm ? 404 : 503 }),
  );
  await lifecycle.create("p", input("async-delete"));
  expect((await lifecycle.remove("async-delete"))?.state).toBe("releasing");
  confirm = true;
  db.update(sandboxBinding).set({ nextRetryAt: 0 }).run();
  await lifecycle.reconcileDue();
  expect(lifecycle.find("async-delete")).toBeUndefined();
});
// 手工删除可以升级尚在回收的到期意图，回收成功后清除该记录。
test("explicit delete upgrades an in-progress expiry", async () => {
  let confirm = false;
  const { lifecycle } = fixture(async (_url, init) =>
    init?.method === "POST" ? Response.json({ id: "native" }) : new Response(null, { status: confirm ? 404 : 503 }),
  );
  await lifecycle.create("p", input("expiry-delete"));
  await lifecycle.release("expiry-delete", "expiry");
  confirm = true;
  expect(await lifecycle.remove("expiry-delete")).toBeUndefined();
  expect(lifecycle.find("expiry-delete")).toBeUndefined();
});
// 查询恢复后的空结果仍不能证明创建失败，不能将已有预留归还。
test("HTTP error reservations survive empty discovery after a lookup failure", async () => {
  let healthy = false;
  const { lifecycle, db } = fixture(async (_url, init) =>
    init?.method === "POST"
      ? new Response(null, { status: 500 })
      : healthy
        ? Response.json({ items: [], pagination: { hasNextPage: false, totalItems: 0 } })
        : new Response(null, { status: 503 }),
  );
  await lifecycle.create("p", input("old-retry"));
  expect((await lifecycle.release("old-retry")).state).toBe("releasing");
  healthy = true;
  db.update(sandboxBinding).set({ nextRetryAt: 0 }).run();
  await lifecycle.reconcileDue();
  expect(lifecycle.find("old-retry")?.state).toBe("releasing");
});
// 两个交错 DELETE 不得在其中一个已删行后让另一个读取空记录崩溃。
test("concurrent managed deletes both complete without retaining history", async () => {
  let finish: () => void = () => {};
  let deletes = 0;
  const { lifecycle } = fixture(async (_url, init) => {
    if (init?.method === "POST") return Response.json({ id: "native" });
    if (init?.method === "DELETE" && ++deletes === 1)
      await new Promise<void>((r) => {
        finish = r;
      });
    return new Response(null, { status: 404 });
  });
  await lifecycle.create("p", input("concurrent-delete"));
  const first = lifecycle.remove("concurrent-delete");
  for (let i = 0; i < 100 && deletes === 0; i++) await Bun.sleep(1);
  expect(await lifecycle.remove("concurrent-delete")).toBeUndefined();
  finish();
  expect(await first).toBeUndefined();
  expect(lifecycle.find("concurrent-delete")).toBeUndefined();
});
