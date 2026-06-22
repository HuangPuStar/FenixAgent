// setup-mocks.ts — 项目中唯一调用 mock.module() 的文件
// 通过 bunfig.toml preload 在所有测试前加载
//
// Bun 的 ESM namespace 会在 import 时提前求值 getter，
// 所以 getter 必须返回一个惰性包装函数，将 stub 查找延迟到调用时。

import { mock } from "bun:test";
import * as actualKnowledgeBaseService from "../services/knowledge-base";
import { getApiKeyServiceStub, getAuthApiStub } from "./stubs/auth-stub";
import { getConfigPgStub } from "./stubs/config-pg-stub";
import { getDbStub } from "./stubs/db-stub";
import { getEnvironmentRepoStub, knowledgeBaseServiceRegistry, pgStorageAdapterRegistry } from "./stubs/module-stubs";
import { resourcePermissionRepoStub } from "./stubs/resource-permission-repo-stub";
import { getSystemApiStub } from "./stubs/system-api-stub";

// biome-ignore lint/suspicious/noExplicitAny: stub 注册表需要宽松类型
type AnyFn = (...args: any[]) => any;

/**
 * 创建带惰性包装函数的 mock 对象。
 * 每个属性通过 Object.defineProperty 注册，getter 返回一个函数，
 * 调用时才查找 stub 注册表。
 */
// biome-ignore lint/suspicious/noExplicitAny: stub 注册表需要宽松类型
function createLazyMock(keys: readonly string[], getStub: (name: string) => any) {
  const obj: Record<string, unknown> = {};
  for (const key of keys) {
    Object.defineProperty(obj, key, {
      enumerable: true,
      configurable: true,
      get:
        () =>
        (...args: unknown[]) =>
          (getStub(key) as AnyFn)(...args),
    });
  }
  return obj;
}

// ── config service barrel 导出名称 ──

const CONFIG_PG_KEYS = [
  "AGENT_SETTABLE_FIELDS",
  "addModel",
  "createAgentConfig",
  "createMcpServer",
  "deleteAgentConfig",
  "deleteMcpServerById",
  "deleteMcpServer",
  "deleteProviderById",
  "deleteProvider",
  "deleteSkill",
  "deleteSkillById",
  "assertMcpServerInternalWritableById",
  "assertMcpServerInternalWritable",
  "assertAgentConfigInternalWritable",
  "assertProviderInternalWritableById",
  "assertProviderInternalWritable",
  "getAgentConfig",
  "getAgentConfigById",
  "getAgentConfigByResourceKey",
  "getReadableAgentConfigById",
  "getMcpServerById",
  "getMcpServer",
  "getMcpServerByResourceKey",
  "getProviderById",
  "getProvider",
  "getProviderByResourceKey",
  "getSkill",
  "getSkillById",
  "getSkillByResourceKey",
  "getUserConfig",
  "listAgentConfigs",
  "listAgentMcpIds",
  "listAgentSkillIds",
  "listMcpServers",
  "listProviders",
  "listReadableProviders",
  "listSkills",
  "removeModel",
  "removeModelById",
  "setMcpServerEnabled",
  "setUserConfig",
  "syncAgentMcps",
  "syncAgentSkills",
  "updateAgentConfig",
  "updateProviderById",
  "updateMcpServerById",
  "updateMcpServer",
  "updateModel",
  "updateModelById",
  "upsertProvider",
  "upsertSkill",
] as const;

mock.module("../services/config/index", () =>
  // biome-ignore lint/suspicious/noExplicitAny: stub 注册表需要宽松类型
  createLazyMock(CONFIG_PG_KEYS, getConfigPgStub as (name: string) => any),
);

// ── auth.api 方法名称 ──

const AUTH_API_KEYS = [
  "listApiKeys",
  "deleteApiKey",
  "createApiKey",
  "listMembers",
  "listOrganizations",
  "createOrganization",
  "verifyApiKey",
  "getSession",
] as const;

mock.module("../auth/better-auth", () => {
  // biome-ignore lint/suspicious/noExplicitAny: stub 注册表需要宽松类型
  const apiObj = createLazyMock(AUTH_API_KEYS, getAuthApiStub as (name: string) => any);
  return {
    auth: {
      api: apiObj,
      handler: (_req: Request) => new Response("mocked", { status: 200 }),
    },
  };
});

// ── api-key-service 导出名称 ──

const API_KEY_SERVICE_KEYS = ["createApiKey", "hashApiKey"] as const;

mock.module("../auth/api-key-service", () =>
  // biome-ignore lint/suspicious/noExplicitAny: stub 注册表需要宽松类型
  createLazyMock(API_KEY_SERVICE_KEYS, getApiKeyServiceStub as (name: string) => any),
);

