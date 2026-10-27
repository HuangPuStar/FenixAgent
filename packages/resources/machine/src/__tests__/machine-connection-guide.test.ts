import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWebRegistryRoutes, setRegistryRouteDeps } from "../server/routes/web/registry";
import { createStubSessionAuthGuardPlugin, resetTestAuth, setTestAuth } from "./guard-stubs";

let directory: string;
const nativePlatform = `${process.platform}-${process.arch}`;
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
  const build = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../../../../acp-runtime-cli/build-standalone.ts"),
      "--platform",
      nativePlatform,
      "--outdir",
      directory,
    ],
    {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`runtime build failed (${exitCode}): ${stdout}\n${stderr}`);
}, 30000);
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
function routes(path = directory) {
  return createWebRegistryRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin() }, path);
}
const request = (path: string) => new Request(`https://platform.example/registry/${path}`);

// 所有下载与参数查询都要求登录，防止匿名访问控制台资源。
test("下载与连接参数查询均要求认证", async () => {
  resetTestAuth();
  for (const path of ["acp-runtime/linux-x64", "acp-runtime.js", "machines/mach-a/connection-parameters"]) {
    expect((await routes().handle(request(path))).status).toBe(401);
  }
});

// 已有 Bun 的机器仍可下载通用 JS bundle，并在仓库之外启动。
test("保留 JS 下载并通过 Bun 直接运行", async () => {
  const response = await routes().handle(request("acp-runtime.js"));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-disposition")).toContain('filename="acp-runtime.js"');
  expect(response.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
  const downloaded = join(directory, "download.js");
  await Bun.write(downloaded, response);
  const child = Bun.spawn([process.execPath, downloaded], {
    cwd: directory,
    env: { PATH: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(1);
  expect(stdout).toContain("RCS_MACHINE_ID");
  expect(stderr).toBe("");
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

// 下载产物应能在没有 Bun、Node 和仓库依赖的目录中完成机器与文件通道注册。
test("下载独立可执行文件并在无 Bun、Node 的 PATH 下连接平台", async () => {
  const response = await routes().handle(request(`acp-runtime/${nativePlatform}`));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-disposition")).toContain('filename="acp-runtime"');
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  const downloaded = join(directory, "download");
  await Bun.write(downloaded, response);
  await chmod(downloaded, 0o755);
  const emptyPath = join(directory, "empty-path");
  await mkdir(emptyPath);
  const registered = Promise.withResolvers<unknown>();
  let machineRegistration: unknown;
  const server = Bun.serve<{ path: string }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      const path = new URL(req.url).pathname;
      if (path.startsWith("/acp/") && server.upgrade(req, { data: { path } })) return;
      return new Response("ok");
    },
    websocket: {
      message(ws, message) {
        const data = JSON.parse(String(message));
        if (data.type !== "register") return;
        if (ws.data.path === "/acp/ws") {
          machineRegistration = data;
          ws.send(
            JSON.stringify({
              type: "registered",
              protocol_version: 2,
              server_epoch: "test-epoch",
              clean_slate_required: true,
              machine_id: machine.id,
            }),
          );
        } else if (ws.data.path === "/acp/file-ws") {
          registered.resolve(data);
        }
      },
    },
  });
  const child = Bun.spawn([downloaded, "peri", "acp"], {
    cwd: directory,
    env: {
      PATH: emptyPath,
      RCS_URL: `ws://127.0.0.1:${server.port}`,
      RCS_SECRET: crypto.randomUUID(),
      RCS_MACHINE_ID: machine.id,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => registered.reject(new Error("runtime registration timed out")), 10000);
  try {
    expect(await registered.promise).toEqual({ type: "register", machine_id: machine.id });
    expect(machineRegistration).toMatchObject({ type: "register", machine_id: machine.id, protocol_version: 2 });
  } finally {
    clearTimeout(timeout);
    child.kill("SIGKILL");
    await child.exited;
    server.stop(true);
  }
  expect(await new Response(child.stderr).text()).toBe("");
}, 15000);

// 源码开发尚未构建时给出明确失败，避免下载损坏文件。
test("缺少 runtime 产物时下载返回 503", async () => {
  for (const path of ["acp-runtime/linux-x64", "acp-runtime.js"]) {
    const response = await routes(join(directory, "missing")).handle(request(path));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("RUNTIME_NOT_BUILT");
  }
});

// 下载平台必须来自受控枚举，不能通过输入读取任意路径或不受支持的系统。
test("下载仅接受四个已支持的平台，并分别返回对应产物", async () => {
  const variants = join(directory, "variants");
  await mkdir(variants);
  for (const platform of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]) {
    await Bun.write(join(variants, `acp-runtime-${platform}`), `binary-${platform}`);
    const response = await routes(variants).handle(request(`acp-runtime/${platform}`));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`binary-${platform}`);
  }
  expect((await routes().handle(request("acp-runtime/windows-x64"))).status).toBe(422);
  expect((await routes().handle(request("acp-runtime/..%2Facp-runtime.js"))).status).toBe(422);
});
