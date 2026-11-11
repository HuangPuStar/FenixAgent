import { afterEach, beforeEach, expect, test } from "bun:test";
import { createAgentConcurrencyPolicyRoutes } from "@fenix/agent-runtime/server";
import { AgentConcurrencyPolicyFacade, AgentConcurrencyPolicyService } from "@fenix/agent-runtime/server/testing";
import { systemApiAuthPlugin } from "../plugins/system-api-auth";

const originalKeys = process.env.RCS_SYSTEM_API_KEYS;
const systemKey = crypto.randomUUID();
const user = { id: "u1", name: "User One", email: "user@example.com" };
let failWrite = false;
const service = new AgentConcurrencyPolicyService(
  {
    list: async () => [],
    save: async () => {
      if (failWrite) throw new Error("storage failed");
    },
    delete: async () => {},
  },
  () => ({ userAgentMaxConcurrency: 10 }),
);
const facade = new AgentConcurrencyPolicyFacade(service, () => ({
  getUser: async (id) => (id === "u1" ? user : undefined),
  listUserDisplayInfo: async (ids) => new Map(ids.filter((id) => id === "u1").map((id) => [id, user])),
}));
const app = createAgentConcurrencyPolicyRoutes({ systemApiGuardPlugin: systemApiAuthPlugin }, facade);
async function send(path = "", method = "GET", body?: unknown, authenticated = true) {
  return app.handle(
    new Request(`http://localhost/api/system/agent-concurrency${path}`, {
      method,
      headers: {
        ...(authenticated ? { authorization: `Bearer ${systemKey}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
beforeEach(async () => {
  process.env.RCS_SYSTEM_API_KEYS = systemKey;
  failWrite = false;
  await service.initialize();
});
afterEach(() => {
  process.env.RCS_SYSTEM_API_KEYS = originalKeys;
});

// 原系统密钥守卫必须覆盖全部读取和写入入口，普通请求不能修改策略。
test("requires the existing system key for every operation", async () => {
  for (const [path, method, body] of [
    ["", "GET"],
    ["", "PATCH", {}],
    ["/users", "GET"],
    ["/users/u1", "GET"],
    ["/users/u1", "PUT", { userAgentMaxConcurrency: 2 }],
    ["/users/u1", "DELETE"],
  ] as const) {
    expect((await send(path, method, body, false)).status).toBe(401);
  }
});

// 管理 API 要返回提交后的实际值与来源，清除后恢复原环境继承。
test("supports global and user overrides with inheritance", async () => {
  const response = await send("", "PATCH", { userAgentMaxConcurrency: 6 });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    success: true,
    data: { userAgentMaxConcurrency: { override: 6, value: 6, source: "global" } },
  });
  expect((await send("/users/u1", "PUT", { userAgentMaxConcurrency: 2 })).status).toBe(200);
  const list = await send("/users");
  expect(await list.json()).toMatchObject({
    success: true,
    data: [{ userId: "u1", policy: { userAgentMaxConcurrency: { value: 2, source: "user" } } }],
  });
  expect(await (await send("/users/u1", "DELETE")).json()).toMatchObject({
    data: { policy: { userAgentMaxConcurrency: { override: null, value: 6, source: "global" } } },
  });
  await send("", "PATCH", { userAgentMaxConcurrency: null });
  expect(await (await send("/users/u1")).json()).toMatchObject({
    data: { policy: { userAgentMaxConcurrency: { value: 10, source: "environment" } } },
  });
});

// 非正整数、用户行多余维度和不存在的用户均应被边界拒绝。
test("validates limits and user existence", async () => {
  for (const value of [0, -1, 1.5]) expect((await send("", "PATCH", { agentMaxConcurrency: value })).status).toBe(422);
  expect((await send("/users/u1", "PUT", { userAgentMaxConcurrency: 2, agentMaxConcurrency: 8 })).status).toBe(422);
  expect((await send("/users/missing", "PUT", { userAgentMaxConcurrency: 2 })).status).toBe(404);
});

// 持久层拒绝写入时 API 不得响应成功或提前改变准入快照。
test("keeps the last committed snapshot after a failed API write", async () => {
  await send("", "PATCH", { agentMaxConcurrency: 4 });
  failWrite = true;
  expect((await send("", "PATCH", { agentMaxConcurrency: 8 })).status).toBe(500);
  expect(service.limits().agentMaxConcurrency).toBe(4);
});
