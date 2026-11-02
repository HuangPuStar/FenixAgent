import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AuthorizedResourceQuery } from "@fenix/platform-sdk";
import { getDbStub, resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { agentConfig } from "../../db/schema";
import { agentConfigResource } from "../server/access/agent-config-resource";
import { AgentConfigFacade } from "../server/facades/agent-config-facade";
import {
  type AgentConfigQueryStorage,
  createAgentConfigRepository,
} from "../server/repositories/agent-config-resource";
import { createApiAgentsRoutes } from "../server/routes/api/agents";
import { createWebConfigAgentsRoutes } from "../server/routes/web/config/agents";
import { createAgentConfigService } from "../server/services/agent-config-service";
import {
  createStubAgentConfigServerModule,
  initializeAgentConfigModuleConfig,
  installAgentConfigModule,
} from "../server/testing";
import {
  createFakeAccessControl,
  createRecordingScopeStore,
  createTestAgentPreferencesPort,
  denied,
  resetAgentModuleStub,
  scopedAgent,
} from "./fixtures";
import { createStubSessionAuthGuardPlugin, resetTestAuth, setTestAuth } from "./guard-stubs";

const web = createWebConfigAgentsRoutes({
  authGuardPlugin: createStubSessionAuthGuardPlugin(),
  userAgentPreferences: createTestAgentPreferencesPort(),
});
const api = createApiAgentsRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin() });
const ID = "11111111-1111-4111-8111-111111111111";
const builtIns = ["build", "plan", "general", "explore", "title", "summary", "compaction", "meta"];

/** 运行真实路由、Facade、Service 与 Repository，仅替换数据库及授权端口。 */
function installAgent(options: { name?: string; writable?: boolean; visible?: boolean; failure?: Error } = {}) {
  let row = scopedAgent({ id: ID, name: options.name ?? "原助手", prompt: "保留提示词", machineId: "mach-1" });
  let writes = 0;
  const query: AuthorizedResourceQuery<AgentConfigQueryStorage> = {
    findById: async ({ resourceId }) => (options.visible === false || resourceId !== ID ? undefined : row),
    list: async () => ({ items: [], total: 0 }),
    count: async () => 0,
  };
  stubDb({
    execute: async () => {},
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(getDbStub()),
    update: (table: unknown) => {
      expect(table).toBe(agentConfig);
      return {
        set: (values: Partial<typeof row>) => ({
          where: () => ({
            returning: async () => {
              if (options.failure) throw options.failure;
              row = { ...row, ...values };
              writes++;
              return [{ id: row.id }];
            },
          }),
        }),
      };
    },
  });
  const facade = new AgentConfigFacade(createAgentConfigService(createAgentConfigRepository(query)), {
    resource: agentConfigResource.definition,
    scopeStore: createRecordingScopeStore().store,
    accessControl: createFakeAccessControl({
      authorize: async () => {
        if (options.writable === false) denied();
      },
    }),
  });
  installAgentConfigModule(createStubAgentConfigServerModule({ facade }));
  return { row: () => row, writes: () => writes };
}

/** 同一改名输入分别经控制台 PATCH 和外部 API PUT 进入共享应用规则。 */
function rename(protocol: "web" | "api", data: Record<string, unknown>) {
  return (protocol === "web" ? web : api).handle(
    new Request(`http://localhost${protocol === "web" ? "/config/agents" : "/api/agents"}/${ID}`, {
      method: protocol === "web" ? "PATCH" : "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(protocol === "web" ? { data } : data),
    }),
  );
}

beforeEach(() => {
  initializeAgentConfigModuleConfig();
  setTestAuth({ organizationId: "org-1", userId: "user-1" });
});
afterEach(() => {
  resetAgentModuleStub();
  resetTestAuth();
  resetAllStubs();
});

