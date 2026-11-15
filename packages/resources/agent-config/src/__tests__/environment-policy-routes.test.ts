import { afterEach, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { createAgentConfigApiRoutes } from "../server/assembly";
import { bindEnvironmentPolicyMaximum } from "../server/services/environment-policy";
import { authorizedAgent, installAgentModuleStub, resetAgentModuleStub } from "./fixtures";
import { createStubSessionAuthGuardPlugin, resetTestAuth, setTestAuth } from "./guard-stubs";

const id = "123e4567-e89b-12d3-a456-426614174000";
afterEach(() => {
  resetAgentModuleStub();
  resetAllStubs();
  resetTestAuth();
});
function fixture(ttlSeconds: number | null, canUpdate = true) {
  bindEnvironmentPolicyMaximum(() => 86400);
  setTestAuth({ organizationId: "org-1", userId: "user-1" });
  const resource = authorizedAgent({ id });
  installAgentModuleStub({
    facade: {
      getById: async () => ({
        ...resource,
        access: { ...resource.access, actions: canUpdate ? ["read", "use", "update"] : ["read", "use"] },
      }),
    },
  });
  stubDb({
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => (ttlSeconds === null ? [] : [{ ttlSeconds }]) }) }),
    }),
  });
  return createAgentConfigApiRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin() } as never);
}
// 完整 owner 装配后的对外路径应直接可用，不能出现重复 /api/v1/agents 前缀。
test("policy is reachable through the complete AgentConfig assembly", async () => {
  const app = fixture(null);
  const response = await app.handle(new Request(`http://localhost/api/v1/agents/${id}/environment-policy`));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    success: true,
    data: { ttlSeconds: null, effectiveTtlSeconds: 3600, maxTtlSeconds: 86400, source: "default" },
  });
});
// 读取可见性不授予配置写权限，成员读策略仍不能 PUT/DELETE。
test("policy writes require Agent update permission", async () => {
  const app = fixture(60, false);
  for (const method of ["PUT", "DELETE"]) {
    const response = await app.handle(
      new Request(`http://localhost/api/v1/agents/${id}/environment-policy`, {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "PUT" ? { body: JSON.stringify({ ttlSeconds: 90 }) } : {}),
      }),
    );
    expect(response.status).toBe(403);
  }
  const response = await app.handle(new Request(`http://localhost/api/v1/agents/${id}/environment-policy`));
  expect((await response.json()).data.source).toBe("agent");
});
