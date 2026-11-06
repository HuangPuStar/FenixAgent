import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createAppWithDatabase } from "../app";
import { sandboxBinding } from "../db/schema";
import { fixture, input } from "./managed-fixture";

function native(id: string, attemptId?: string) {
  return {
    id,
    createdAt: "2026-11-06T00:00:00Z",
    expiresAt: "2026-11-06T01:00:00Z",
    image: { uri: "alpine:3.21", auth: { password: "registry-secret" } },
    status: { state: "Running" },
    entrypoint: ["sleep", "infinity"],
    resourceLimits: { cpu: "250m", memory: "256Mi", disk: "1Gi", gpu: "0" },
    metadata: {
      owner: "qa",
      api_key: "metadata-secret",
      ...(attemptId ? { "opensandbox.cluster.attempt_id": attemptId } : {}),
    },
  };
}
function setup() {
  let items = [native("unbound")];
  let deleted = false;
  let failDelete = false;
  let onRead: (() => void) | undefined;
  const remote = Object.assign(
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const target = new URL(String(url));
      expect(new Headers(init?.headers).get("OPEN-SANDBOX-API-KEY")).toBe("test");
      if (init?.method === "POST") return Response.json({ id: "bound" });
      if (init?.method === "DELETE") {
        if (failDelete) return new Response(null, { status: 500 });
        deleted = true;
        return new Response(null, { status: 204 });
      }
      if (target.pathname === "/v1/sandboxes") {
        const page = Number(target.searchParams.get("page"));
        const size = Number(target.searchParams.get("pageSize"));
        return Response.json({
          items: items.slice((page - 1) * size, page * size),
          pagination: { totalItems: items.length, hasNextPage: page * size < items.length },
        });
      }
      onRead?.();
      const item = items.find((item) => target.pathname === `/v1/sandboxes/${item.id}`);
      return item && !deleted ? Response.json(item) : new Response(null, { status: 404 });
    },
    { preconnect: fetch.preconnect },
  );
  const f = fixture(remote);
  const app = createAppWithDatabase(f.config, f.db, f.sqlite, { fetch: remote, lifecycle: f.lifecycle });
  const req = (path: string, method = "GET", authenticated = true) =>
    app.handle(
      new Request(`http://cluster${path}`, {
        method,
        headers: authenticated ? { Authorization: "Bearer test-key" } : {},
      }),
    );
  return {
    ...f,
    req,
    setItems: (value: ReturnType<typeof native>[]) => {
      items = value;
    },
    onRead: (fn: () => void) => {
      onRead = fn;
    },
    failDelete: () => {
      failDelete = true;
    },
    wasDeleted: () => deleted,
  };
}
const path = "/api/v1/servers/n/unbound-sandboxes";

// 对账必须过滤已绑定 ID 和在途尝试；只暴露识别信息，不泄漏镜像凭据。
test("lists unbound sandboxes with identity information and bounded native pagination", async () => {
  const f = setup();
  await f.lifecycle.create("p", input("job"));
  const row = f.db.select().from(sandboxBinding).get()!;
  f.db
    .insert(sandboxBinding)
    .values({
      ...row,
      sandboxId: "pending-job",
      providerSandboxId: null,
      state: "creating",
      attemptId: "pending-attempt",
    })
    .run();
  f.setItems([native("bound"), native("pending", "pending-attempt"), native("unbound")]);
  expect((await f.req(path, "GET", false)).status).toBe(401);
  const response = await f.req(path + "?page=2&pageSize=2");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({
    page: 2,
    pageSize: 2,
    hasNextPage: false,
    items: [
      {
        provider_sandbox_id: "unbound",
        created_at: "2026-11-06T00:00:00Z",
        image: "alpine:3.21",
        state: "Running",
        resources: { cpu: 0.25, memoryMb: 256, diskGb: 1, gpuCount: 0 },
      },
    ],
  });
  expect(JSON.stringify(body)).not.toContain("registry-secret");
  expect(JSON.stringify(body)).not.toContain("metadata-secret");
  const firstPage = (await (await f.req(path + "?page=1&pageSize=2")).json()) as { items: unknown[] };
  expect(firstPage.items).toEqual([]);
});

// 销毁只能针对没有绑定的原生沙盒，重复删除可成功，节点失败不能被当成成功。
test("destroys an unbound sandbox and confirms native absence", async () => {
  const f = setup();
  expect((await f.req(path + "/unbound", "DELETE", false)).status).toBe(401);
  expect((await f.req(path + "/unbound", "DELETE")).status).toBe(204);
  expect(f.wasDeleted()).toBe(true);
  expect((await f.req(path + "/unbound", "DELETE")).status).toBe(204);
  const failed = setup();
  failed.failDelete();
  expect((await failed.req(path + "/unbound", "DELETE")).status).toBe(502);
});

// 页面查询后产生的新关联，销毁前必须重新检查，不能误删已关联沙盒。
test("rechecks bindings after reading the native sandbox before deleting", async () => {
  const f = setup();
  await f.lifecycle.create("p", input("job"));
  f.onRead(() => {
    f.db.update(sandboxBinding).set({ providerSandboxId: "unbound" }).where(eq(sandboxBinding.sandboxId, "job")).run();
  });
  expect((await f.req(path + "/unbound", "DELETE")).status).toBe(409);
  expect(f.wasDeleted()).toBe(false);
});

// 未写入真实 ID 的在途创建仍有绑定，metadata 关联必须同样阻止销毁。
test("protects native sandboxes associated through an outstanding attempt", async () => {
  const f = setup();
  await f.lifecycle.create("p", input("job"));
  const row = f.db.select().from(sandboxBinding).get()!;
  f.db.update(sandboxBinding).set({ providerSandboxId: null, state: "creating" }).run();
  f.setItems([native("unbound", row.attemptId!)]);
  expect((await f.req(path + "/unbound", "DELETE")).status).toBe(409);
  expect(f.wasDeleted()).toBe(false);
});

// 已明确关联其他真实 ID 后，同一标记的额外沙盒属于残留，不能被永久隐藏。
test("does not hide extra sandboxes once the attempt already has a different native ID", async () => {
  const f = setup();
  await f.lifecycle.create("p", input("job"));
  const row = f.db.select().from(sandboxBinding).get()!;
  f.setItems([native("unbound", row.attemptId!)]);
  const response = await f.req(path);
  const body = (await response.json()) as { items: { provider_sandbox_id: string }[] };
  expect(body.items.map((item) => item.provider_sandbox_id)).toEqual(["unbound"]);
  expect((await f.req(`${path}/unbound`, "DELETE")).status).toBe(204);
  expect(f.lifecycle.find("job")?.provider_sandbox_id).toBe("bound");
});