for (const protocol of ["web", "api"] as const) {
  describe(`${protocol} AgentConfig 改名`, () => {
    // 名称更新必须真实写入，且不可重建资源或覆盖未提交的绑定、提示词及节点。
    test("改名返回新名称并保留稳定 ID 与其他配置", async () => {
      const state = installAgent();
      const before = state.row();
      const response = await rename(protocol, { name: "新助手" });
      expect(response.status, await response.clone().text()).toBe(200);
      const body = await response.json();
      expect(protocol === "web" ? body.data : body).toMatchObject({ id: ID, name: "新助手" });
      expect(state.row()).toEqual({ ...before, name: "新助手", updatedAt: expect.any(Date) });
    });

    // 内置身份依赖保留名称，必须同时禁止改出与改入每个内置名称。
    test.each(builtIns)("禁止改出或改入内置名称 %s", async (name) => {
      const builtIn = installAgent({ name });
      expect((await rename(protocol, { name: "普通助手" })).status).toBe(403);
      expect(builtIn.writes()).toBe(0);
      const ordinary = installAgent();
      expect((await rename(protocol, { name })).status).toBe(403);
      expect(ordinary.writes()).toBe(0);
    });

    // 前端提交未变化的名称时，内置 Agent 的其他配置仍可正常保存。
    test("内置 Agent 同名保存允许修改描述", async () => {
      const state = installAgent({ name: "meta" });
      expect((await rename(protocol, { name: "meta", description: "新描述" })).status).toBe(200);
      expect(state.row()).toMatchObject({ id: ID, name: "meta", description: "新描述" });
    });

    // 非法名称不能绕过创建时的字符与长度规则进入持久化层。
    test.each(["bad_name", "bad--name", "x".repeat(65)])("拒绝非法名称 %s", async (name) => {
      const state = installAgent();
      expect((await rename(protocol, { name })).status).toBe(protocol === "api" && name.length > 64 ? 422 : 400);
      expect(state.writes()).toBe(0);
    });

    // 未提交名称保持原名，保留原有部分更新的调用契约。
    test("省略名称只更新其他字段", async () => {
      const state = installAgent();
      expect((await rename(protocol, { description: "说明" })).status).toBe(200);
      expect(state.row()).toMatchObject({ name: "原助手", description: "说明" });
    });

    // 数据库唯一索引裁决并发改名，命中重名约束要映射为 409 而非泄露 SQL 的 500。
    test("同组织名称冲突返回 409", async () => {
      const failure = new Error("query failed", { cause: { code: "23505", constraint: "idx_agent_config_org_name" } });
      const state = installAgent({ failure });
      const response = await rename(protocol, { name: "已有助手" });
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.error.code).toBe("ALREADY_EXISTS");
      expect(state.row().name).toBe("原助手");
    });

    // 可读但不可更新的共享资源不能改名，即使新名称本身合法。
    test("没有 update 权限时拒绝改名", async () => {
      const state = installAgent({ writable: false });
      expect((await rename(protocol, { name: "新助手" })).status).toBe(403);
      expect(state.writes()).toBe(0);
    });

    // 不可见资源与不存在资源遵循相同的 404，不能借改名越过租户读取边界。
    test("不可见资源返回 404 且不写入", async () => {
      const state = installAgent({ visible: false });
      expect((await rename(protocol, { name: "新助手" })).status).toBe(404);
      expect(state.writes()).toBe(0);
    });
  });
}

// 非重名存储故障必须原样抛出，不能把所有 SQL 失败都伪装成名称冲突。
test("非名称约束的数据库错误保留原始异常", async () => {
  const failure = new Error("storage failed", { cause: { code: "23505", constraint: "other_constraint" } });
  installAgent({ failure });
  const { getAgentConfigModule } = await import("../server/runtime");
  await expect(
    getAgentConfigModule().facade.updateById(
      {
        kind: "user",
        userId: "user-1",
        activeOrganizationId: "org-1",
        memberships: [{ organizationId: "org-1", role: "owner" }],
      },
      ID,
      {},
      { name: "新助手" },
    ),
  ).rejects.toBe(failure);
});
