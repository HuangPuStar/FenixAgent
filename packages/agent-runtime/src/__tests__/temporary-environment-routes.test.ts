import { afterEach, expect, test } from "bun:test";
import { AppError } from "@fenix/platform-sdk";
import { createTemporaryEnvironmentRoutes } from "../routes/api/temporary-environments";
import { createStubAgentRuntimeAuthGuardPlugin, resetTestAuth, setTestAuth } from "./guard-stubs";

const data = { environmentId: "temp-route", instanceId: "inst-route", expiresAt: "2026-11-11T01:00:00.000Z" };
afterEach(resetTestAuth);
// 真实 Elysia 序列化必须保留续期成功的 running 状态和原实例身份。
test("create is 201 and renew serializes status running", async () => {
  setTestAuth({ organizationId: "org", userId: "user" });
  const app = createTemporaryEnvironmentRoutes(
    { authGuardPlugin: createStubAgentRuntimeAuthGuardPlugin() },
    { create: async () => data, renew: async () => ({ ...data, status: "running" }) },
  );
  const request = (path: string, body: unknown) =>
    app.handle(
      new Request(`http://localhost/api/v1${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const created = await request("/agents/123e4567-e89b-12d3-a456-426614174000/environments", { temporary: true });
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({ success: true, data });
  const renewed = await request("/environments/temp-route/renew", {});
  expect(renewed.status).toBe(200);
  expect(await renewed.json()).toEqual({ success: true, data: { ...data, status: "running" } });
});
// 保守恢复失败保持503及稳定机器码，内部进程信息不返回外部调用方。
test("renew failure preserves status and redacts internal diagnostics", async () => {
  setTestAuth({ organizationId: "org", userId: "user" });
  const app = createTemporaryEnvironmentRoutes(
    { authGuardPlugin: createStubAgentRuntimeAuthGuardPlugin() },
    {
      create: async () => data,
      renew: async () => {
        throw new AppError("private process detail", "ENVIRONMENT_RUNTIME_UNCONFIRMED", 503);
      },
    },
  );
  const response = await app.handle(
    new Request("http://localhost/api/v1/environments/temp-route/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    success: false,
    error: { code: "ENVIRONMENT_RUNTIME_UNCONFIRMED", message: "Environment service unavailable" },
  });
});

// owner 完整装配不能叠加子路由前缀，未认证请求应到达守卫而不是404。
test("runtime assembly mounts temporary endpoints at the public API paths", async () => {
  const { createAgentRuntimeApiInstanceRoutes } = await import("../server/assembly");
  const app = createAgentRuntimeApiInstanceRoutes({
    authGuardPlugin: createStubAgentRuntimeAuthGuardPlugin(),
    logError: () => {},
  } as never);
  for (const [path, body] of [
    ["/agents/123e4567-e89b-12d3-a456-426614174000/environments", { temporary: true }],
    ["/environments/temp-route/renew", {}],
  ] as const) {
    const response = await app.handle(
      new Request(`http://localhost/api/v1${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(401);
  }
  expect(app.routes.filter((route) => route.path.includes("environments")).map((route) => route.path)).toEqual([
    "/api/v1/agents/:id/environments",
    "/api/v1/environments/:environmentId/renew",
  ]);
});
