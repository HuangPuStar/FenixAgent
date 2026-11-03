import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConflictError } from "@fenix/platform-sdk";
import { initializeTestApplicationInfrastructure, readJson, resetAllStubs } from "@fenix/platform-sdk/testing";
import {
  createStubSkillFacade,
  createStubSkillServerModule,
  installSkillServerModule,
  resetSkillServerModuleForTesting,
} from "@fenix/resource-skill/server/testing";
import { createApiAgentsRoutes } from "../server/routes/api/agents";
import { authorizedAgent, installAgentModuleStub, resetAgentModuleStub } from "./fixtures";
import { createStubSessionAuthGuardPlugin, resetTestAuth, setTestAuth } from "./guard-stubs";

const route = createApiAgentsRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin() });
const request = (path: string, init?: RequestInit) => route.handle(new Request(`http://localhost/api/v1${path}`, init));
const json = (path: string, method: string, body: unknown) =>
  request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const database = {
  execute: async () => [],
  select: () => ({ from: () => ({ where: () => ({ for: async () => [] }) }) }),
  transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(database),
};

beforeEach(() => {
  resetAllStubs();
  resetAgentModuleStub();
  resetSkillServerModuleForTesting();
  initializeTestApplicationInfrastructure({ database });
  setTestAuth({ organizationId: "org-1", userId: "user-1" });
  installAgentModuleStub({
    facade: { list: async () => ({ items: [], total: 0 }), getById: async () => authorizedAgent() },
  });
});
afterEach(() => {
  resetAgentModuleStub();
  resetSkillServerModuleForTesting();
  resetTestAuth();
  resetAllStubs();
});

describe("Agent v1 routes", () => {
  // 列表只投影批准的版本字段，并保留授权集合计数和分页。
  test("list returns safe paginated scope and access", async () => {
    installAgentModuleStub({
      facade: { list: async () => ({ items: [authorizedAgent({ id: "a", model: "internal-reference" })], total: 3 }) },
    });
    const res = await request("/agents?page=2&pageSize=1");
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body).toMatchObject({ success: true, data: { total: 3, page: 2, pageSize: 1 } });
    expect(body.data.items[0].scope.organizationId).toBe("org-1");
    expect(body.data.items[0]).not.toHaveProperty("resourceAccess");
    expect(body.data.items[0]).not.toHaveProperty("model");
  });
  // 详情的记忆状态来自持久配置，不能用固定默认值伪装。
  test("details read actual memory and bindings", async () => {
    installAgentModuleStub({
      facade: { getById: async () => authorizedAgent({ id: "a" }) },
      associations: {
        isMemoryEnabled: async () => true,
        listSkillIds: async () => ["s1"],
        getKnowledge: async () => ({ knowledgeBaseIds: ["k1"] }),
      },
    });
    const res = await request("/agents/a");
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({
      success: true,
      data: { id: "a", enableMemory: true, skillIds: ["s1"], knowledge: { knowledgeBaseIds: ["k1"] } },
    });
  });
  // 创建走严格插入，重复创建不得静默修改原配置。
  test("create is 201 and conflict is 409", async () => {
    let saved = false;
    installAgentModuleStub({
      facade: {
        create: async () => {
          if (saved) throw new ConflictError("Agent already exists");
          saved = true;
          return authorizedAgent({ id: "new" });
        },
      },
      associations: { setMemoryEnabled: async () => {} },
    });
    const first = await json("/agents", "POST", { name: "demo" });
    expect(first.status).toBe(201);
    expect((await readJson(first)).data.id).toBe("new");
    const second = await json("/agents", "POST", { name: "demo" });
    expect(second.status).toBe(409);
    expect((await readJson(second)).success).toBe(false);
  });
  // 格式正确的 UUID 也必须经过资源 owner 授权；失败前不能保存 Agent。
  test("invisible skill UUID rejects before configuration write", async () => {
    const saved: string[] = [];
    installSkillServerModule(
      createStubSkillServerModule({ facade: createStubSkillFacade({ getById: async () => undefined }) }),
    );
    installAgentModuleStub({
      facade: {
        create: async () => {
          saved.push("bad");
          return authorizedAgent();
        },
      },
    });
    const res = await json("/agents", "POST", { name: "demo", skillIds: ["11111111-1111-4111-8111-111111111111"] });
    expect(res.status).toBe(400);
    expect(saved).toEqual([]);
  });
  // 缺省关联保持不变；删除复用领域生命周期而不返回旧资源快照。
  test("prompt PATCH preserves associations and DELETE returns null", async () => {
    const skills = ["existing"];
    installAgentModuleStub({
      facade: {
        getById: async () => authorizedAgent({ id: "a" }),
        updateById: async () => authorizedAgent({ id: "a", prompt: "updated" }),
        removeById: async () => {},
      },
      associations: { listSkillIds: async () => skills },
    });
    const updated = await json("/agents/a", "PATCH", { prompt: "updated" });
    expect(updated.status).toBe(200);
    expect((await readJson(updated)).data).toMatchObject({ prompt: "updated", skillIds: ["existing"] });
    const deleted = await request("/agents/a", { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await readJson(deleted)).toEqual({ success: true, data: null });
  });
});
