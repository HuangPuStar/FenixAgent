import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createAppWithDatabase } from "../app";
import { opensandboxServer } from "../db/schema";
import { AllocationService } from "../services/allocation-service";
import { ProxyService } from "../services/proxy-service";
import { fixture } from "./managed-fixture";

function setup(remote: () => Promise<Response> = async () => Response.json({ id: "native" }, { status: 201 })) {
  const f = fixture(remote);
  f.pools.create({ id: "count", name: "Count" });
  f.servers.create({
    id: "count-node",
    pool_id: "count",
    name: "Count node",
    base_url: "http://node",
    workspace_root: "/workspace",
    api_key: "test",
    max_sandboxes: 1,
  });
  f.db.update(opensandboxServer).set({ healthStatus: "healthy" }).where(eq(opensandboxServer.id, "count-node")).run();
  const allocations = new AllocationService(f.db, f.sqlite, f.config, f.lifecycle);
  const app = createAppWithDatabase(f.config, f.db, f.sqlite, {
    fetch: Object.assign(remote, { preconnect: fetch.preconnect }),
  });
  const request = (path: string, method = "GET", headers: Record<string, string> = {}, body?: unknown) =>
    app.handle(
      new Request(`http://cluster${path}`, {
        method,
        headers: { Authorization: "Bearer test-key", "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const allocate = () => {
    allocations.allocate("count", "job", true);
    return allocations.find("job")!;
  };
  const path = "/api/v1/sandboxes/job/allocation";
  return { ...f, allocations, request, allocate, path };
}

// 二次确认后的解绑不受创建状态限制，条件头仍用于核对选中的分配代次。
test.each([
  { state: "creating", conditional: true },
  { state: "uncertain", conditional: true },
  { state: "creating", conditional: false },
  { state: "uncertain", conditional: false },
])("manual unbind accepts $state with conditional=$conditional", async ({ state, conditional }) => {
  let nodeCalls = 0;
  const f = setup(async () => {
    nodeCalls++;
    return Response.json({ id: "unused" });
  });
  const binding = f.allocate();
  const original = f.allocations.beginCountCreate("job", binding.allocation_etag);
  if (state === "uncertain") f.allocations.finishCountCreate(original, false);
  const response = await f.request(
    f.path,
    "DELETE",
    conditional ? { "If-Match": JSON.stringify(binding.allocation_etag) } : {},
  );
  expect(response.status).toBe(200);
  expect((await f.request(f.path)).status).toBe(404);
  expect(f.servers.findById("count-node")?.currentSandboxes).toBe(0);
  expect(nodeCalls).toBe(0);
});

// 请求体读取期间允许解绑；随后到达的旧请求不能在新绑定上创建或关联沙盒。
test("manual unbind during body parsing cannot forward through a replacement allocation", async () => {
  let posts = 0;
  const remote = Object.assign(
    async () => {
      posts++;
      return Response.json({ id: "old-native" }, { status: 201 });
    },
    { preconnect: fetch.preconnect },
  );
  const f = setup(remote);
  const binding = f.allocate();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const request = new Request("http://cluster/v1/sandboxes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "If-None-Match": "*",
      "If-Match": JSON.stringify(binding.allocation_etag),
    },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        body = controller;
      },
    }),
  });
  const proxy = new ProxyService(f.servers, f.allocations, 1000, 1000, remote, f.db, f.config);
  const creating = proxy.proxy(request, "/v1/sandboxes", undefined, "job");
  expect(f.allocations.binding("job")?.state).toBe("creating");
  let replacement: ReturnType<typeof f.allocations.find>;
  try {
    expect((await f.request(f.path, "DELETE", { "If-Match": JSON.stringify(binding.allocation_etag) })).status).toBe(
      200,
    );
    replacement = f.allocate();
  } finally {
    body.enqueue(new TextEncoder().encode(JSON.stringify({ image: { uri: "alpine" } })));
    body.close();
  }
  expect((await creating).status).toBe(409);
  expect(posts).toBe(0);
  expect(f.allocations.find("job")).toMatchObject({
    allocation_etag: replacement!.allocation_etag,
    provider_sandbox_id: null,
    state: "active",
  });
});

// 删除旧绑定后允许重新分配，但迟到的旧 ETag 不能误删新绑定。
test("manual unbind retains the generation check and authentication", async () => {
  const f = setup();
  const binding = f.allocate();
  f.allocations.beginCountCreate("job", binding.allocation_etag);
  expect((await f.request(f.path, "DELETE", { Authorization: "Bearer invalid" })).status).toBe(401);
  expect((await f.request(f.path, "DELETE", { "If-Match": JSON.stringify(binding.allocation_etag) })).status).toBe(200);
  const replacement = f.allocate();
  expect((await f.request(f.path, "DELETE", { "If-Match": JSON.stringify(binding.allocation_etag) })).status).toBe(409);
  expect(f.allocations.find("job")?.allocation_etag).toBe(replacement.allocation_etag);
});

// 手动解绑之后，原创建的成功或失败回执都不能复活记录或污染重新分配的同名绑定。
test.each([
  { status: 201, replace: false },
  { status: 500, replace: false },
  { status: 201, replace: true },
  { status: 500, replace: true },
])("late create status=$status preserves manual unbind, replace=$replace", async ({ status, replace }) => {
  const started = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<Response>();
  const f = setup(async () => {
    started.resolve();
    return complete.promise;
  });
  const binding = f.allocate();
  const creating = f.request(
    "/api/v1/sandboxes/job/proxy/v1/sandboxes",
    "POST",
    {
      "If-None-Match": "*",
      "If-Match": JSON.stringify(binding.allocation_etag),
    },
    { image: { uri: "alpine" } },
  );
  await started.promise;
  let replacement: ReturnType<typeof f.allocations.find>;
  try {
    const response = await f.request(f.path, "DELETE", { "If-Match": JSON.stringify(binding.allocation_etag) });
    expect(response.status).toBe(200);
    expect((await f.request(f.path)).status).toBe(404);
    if (replace) replacement = f.allocate();
  } finally {
    complete.resolve(status === 201 ? Response.json({ id: "old-native" }, { status }) : new Response(null, { status }));
    await creating;
  }
  if (replace) {
    expect(f.allocations.find("job")).toMatchObject({
      allocation_etag: replacement!.allocation_etag,
      state: "active",
      provider_sandbox_id: null,
    });
    expect(f.servers.findById("count-node")?.currentSandboxes).toBe(1);
  } else {
    expect(f.allocations.find("job")).toBeUndefined();
    expect(f.servers.findById("count-node")?.currentSandboxes).toBe(0);
  }
});
