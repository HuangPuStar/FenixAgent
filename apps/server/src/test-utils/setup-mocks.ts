// setup-mocks.ts — 项目中唯一调用 mock.module() 的文件
// 通过 bunfig.toml preload 在所有测试前加载
//
// Bun 的 ESM namespace 会在 import 时提前求值 getter，
// 所以 getter 必须返回一个惰性包装函数，将 stub 查找延迟到调用时。

import { mock } from "bun:test";
import type { IdentityDirectory } from "@fenix/platform-sdk";
import { registerIdentityDirectory } from "@fenix/platform-sdk/server";
import type * as ActualKnowledgeBaseService from "@fenix/resource-knowledge/server";
import * as actualFileWsCloseLog from "@fenix/resource-machine/file-ws-close-log";
// file-ws-handler / file-ws-requests 部分 mock 需要保留真实实现（未配置 stub 时回退），见下方注册处
import * as actualFileWsHandler from "@fenix/resource-machine/file-ws-handler";
import * as actualFileWsPayload from "@fenix/resource-machine/file-ws-payload";
import * as actualFileWsRequests from "@fenix/resource-machine/file-ws-requests";
import { getAuthApiStub, getAuthHandlerStub } from "./stubs/auth-stub";
import { getConfigPgStub } from "./stubs/config-pg-stub";
import { getDbStub } from "./stubs/db-stub";
import { getIdentityDirectoryStub } from "./stubs/identity-directory-stub";
import { getIdentityConfigStub } from "./stubs/identity-stub";
import {
  coreBootstrapRegistry,
  customToolsRegistry,
  fileWsHandlerRegistry,
  getEnvironmentRepoStub,
  knowledgeBaseServiceRegistry,
  pgStorageAdapterRegistry,
  registryHeartbeatRegistry,
  registryRegistry,
} from "./stubs/module-stubs";
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
//
// 只列会触碰 DB / 外部状态的函数；清单必须与 `services/config/index.ts` 的真实导出同步，理由见
// config-pg-stub.ts。mcp / skill / provider / model 的配置面已在任务 1.2 迁入各自资源包，不在此处。
const CONFIG_PG_KEYS = ["getUserConfig", "setUserConfig", "upsertSystemMcpServer"] as const;

