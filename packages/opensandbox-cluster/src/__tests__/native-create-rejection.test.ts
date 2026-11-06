import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createAppWithDatabase } from "../app";
import { opensandboxServer } from "../db/schema";
import { nativeCreateError } from "../services/native-create-error";
import { fixture, input } from "./managed-fixture";

const cpuRejection =
  'Failed to create or start container: 400 Client Error for http+docker://localhost/v1.45/containers/create?name=sandbox-c814cddc-d6ad-4740-9f21-4b7c2eb53524: Bad Request ("Range of CPUs is from 0.01 to 10.00, as there are only 10 CPUs available")';
const startFailure = (message = cpuRejection) =>
  Response.json({ code: "DOCKER::SANDBOX_START_FAILED", message }, { status: 500 });

// 错误信息只用于诊断，已知与未知错误码都不参与失败分类。
test("extracts structured native diagnostics", async () => {
  expect(await nativeCreateError(startFailure())).toMatchObject({ message: expect.stringContaining("Range of CPUs") });
  expect(
    await nativeCreateError(Response.json({ detail: { code: "UNKNOWN", message: "new failure" } }, { status: 503 })),
  ).toEqual({ message: "new failure" });
});

// 管理创建遇到任何节点错误均清理绑定，原生代理调用仍保留由调用方释放的绑定。
test.each([
  { code: "DOCKER::SANDBOX_START_FAILED", message: cpuRejection },
  { code: "DOCKER::SANDBOX_START_FAILED", message: 'could not select device driver "" with capabilities: [[gpu]]' },
  { code: "UNKNOWN", message: "unexpected native failure" },
])("count management rolls back $code and permits a corrected retry", async (failure) => {
  let rejected = true;
  const f = fixture(async () =>
    rejected ? Response.json(failure, { status: 500 }) : Response.json({ id: "native" }, { status: 201 }),
  );
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
  const app = createAppWithDatabase(f.config, f.db, f.sqlite, {
    fetch: Object.assign(
      async () =>
        rejected ? Response.json(failure, { status: 500 }) : Response.json({ id: "native" }, { status: 201 }),
      {
        preconnect: fetch.preconnect,
      },
    ),
  });
  const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
    app.handle(
      new Request(`http://cluster${path}`, {
        method,
        headers: { Authorization: "Bearer test-key", "Content-Type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const allocate = () =>
    request("/api/v1/pools/count/sandboxes/job/allocate", "POST", undefined, { "If-None-Match": "*" });
  const allocationPath = "/api/v1/sandboxes/job/allocation";
  const proxyPath = "/api/v1/sandboxes/job/proxy/v1/sandboxes";
  await allocate();
  const binding = (await (await request(allocationPath)).json()) as { allocation_etag: string };
  const response = await request(
    proxyPath,
    "POST",
    { resourceLimits: { cpu: "11000m" } },
    {
      "If-None-Match": "*",
      "If-Match": JSON.stringify(binding.allocation_etag),
    },
  );
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual(failure);
  expect(response.headers.get("X-Cluster-Create-Rejected")).toBe("true");
  expect((await request(allocationPath)).status).toBe(404);
  expect(f.servers.findById("count-node")?.currentSandboxes).toBe(0);

  // 同一业务 ID 可修正资源后重试，不需要手工解绑。
  rejected = false;
  expect((await allocate()).status).toBe(200);
  const retry = (await (await request(allocationPath)).json()) as { allocation_etag: string };
  expect(
    (
      await request(
        proxyPath,
        "POST",
        { resourceLimits: { cpu: "1000m" } },
        {
          "If-None-Match": "*",
          "If-Match": JSON.stringify(retry.allocation_etag),
        },
      )
    ).status,
  ).toBe(201);

  // 无条件旧调用失败后仍由调用方持有绑定，保留原有生命周期。
  expect((await request(allocationPath, "DELETE")).status).toBe(200);
  await allocate();
  rejected = true;
  const legacy = await request(proxyPath, "POST", { resourceLimits: { cpu: "11000m" } });
  expect(legacy.status).toBe(500);
  expect(legacy.headers.get("X-Cluster-Create-Rejected")).toBeNull();
  expect((await request(allocationPath)).status).toBe(200);
  expect((await request(allocationPath, "DELETE")).status).toBe(200);
});

// 资源模式复用同一错误分类，Docker 未创建容器时应立即归还预留。
test("resource management returns capacity after a Docker create rejection", async () => {
  const f = fixture(async () => startFailure());
  await expect(f.lifecycle.create("p", input("rejected"))).rejects.toMatchObject({ code: "CREATE_FAILED" });
  expect(f.lifecycle.find("rejected")).toBeUndefined();
  expect(f.servers.findById("n")?.allocatedResources?.cpu).toBe(0);
});

// GPU 启动错误和任意 5xx 均返回创建失败并清空资源预留，不猜测远端是否有残留。
test.each([
  { code: "DOCKER::SANDBOX_START_FAILED", message: 'could not select device driver "" with capabilities: [[gpu]]' },
  { code: "NEW_NODE_ERROR", message: "a previously unknown error" },
])("resource creates clean failed reservations for $code", async (failure) => {
  const f = fixture(async () => Response.json(failure, { status: 500 }));
  await expect(f.lifecycle.create("p", input("failed"))).rejects.toMatchObject({ code: "CREATE_FAILED" });
  expect(f.lifecycle.find("failed")).toBeUndefined();
  expect(f.servers.findById("n")?.allocatedResources?.cpu).toBe(0);
});

// 没有结构化错误信息的超时、断连状态和服务端错误也不能留下失败预留。
test.each([408, 499, 503])("resource creates clear HTTP %i failures without a message", async (status) => {
  const f = fixture(async () => new Response(null, { status }));
  await expect(f.lifecycle.create("p", input("failed"))).rejects.toMatchObject({ code: "CREATE_FAILED" });
  expect(f.lifecycle.find("failed")).toBeUndefined();
  expect(f.servers.findById("n")?.allocatedResources?.cpu).toBe(0);
});