// ── system api service 导出名称 ──

const SYSTEM_API_KEYS = [
  "listUsers",
  "getUserById",
  "listUserApiKeys",
  "listUserOrganizations",
  "createUser",
  "deleteUser",
  "listOrganizations",
  "getOrganizationById",
  "createOrganization",
  "deleteOrganization",
  "addOrganizationMember",
  "createUserApiKey",
  "deleteUserApiKey",
] as const;

mock.module("../services/system-api", () =>
  // biome-ignore lint/suspicious/noExplicitAny: stub 注册表需要宽松类型
  createLazyMock(SYSTEM_API_KEYS, getSystemApiStub as (name: string) => any),
);

// ── raw db ──

function createDbMock() {
  const obj: Record<string, unknown> = {};
  const dbProxy = new Proxy(
    {},
    {
      get: (_target, prop) => getDbStub()[prop as string],
    },
  );
  Object.defineProperty(obj, "db", {
    enumerable: true,
    configurable: true,
    get: () => dbProxy,
  });
  Object.defineProperty(obj, "client", {
    enumerable: true,
    configurable: true,
    get: () => ({}),
  });
  Object.defineProperty(obj, "initDb", {
    enumerable: true,
    configurable: true,
    get: () => async () => {},
  });
  return obj;
}

mock.module("../db", createDbMock);
mock.module("../../db", createDbMock);

// ── resource-permission repository ──

mock.module("../repositories/resource-permission", () => ({
  resourcePermissionRepo: resourcePermissionRepoStub,
}));

// ── 以下模块按批次添加：只有当所有使用该模块的测试文件都已迁移到 stub 注册表后才能注册 ──
// 添加前须确认：没有任何未迁移的测试会通过被测代码间接导入这些模块
//
// 注意：../repositories 等模块导出了对象实例（repo），不能使用 createLazyMock（仅适用于函数导出）。
// 这些模块需要被测代码使用 DI 注入模式后才能安全加入 preload。当前保留 mock.module() 在测试文件中。

// ── repositories/environment — 环境仓储（对象导出）──
// 仅有 acp-machine-connection-lookup.test.ts 和 relay-handler-machine.test.ts 使用 mock

mock.module("../repositories/environment", () => {
  const obj: Record<string, unknown> = {};
  Object.defineProperty(obj, "environmentRepo", {
    enumerable: true,
    configurable: true,
    get: () => getEnvironmentRepoStub() ?? { getById: async () => null },
  });
  return obj;
});

mock.module("../services/knowledge-base", () => ({
  ...actualKnowledgeBaseService,
  listKnowledgeBasesByTeamId: (...args: unknown[]) =>
    knowledgeBaseServiceRegistry.get("listKnowledgeBasesByTeamId")(...args),
}));

// ── pg-storage-adapter: 从 workflow-runs.test.ts 的 mock.module() 迁移到 preload ──
// 只有 1 个测试文件使用，安全 preload mock。
// 注意：registry/environment/core-bootstrap 等模块无法安全 preload mock，
// 因为 mock.module 注册后无法通过 dynamic import 获取真实模块（Bun 限制），
// 而 fallback 到真实模块需要在 preload 阶段 import（触发依赖链副作用）。
// 这些模块的 mock.module() 暂保留在各自测试文件中。

mock.module("../services/workflow/pg-storage-adapter", () => ({
  createPgStorageAdapter: () => {
    const storageObj: Record<string, unknown> = {};
    return new Proxy(storageObj, {
      get: (_target, prop) => {
        if (typeof prop !== "string") return undefined;
        return (...args: unknown[]) => pgStorageAdapterRegistry.get(prop)(...args);
      },
    });
  },
}));

// ── pg-storage-adapter: 从 workflow-runs.test.ts 的 mock.module() 迁移到 preload ──
// 只有 1 个测试文件使用，安全 preload mock。
// 注意：registry/environment/core-bootstrap 等模块无法安全 preload mock，
// 因为 mock.module 注册后无法通过 dynamic import 获取真实模块（Bun 限制），
// 而 fallback 到真实模块需要在 preload 阶段 import（触发依赖链副作用）。
// 这些模块的 mock.module() 暂保留在各自测试文件中。

mock.module("../services/workflow/pg-storage-adapter", () => ({
  createPgStorageAdapter: () => {
    const storageObj: Record<string, unknown> = {};
    return new Proxy(storageObj, {
      get: (_target, prop) => {
        if (typeof prop !== "string") return undefined;
        return (...args: unknown[]) => pgStorageAdapterRegistry.get(prop)(...args);
      },
    });
  },
}));
