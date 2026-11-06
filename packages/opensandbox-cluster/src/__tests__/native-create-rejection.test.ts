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

// 节点将 Docker 创建参数拒绝包装为 500 时，仍须识别出本次创建确定未成功。
test("recognizes Docker create rejection inside a native HTTP 500", async () => {
  expect(await nativeCreateError(startFailure())).toMatchObject({ rejected: true });
  expect(
    await nativeCreateError(
      Response.json({ detail: { code: "DOCKER::SANDBOX_START_FAILED", message: cpuRejection } }, { status: 500 }),
    ),
  ).toMatchObject({ rejected: true });
});

// 启动失败可能遗留容器，超时或服务端错误也不能证明创建未生效。
test.each([
  cpuRejection.replace("/containers/create?name=sandbox-c814cddc-d6ad-4740-9f21-4b7c2eb53524", "/containers/id/start"),
  cpuRejection.replace("400 Client Error", "408 Client Error"),
  cpuRejection.replace("400 Client Error", "499 Client Error"),
  cpuRejection.replace("400 Client Error", "500 Server Error"),
  "Failed to create or start container: connection reset by peer",
  "Docker did not return a container ID.",
])("keeps an uncertain reservation for %s", async (message) => {
  expect(await nativeCreateError(startFailure(message))).toMatchObject({ rejected: false });
});

// 只有节点约定的 Docker 错误结构可用于判定拒绝，未知错误中的相似文本不是证据。
test("does not infer a Docker rejection from an unrelated native error code", async () => {
  expect(
    await nativeCreateError(Response.json({ code: "UNKNOWN", message: cpuRejection }, { status: 500 })),
  ).toMatchObject({ rejected: false });
});

// 管理创建被 Docker 明确拒绝时清理绑定，原生代理调用仍保留由调用方释放的绑定。
test("count management rolls back CPU rejection and permits a corrected retry", async () => {
  let rejected = true;
  const f = fixture(async () => (rejected ? startFailure() : Response.json({ id: "native" }, { status: 201 })));
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
    fetch: Object.assign(async () => (rejected ? startFailure() : Response.json({ id: "native" }, { status: 201 })), {
      preconnect: fetch.preconnect,
    }),
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
  expect(await response.json()).toEqual({ code: "DOCKER::SANDBOX_START_FAILED", message: cpuRejection });
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
