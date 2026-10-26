import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWebRegistryRoutes, setRegistryRouteDeps } from "../server/routes/web/registry";
import { createStubSessionAuthGuardPlugin, resetTestAuth, setTestAuth } from "./guard-stubs";

let directory: string;
let runtimePath: string;
const now = new Date();
const machine = {
  id: "mach-a",
  name: "Office",
  organizationId: "org-a",
  userId: null,
  agentName: "peri",
  type: "machine",
  status: "pending",
  machineInfo: null,
  labels: [],
  maxSessions: 5,
  heartbeatIntervalMs: 30000,
  lastHeartbeatAt: null,
  registeredAt: now,
  createdAt: now,
  updatedAt: now,
  recentEvents: [],
};
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "machine-guide-"));
  runtimePath = join(directory, "acp-runtime.js");
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../../../acp-runtime-cli/src/bin.ts")],
    target: "bun",
    minify: true,
    outdir: directory,
    naming: "acp-runtime.js",
  });
  if (!result.success) throw new AggregateError(result.logs, "runtime build failed");
});
beforeEach(() => {
  setTestAuth({
    user: { id: "user-a", name: "User", email: "user@example.test" },
    authContext: { organizationId: "org-a", userId: "user-a" },
  });
  setRegistryRouteDeps({
    getMachine: async (actor, id) => (actor.organizationId === "org-a" && id === machine.id ? machine : null),
  });
});
afterEach(() => {
  resetTestAuth();
  setRegistryRouteDeps(null);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
function routes(path = runtimePath) {
  return createWebRegistryRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin() }, path);
}
const request = (path: string) => new Request(`https://platform.example/registry/${path}`);

// 两个接口都要求登录，防止匿名访问控制台资源。
test("下载与连接参数查询均要求认证", async () => {
  resetTestAuth();
  for (const path of ["acp-runtime.js", "machines/mach-a/connection-parameters"]) {
    expect((await routes().handle(request(path))).status).toBe(401);
  }
});

// 查询复用 Machine 的可见性校验，只返回启动必需的公开参数。
test("连接参数不含密钥且不可读取其他组织的机器", async () => {
  const response = await routes().handle(request("machines/mach-a/connection-parameters"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    success: true,
    data: {
      machineId: "mach-a",
      agentType: "peri",
      rcsUrl: "wss://platform.example",
    },
  });
  expect((await routes().handle(request("machines/foreign/connection-parameters"))).status).toBe(404);
  setTestAuth({
    user: { id: "user-b", name: "User", email: "b@example.test" },
    authContext: { organizationId: "org-b", userId: "user-b" },
  });
  expect((await routes().handle(request("machines/mach-a/connection-parameters"))).status).toBe(404);
});

// TLS 在代理终止时，指引仍应生成安全 WebSocket 地址。
test("反向代理 HTTPS 请求返回 wss 地址", async () => {
  const response = await routes().handle(
    new Request("http://platform.example/registry/machines/mach-a/connection-parameters", {
      headers: { "x-forwarded-proto": "https" },
    }),
  );
  expect((await response.json()).data.rcsUrl).toBe("wss://platform.example");
});

// 下载必须返回独立可运行的 JS，而不是 HTML 页面或依赖 workspace 的源码。
test("下载返回实际 bundle 附件并能脱离仓库启动", async () => {
  const response = await routes().handle(request("acp-runtime.js"));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-disposition")).toContain('filename="acp-runtime.js"');
  expect(response.headers.get("content-type")).toContain("javascript");
  const downloaded = join(directory, "download.js");
  await Bun.write(downloaded, response);
  expect(await Bun.file(downloaded).text()).toBe(await Bun.file(runtimePath).text());
  const child = Bun.spawn([Bun.which("bun")!, downloaded], {
    cwd: directory,
    env: { PATH: "/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stdout).text()).toContain("RCS_MACHINE_ID");
  expect(await new Response(child.stderr).text()).toBe("");
});

// 源码开发尚未构建时给出明确失败，避免下载损坏文件。
test("缺少 runtime 产物时下载返回 503", async () => {
  const response = await routes(join(directory, "missing.js")).handle(request("acp-runtime.js"));
  expect(response.status).toBe(503);
  expect((await response.json()).error.code).toBe("RUNTIME_NOT_BUILT");
});
