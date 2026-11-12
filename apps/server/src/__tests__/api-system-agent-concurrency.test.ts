import { afterEach, beforeEach, expect, test } from "bun:test";
import { createAgentConcurrencyPolicyRoutes } from "@fenix/agent-runtime/server";
import { AgentConcurrencyPolicyFacade, AgentConcurrencyPolicyService } from "@fenix/agent-runtime/server/testing";
import { systemApiAuthPlugin } from "../plugins/system-api-auth";

const originalKeys = process.env.RCS_SYSTEM_API_KEYS;
const systemKey = crypto.randomUUID();
const user = { id: "u1", name: "User One", email: "user@example.com" };
let failWrite = false;
let deploymentLimit = 10;
const service = new AgentConcurrencyPolicyService(
  {
    list: async () => [],
    save: async () => {
      if (failWrite) throw new Error("storage failed");
    },
    delete: async () => {},
  },
  () => ({ userAgentMaxConcurrency: deploymentLimit }),
);
const facade = new AgentConcurrencyPolicyFacade(service, () => ({
  searchUsers: async ({ keyword, limit }) => {
    expect(limit).toBe(50);
    return keyword && !user.name.includes(keyword)
      ? []
      : [
          {
            ...user,
            emailVerified: true,
            phoneNumber: null,
            phoneNumberVerified: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ];
  },
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
  deploymentLimit = 10;
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
    ["/user-candidates", "GET"],
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
  for (const value of [0, -1, 1.5, 2147483648])
    expect((await send("", "PATCH", { agentMaxConcurrency: value })).status).toBe(422);
  expect((await send("/users/u1", "PUT", { userAgentMaxConcurrency: 2, agentMaxConcurrency: 8 })).status).toBe(422);
  expect((await send("/users/missing", "PUT", { userAgentMaxConcurrency: 2 })).status).toBe(404);
});

// 部署限额不受数据库 integer 范围约束，读取及覆盖后的默认值均须保持可响应。
test("returns deployment limits above the database integer bound", async () => {
  deploymentLimit = 2147483648;
  const inherited = await send();
  expect(inherited.status).toBe(200);
  expect(await inherited.json()).toMatchObject({
    data: { userAgentMaxConcurrency: { override: null, value: deploymentLimit, defaultValue: deploymentLimit } },
  });
  const overridden = await send("", "PATCH", { userAgentMaxConcurrency: 6 });
  expect(overridden.status).toBe(200);
  expect(await overridden.json()).toMatchObject({
    data: { userAgentMaxConcurrency: { override: 6, value: 6, defaultValue: deploymentLimit } },
  });
});

// 持久层拒绝写入时 API 不得响应成功或提前改变准入快照。
test("keeps the last committed snapshot after a failed API write", async () => {
  await send("", "PATCH", { agentMaxConcurrency: 4 });
  failWrite = true;
  expect((await send("", "PATCH", { agentMaxConcurrency: 8 })).status).toBe(500);
  expect(service.limits().agentMaxConcurrency).toBe(4);
});

// 搜索只暴露配置所需字段，且关键字传递到身份目录。
test("searches minimal user candidates", async () => {
  const candidates: unknown = await (await send("/user-candidates?keyword=User")).json();
  expect(candidates).toEqual({
    success: true,
    data: [{ id: "u1", name: "User One", email: "user@example.com" }],
  });
  const missing: unknown = await (await send("/user-candidates?keyword=missing")).json();
  expect(missing).toEqual({ success: true, data: [] });
});
