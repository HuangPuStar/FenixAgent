// setup-mocks.ts — 项目中唯一调用 mock.module() 的文件
// 通过 bunfig.toml preload 在所有测试前加载
//
// Bun 的 ESM namespace 会在 import 时提前求值 getter，
// 所以 getter 必须返回一个惰性包装函数，将 stub 查找延迟到调用时。

import { mock } from "bun:test";
import { getApiKeyServiceStub, getAuthApiStub } from "./stubs/auth-stub";
import { getConfigPgStub } from "./stubs/config-pg-stub";
import { getDbStub } from "./stubs/db-stub";

// biome-ignore lint/suspicious/noExplicitAny: stub 注册表需要宽松类型
type AnyFn = (...args: any[]) => any;

/**
 * 创建带惰性包装函数的 mock 对象。
 * 每个属性通过 Object.defineProperty 注册，getter 返回一个函数，
 * 调用时才查找 stub 注册表。
 */
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

// ── config-pg 导出名称 ──

const CONFIG_PG_KEYS = [
  "AGENT_SETTABLE_FIELDS",
  "addModel",
  "createAgentConfig",
  "createMcpServer",
  "deleteAgentConfig",
  "deleteMcpServer",
  "deleteProvider",
  "deleteSkill",
  "getAgentConfig",
  "getAgentConfigById",
  "getAgentFullConfig",
  "getMcpServer",
  "getProvider",
  "getSkill",
  "getUserConfig",
  "listAgentConfigs",
  "listAgentSkillIds",
  "listMcpServers",
  "listProviders",
  "listSkills",
  "removeModel",
  "setMcpServerEnabled",
  "setUserConfig",
  "syncAgentSkills",
  "updateAgentConfig",
  "updateMcpServer",
  "updateModel",
  "upsertProvider",
  "upsertSkill",
] as const;

mock.module("../services/config-pg", () => createLazyMock(CONFIG_PG_KEYS, getConfigPgStub));

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
  const apiObj = createLazyMock(AUTH_API_KEYS, getAuthApiStub);
  return {
    auth: {
      api: apiObj,
      handler: (_req: Request) => new Response("mocked", { status: 200 }),
    },
  };
});

// ── api-key-service 导出名称 ──

const API_KEY_SERVICE_KEYS = ["createApiKey", "hashApiKey"] as const;

mock.module("../auth/api-key-service", () => createLazyMock(API_KEY_SERVICE_KEYS, getApiKeyServiceStub));

// ── raw db ──

mock.module("../db", () => {
  const obj: Record<string, unknown> = {};
  Object.defineProperty(obj, "db", {
    enumerable: true,
    configurable: true,
    get: () => getDbStub(),
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
});

// ── 以下模块按批次添加：只有当所有使用该模块的测试文件都已迁移到 stub 注册表后才能注册 ──
// 添加前须确认：没有任何未迁移的测试会通过被测代码间接导入这些模块
