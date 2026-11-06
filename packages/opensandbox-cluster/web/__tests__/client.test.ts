import { expect, test } from "bun:test";
import { ClusterClient } from "../api/client";

// 浏览器断连不代表服务端创建失败，客户端不能自行释放仍可能在创建的绑定。
test("browser connection loss does not independently release a count allocation", async () => {
  const calls: string[] = [];
  const client = new ClusterClient(
    () => "test",
    () => {},
    async (path, init) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (String(path).endsWith("/allocate")) {
        expect(new Headers(init?.headers).get("if-none-match")).toBe("*");
        return Response.json({ proxy_url: "/api/v1/sandboxes/job/proxy" });
      }
      throw new Error("network unavailable");
    },
  );
  await expect(
    client.createSandbox("p", "count", {
      sandbox_id: "job",
      resources: { cpu: 1, memoryMb: 256, diskGb: 1, gpuCount: 0 },
      sandbox: { image: { uri: "alpine" } },
    }),
  ).rejects.toThrow();
  expect(calls).toHaveLength(2);
  expect(calls.some((path) => path.startsWith("DELETE"))).toBe(false);
});
// 只有确认远端消失后才释放数量额度，异步删除仍保留绑定。
test("count delete requires confirmed absence before releasing the allocation", async () => {
  let absent = false;
  const calls: string[] = [];
  const client = new ClusterClient(
    () => "test",
    () => {},
    async (path, init) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (String(path).endsWith("/allocation"))
        expect(new Headers(init?.headers).get("if-match")).toBe(JSON.stringify("snapshot"));
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return absent ? new Response(null, { status: 404 }) : Response.json({ id: "native" });
    },
  );
  const item = {
    sandbox_id: "job",
    provider_sandbox_id: "native",
    allocation_mode: "count" as const,
    allocation_etag: "snapshot",
    proxy_url: "/api/v1/sandboxes/job/proxy",
  };
  await expect(client.deleteSandbox(item)).rejects.toThrow();
  expect(calls).not.toContain("DELETE /api/v1/sandboxes/job/allocation");
  absent = true;
  await client.deleteSandbox(item);
  expect(calls.at(-1)).toBe("DELETE /api/v1/sandboxes/job/allocation");
});
// 401 清除会话，密钥只出现在认证头；204 正常完成。
test("handles raw responses and clears authentication on 401", async () => {
  let loggedOut = false;
  const client = new ClusterClient(
    () => "secret",
    () => {
      loggedOut = true;
    },
    async (path, init) => {
      expect(String(path)).not.toContain("secret");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
      return String(path) === "/no"
        ? Response.json({ error: { code: "UNAUTHORIZED", message: "invalid" } }, { status: 401 })
        : new Response(null, { status: 204 });
    },
  );
  expect(await client.request("/empty", { method: "DELETE" })).toBeUndefined();
  await expect(client.request("/no")).rejects.toThrow("invalid");
  expect(loggedOut).toBe(true);
});
// OpenSandbox 的暂停和恢复可能以 200 空响应表示成功，不能强行解析 JSON。
test("accepts empty 200 pause and resume responses", async () => {
  const client = new ClusterClient(
    () => "test",
    () => {},
    async () => new Response(null, { status: 200 }),
  );
  expect(await client.request("/pause", { method: "POST" })).toBeUndefined();
  expect(await client.request("/resume", { method: "POST" })).toBeUndefined();
});
// 节点返回的镜像拉取错误应直接显示原因，而不是只显示 HTTP 500。
test("surfaces native structured creation errors", async () => {
  const client = new ClusterClient(
    () => "test",
    () => {},
    async () =>
      Response.json({ code: "DOCKER::SANDBOX_IMAGE_PULL_FAILED", message: "image does not exist" }, { status: 500 }),
  );
  await expect(client.request("/create", { method: "POST" })).rejects.toThrow("image does not exist");
});
// 数量分配明确拒绝时没有发送创建，修正池或 ID 后仍应允许重试。
test("allocation rejection allows the count form to retry", async () => {
  const client = new ClusterClient(
    () => "test",
    () => {},
    async () => Response.json({ error: { message: "no capacity" } }, { status: 409 }),
  );
  await expect(
    client.createSandbox("p", "count", {
      sandbox_id: "job",
      resources: { cpu: 1, memoryMb: 256, diskGb: 1, gpuCount: 0 },
      sandbox: { image: { uri: "alpine" } },
    }),
  ).rejects.toMatchObject({ createRejected: true, message: "no capacity" });
});
