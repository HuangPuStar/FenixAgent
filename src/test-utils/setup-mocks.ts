// setup-mocks.ts — 项目中唯一调用 mock.module() 的文件
// 通过 bunfig.toml preload 在所有测试前加载
//
// Bun 的 ESM namespace 会在 import 时提前求值 getter，
// 所以 getter 必须返回一个惰性包装函数，将 stub 查找延迟到调用时。

import { mock } from "bun:test";
import * as actualKnowledgeBaseService from "../services/knowledge-base";
import { getApiKeyServiceStub, getAuthApiStub, getAuthHandlerStub } from "./stubs/auth-stub";
import { getConfigPgStub } from "./stubs/config-pg-stub";
import { getDbStub } from "./stubs/db-stub";
import {
  coreBootstrapRegistry,
  customToolsRegistry,
  environmentServiceRegistry,
  getEnvironmentRepoStub,
  knowledgeBaseServiceRegistry,
  pgStorageAdapterRegistry,
  registryHeartbeatRegistry,
  registryRegistry,
} from "./stubs/module-stubs";
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
  "addAgentSiteApp",
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
  "listAgentSiteAppIds",
  "listAgentSkillIds",
  "listMcpServers",
  "listProviders",
  "listReadableProviders",
  "listSkills",
  "removeAgentSiteApp",
  "removeModel",
  "removeModelById",
  "setMcpServerEnabled",
  "setUserConfig",
  "syncAgentMcps",
  "syncAgentSiteApps",
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
  "signUpEmail",
  "listApiKeys",
  "deleteApiKey",
  "createApiKey",
  "addMember",
  "getFullOrganization",
  "updateOrganization",
  "deleteOrganization",
  "setActiveOrganization",
  "removeMember",
  "updateMemberRole",
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
      handler: (req: Request) => getAuthHandlerStub()?.(req) ?? new Response("mocked", { status: 200 }),
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
  "resetUserPassword",
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

// ── registry / registry-heartbeat / environment / core-bootstrap ──
// 从 acp-machine-connection-lookup.test.ts 的 mock.module() 迁移到 preload。
// 使用 createLazyMock 模式（与 config/index、repositories 完全一致），
// 默认返回空函数（throwOnMissing=false）。各测试文件通过 stubXxx() 配置行为。
// beforeEach 中的 resetAllStubs() 会清除 stub，使其他测试得到空函数（无害）。

const REGISTRY_KEYS = [
  "listMachines",
  "getMachine",
  "listEvents",
  "createMachine",
  "registerMachine",
  "disconnectMachine",
  "markHeartbeatTimeout",
  "updateHeartbeat",
  "resetAllMachinesOffline",
  "updateMachine",
] as const;
mock.module("../services/registry", () => createLazyMock(REGISTRY_KEYS, (name) => registryRegistry.get(name) as AnyFn));

const REGISTRY_HEARTBEAT_KEYS = [
  "startHeartbeat",
  "handleHeartbeat",
  "stopHeartbeat",
  "startMachineSweep",
  "stopMachineSweep",
] as const;
mock.module("../services/registry-heartbeat", () =>
  createLazyMock(REGISTRY_HEARTBEAT_KEYS, (name) => registryHeartbeatRegistry.get(name) as AnyFn),
);

const ENVIRONMENT_KEYS = [
  "createTemporaryEnvironment",
  "deregisterEnvironment",
  "getEnvironment",
  "getEnvironmentBySecret",
  "handleAcpConnect",
  "handleAcpDisconnect",
  "handleAcpIdentify",
  "handleAcpRegister",
  "listActiveEnvironments",
  "listActiveEnvironmentsByUsername",
  "listActiveEnvironmentsResponse",
  "markEnvironmentActive",
  "markEnvironmentIdle",
  "reconnectEnvironment",
  "registerEnvironment",
  "touchEnvironmentPoll",
  "updateEnvironmentCapabilities",
  "deleteEnvironment",
  "ensureWorkspaceDir",
  "generateEnvSecret",
  "getOwnedEnvironment",
  "sanitizeResponse",
  "toResponse",
  "validateWorkspacePath",
  "createWebEnvironment",
  "listEnvironmentsWithInstances",
  "updateWebEnvironment",
] as const;
mock.module("../services/environment", () =>
  createLazyMock(ENVIRONMENT_KEYS, (name) => environmentServiceRegistry.get(name) as AnyFn),
);

const CORE_BOOTSTRAP_KEYS = [
  "getCoreRuntime",
  "initCoreRuntime",
  "setCoreRuntimeFactory",
  "resetCoreRuntime",
  "registerRemoteNode",
  "unregisterRemoteNode",
] as const;
mock.module("../services/core-bootstrap", () =>
  createLazyMock(CORE_BOOTSTRAP_KEYS, (name) => coreBootstrapRegistry.get(name) as AnyFn),
);

// ── pg-storage-adapter ──

mock.module("../services/workflow/pg-storage-adapter", () => ({
  createPgStorageAdapter: () => {
    const storageObj: Record<string, unknown> = {};
    return new Proxy(storageObj, {
      get: (_target, prop) => {
        if (typeof prop !== "string") return;
        return (...args: unknown[]) => pgStorageAdapterRegistry.get(prop)(...args);
      },
    });
  },
}));

// ── custom-tools ──
// 提供 getCustomToolsRegistry / initCustomToolsRegistry 的 stub 入口。
// 路由测试通过 stubCustomTools({ getCustomToolsRegistry: () => fakeRegistry }) 注入数据。

const CUSTOM_TOOLS_KEYS = ["getCustomToolsRegistry", "initCustomToolsRegistry"] as const;
mock.module("../services/workflow/custom-tools", () =>
  createLazyMock(CUSTOM_TOOLS_KEYS, (name) => customToolsRegistry.get(name) as AnyFn),
);

// ── react-i18next ──
// CI 的 bun 包缓存（npmmirror 镜像）解析出的 react-i18next@17.0.8 的 es/index.js
// 不导出 initReactI18next，导致任何导入 react-i18next 的前端测试抛出 SyntaxError。
// 这里提供一个最小 mock，覆盖所有 react-i18next 导出，对后端测试无害（它们不导入该模块）。

mock.module("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: () => Promise.resolve() },
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
  // biome-ignore lint/suspicious/noExplicitAny: mock 不需要精确类型
  Trans: ({ children }: { children: any }) => children,
  // biome-ignore lint/suspicious/noExplicitAny: mock 不需要精确类型
  I18nextProvider: ({ children }: { children: any }) => children,
  withTranslation: () => (Component: unknown) => Component,
}));