mock.module("@server/services/config", () =>
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

// identity 是纯库：better-auth 实例经 `getAuth()` 惰性构造，构造期需要宿主完成应用基础设施初始化
// （DB + identity 模块配置），而测试进程不初始化基础设施（见下方 identity 基础设施 mock 的说明）。
// 因此这里直接替换整个模块，`resetAuth()` 退化为空操作——测试里的单例状态由各用例的 stub 决定。
mock.module("../../../../packages/platform/identity/src/auth/better-auth", () => {
  // biome-ignore lint/suspicious/noExplicitAny: stub 注册表需要宽松类型
  const apiObj = createLazyMock(AUTH_API_KEYS, getAuthApiStub as (name: string) => any);
  return {
    getAuth: () => ({
      api: apiObj,
      handler: (req: Request) => getAuthHandlerStub()?.(req) ?? new Response("mocked", { status: 200 }),
    }),
    resetAuth: () => {},
  };
});

// ── identity 的基础设施入口（DB 与模块配置）──

// identity 经 `@fenix/platform-sdk/server` 读取 DB 与模块配置，生产由宿主 main.ts 的
// `initializeApplicationInfrastructure()` 提供。测试进程不初始化应用基础设施：
// platform-sdk 的 server-infrastructure.test.ts 依赖"未初始化时读取必须失败"这一前提，
// 在 preload 里初始化会让那条用例失去意义。因此这里把 identity 的两个入口接到既有 stub
// 注册表——DB 走 getDbStub()（与宿主 ../db 的替身同源），配置走 stubIdentityConfig()。
const identityDbProxy = new Proxy({} as Record<string, unknown>, {
  get: (_target, prop) => getDbStub()[prop as string],
});
mock.module("../../../../packages/platform/identity/src/db", () => ({
  getIdentityDatabase: () => identityDbProxy,
}));
mock.module("../../../../packages/platform/identity/src/config", () => ({
  getIdentityConfig: () => getIdentityConfigStub(),
}));

// ── 身份只读窄契约（IdentityDirectory）──

// 生产由宿主 main.ts 在装配阶段 `registerIdentityDirectory()` 注入 identity 的实现；测试进程不装配
// 宿主，若这里不注册，任何经 `getIdentityDirectory()` 的调用都会抛错（org-context、acp 空闲监控、
// observer 名称解析等）。注册的是转发代理而非快照：用例在任意时刻 `stubIdentityDirectory()` 都能
// 立即生效，不需要重新注册。
registerIdentityDirectory(
  new Proxy({} as IdentityDirectory, {
    get: (_target, prop) => getIdentityDirectoryStub()[prop as keyof IdentityDirectory],
  }),
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

mock.module("../../../../packages/platform/identity/src/services/system-api", () =>
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
mock.module("../../../../db", createDbMock);
// PHY-03 runtime 包直接引用宿主 DB；同时注册其规范绝对相对路径，避免 Bun 按导入
// specifier 区分模块身份时绕过现有 `../db` 测试替身。
mock.module("@server/db", createDbMock);

// 先注册 DB 替身，再载入会由公开入口触达认证路由的知识库服务，避免真实 DB/auth 初始化循环。
const actualKnowledgeBaseService: typeof ActualKnowledgeBaseService = await import("@fenix/resource-knowledge/server");

// ── 以下模块按批次添加：只有当所有使用该模块的测试文件都已迁移到 stub 注册表后才能注册 ──
// 添加前须确认：没有任何未迁移的测试会通过被测代码间接导入这些模块
//
// 注意：../repositories 等模块导出了对象实例（repo），不能使用 createLazyMock（仅适用于函数导出）。
// 这些模块需要被测代码使用 DI 注入模式后才能安全加入 preload。当前保留 mock.module() 在测试文件中。

// ── agent-runtime 环境仓储（对象导出）──
// 仅有 acp-machine-connection-lookup.test.ts 和 relay-handler-machine.test.ts 使用 mock

mock.module("../../../../packages/agent-runtime/src/server/repositories/environment", () => {
  // 用 Proxy 实时转发而非对象 getter：具名导入（如 environment-core 的
  // `import { environmentRepo } from "@server/repositories"`）在模块首次求值时固化绑定，
  // getter 一次返回的对象引用会被缓存——若其他测试文件先求值该模块，
  // 后置的 stubEnvironmentRepo 将永远不生效（fs-upload-escape.test.ts 全量运行曾因此 404）。
  // Proxy 把每次属性访问实时转发到当前 stub（与上方 ../db 的 createDbMock 同模式），
  // 未配置 stub 时仍回退 `{ getById: async () => null }`，语义与原先一致。
  const environmentRepoProxy = new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => {
      const stub = getEnvironmentRepoStub();
      const target = stub ?? { getById: async () => null };
      return target[prop as string];
    },
  });
  return { environmentRepo: environmentRepoProxy };
});

mock.module("@fenix/resource-knowledge/server", () => ({
  ...actualKnowledgeBaseService,
  listKnowledgeBasesGlobal: (...args: unknown[]) =>
    knowledgeBaseServiceRegistry.get("listKnowledgeBasesGlobal")(...args),
  listKnowledgeBasesByTeamId: (...args: unknown[]) =>
    knowledgeBaseServiceRegistry.get("listKnowledgeBasesByTeamId")(...args),
}));

const CORE_BOOTSTRAP_KEYS = [
  "getCoreRuntime",
  "initCoreRuntime",
  "setCoreRuntimeFactory",
  "resetCoreRuntime",
  "registerRemoteNode",
  "unregisterRemoteNode",
] as const;
mock.module("@server/services/core-bootstrap", () =>
  createLazyMock(CORE_BOOTSTRAP_KEYS, (name) => coreBootstrapRegistry.get(name) as AnyFn),
);

// ── pg-storage-adapter ──

mock.module("../../../../packages/resources/workflow/src/server/services/workflow/pg-storage-adapter", () => ({
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
mock.module("../../../../packages/resources/workflow/src/server/services/workflow/custom-tools", () =>
  createLazyMock(CUSTOM_TOOLS_KEYS, (name) => customToolsRegistry.get(name) as AnyFn),
);

// ── file-ws-handler / file-ws-requests（W5a 起）──
// 部分 mock：isFileWsConnected（handler）与 sendFileOpAndWait（file-ws-requests，
// 自 handler 拆分后的请求发送域）可 stub，其余导出保留真实实现——file-ws-handler.test.ts
// 直接测这两个函数的真实行为（背压、巡检、回执），因此 stub 未配置时回退真实实现而非空函数。
const FILE_WS_KEYS = ["isFileWsConnected"] as const;
mock.module("@fenix/resource-machine/file-ws-handler", () => {
  const obj: Record<string, unknown> = { ...actualFileWsHandler };
  for (const key of FILE_WS_KEYS) {
    Object.defineProperty(obj, key, {
      enumerable: true,
      configurable: true,
      get: () => {
        // biome-ignore lint/suspicious/noExplicitAny: 部分 mock 需要宽松类型
        const actualFn = (actualFileWsHandler as Record<string, any>)[key];
        return (...args: unknown[]) => {
          if (fileWsHandlerRegistry.has(key)) return fileWsHandlerRegistry.get(key)(...args);
          return actualFn(...args);
        };
      },
    });
  }
  return obj;
});

const FILE_WS_REQUEST_KEYS = ["sendFileOpAndWait"] as const;
mock.module("@fenix/resource-machine/file-ws-requests", () => {
  const obj: Record<string, unknown> = { ...actualFileWsRequests };
  for (const key of FILE_WS_REQUEST_KEYS) {
    Object.defineProperty(obj, key, {
      enumerable: true,
      configurable: true,
      get: () => {
        // biome-ignore lint/suspicious/noExplicitAny: 部分 mock 需要宽松类型
        const actualFn = (actualFileWsRequests as Record<string, any>)[key];
        return (...args: unknown[]) => {
          if (fileWsHandlerRegistry.has(key)) return fileWsHandlerRegistry.get(key)(...args);
          return actualFn(...args);
        };
      },
    });
  }
  return obj;
});

// ── react-i18next（2026-09-20 移除，勿恢复）──
// 此处原有「react-i18next 不可用时按需注册最小 mock」的探针与回退分支，其前提已证伪：
// bun.lock 记录的 react-i18next@17.0.8 integrity 与 registry.npmjs.org 的 dist.integrity
// 逐字节一致，且 CI 走 `bun install --frozen-lockfile`（integrity 不符会安装失败而非静默装入），
// 因此任何来源装出的都是上游正版 tarball，其 dist/es/index.js:11 导出 initReactI18next。
// 实测探针为 true、回退分支从未注册——该导出是否存在只取决于包内容，而包内容由锁文件 integrity 固定；
// 整段删除后 `env -u ANTHROPIC_MODEL bun run precheck` 仍全绿，故按死代码移除。
// 移除理由：探针让每个测试进程（含纯后端）都执行 `import("react-i18next")` 并提前加载 React；
// 且 try/catch 会把任何 import 异常静默转成 mock，真实依赖故障会被伪装成文案断言失败，更难定位。
// 若将来 Bun 对根入口 named export 的解析真的回归，表现为 import 期直接失败，报错直指缺导出。

// 测试依赖必须经 runtime 的服务端公开入口加载，避免绕过 workspace 的稳定边界。
const {
  bindCoreRuntimePort,
  bindFileWsPort,
  bindLocalNodeAgentNodeServicePort,
  bindMachineRegistryPort,
  bindSessionEventBusPort,
  getAgentNodeService,
  getAllEventBuses,
  removeEventBus,
} = await import("@fenix/agent-runtime/server");
// 测试 preload 以惰性 stub 绑定路由依赖；该测试钩子不得进入 Machine 的生产公开入口。
const { setRegistryRouteDeps } = await import("@fenix/resource-machine/server/testing");
bindCoreRuntimePort({
  getCoreRuntime: () => coreBootstrapRegistry.get("getCoreRuntime")(),
  registerRemoteNode: (...args) => {
    coreBootstrapRegistry.get("registerRemoteNode")(...args);
  },
  unregisterRemoteNode: (machineId) => {
    coreBootstrapRegistry.get("unregisterRemoteNode")(machineId);
  },
});
bindMachineRegistryPort({
  registerMachine: (input) => registryRegistry.get("registerMachine")(input),
  disconnectMachine: (machineId, reason) => registryRegistry.get("disconnectMachine")(machineId, reason),
  handleHeartbeat: (machineId) => registryHeartbeatRegistry.get("handleHeartbeat")(machineId),
  startHeartbeat: (machineId, intervalMs, onTimeout) =>
    registryHeartbeatRegistry.get("startHeartbeat")(machineId, intervalMs, onTimeout),
  stopHeartbeat: (machineId) => registryHeartbeatRegistry.get("stopHeartbeat")(machineId),
});
bindLocalNodeAgentNodeServicePort({ getAgentNodeService });
bindSessionEventBusPort({ getAllBuses: getAllEventBuses, removeBus: removeEventBus });
bindFileWsPort({
  checkParsedObjectSize: actualFileWsPayload.checkParsedObjectSize,
  checkWsMessageSize: actualFileWsPayload.checkWsMessageSize,
  estimateWsMessageBytes: actualFileWsPayload.estimateWsMessageBytes,
  formatFileWsCloseLog: actualFileWsCloseLog.formatFileWsCloseLog,
  handleFileWsClose: actualFileWsHandler.handleFileWsClose,
  handleFileWsMessage: actualFileWsHandler.handleFileWsMessage,
  handleFileWsOpen: actualFileWsHandler.handleFileWsOpen,
  parseFileWsMessage: actualFileWsPayload.parseFileWsMessage,
});
setRegistryRouteDeps({
  createMachine: ((...args: unknown[]) => registryRegistry.get("createMachine")(...args)) as never,
  deleteMachine: ((...args: unknown[]) => registryRegistry.get("deleteMachine")(...args)) as never,
  getMachine: ((...args: unknown[]) => registryRegistry.get("getMachine")(...args)) as never,
  listEvents: ((...args: unknown[]) => registryRegistry.get("listEvents")(...args)) as never,
  listMachines: ((...args: unknown[]) => registryRegistry.get("listMachines")(...args)) as never,
  updateMachine: ((...args: unknown[]) => registryRegistry.get("updateMachine")(...args)) as never,
});
