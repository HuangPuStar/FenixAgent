// setup-mocks.ts — 项目中唯一调用 mock.module() 的文件
// 通过 bunfig.toml preload 在所有测试前加载
//
// Bun 的 ESM namespace 会在 import 时提前求值 getter，
// 所以 getter 必须返回一个惰性包装函数，将 stub 查找延迟到调用时。

import { mock } from "bun:test";
import { createAgentConfigModuleConfig } from "@fenix/agent-config/server/testing";
import { createAgentRuntimeModuleConfig } from "@fenix/agent-runtime/server/testing";
import type { IdentityConfig } from "@fenix/identity/server";
import { createModelManagementModuleConfig } from "@fenix/model-management/server/testing";
import {
  getAuthApiStub,
  getAuthHandlerStub,
  getDbStub,
  getModuleConfigStub,
  hasDbStub,
  hasModuleConfigStub,
  registerModuleConfigBaseline,
  registerStubResetter,
  registerTestIdentityDirectory,
} from "@fenix/platform-sdk/testing";
import { createKnowledgeModuleConfig } from "@fenix/resource-knowledge/server/testing";
import * as actualFileWsCloseLog from "@fenix/resource-machine/file-ws-close-log";
// file-ws-handler / file-ws-requests 部分 mock 需要保留真实实现（未配置 stub 时回退），见下方注册处
import * as actualFileWsHandler from "@fenix/resource-machine/file-ws-handler";
import * as actualFileWsPayload from "@fenix/resource-machine/file-ws-payload";
import * as actualFileWsRequests from "@fenix/resource-machine/file-ws-requests";
import { createMachineModuleConfig } from "@fenix/resource-machine/server/testing";
import { createMemoryModuleConfig } from "@fenix/resource-memory/server/testing";
import { createSandboxModuleConfig } from "@fenix/resource-sandbox/server/testing";
import { createSkillModuleConfig } from "@fenix/resource-skill/server/testing";
import { createWorkflowModuleConfig } from "@fenix/resource-workflow/server/testing";
import { getConfigPgStub, resetConfigPgStubs } from "./stubs/config-pg-stub";
import {
  coreBootstrapRegistry,
  fileWsHandlerRegistry,
  getEnvironmentRepoStub,
  registryHeartbeatRegistry,
  registryRegistry,
  resetEnvironmentRepoStub,
  resetModuleStubs,
} from "./stubs/module-stubs";
import { getSystemApiStub, resetSystemApiStubs } from "./stubs/system-api-stub";

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

// ── identity 模块配置基线 ──

// 默认值与 `apps/server/src/env.ts` 的对应变量保持一致：未显式 stub 的用例应当拿到「生产默认配置」，
// 而不是空对象。登记在基线层（见 `@fenix/platform-sdk/testing` 的 module-config-stub），
// `resetAllStubs()` 只清用例覆盖、不清基线。
const IDENTITY_CONFIG_BASELINE = {
  betterAuthUrl: undefined,
  rcsBaseUrl: undefined,
  trustedOrigins: undefined,
  systemAdminPasswordFile: "./data/password.txt",
  disableSignup: false,
} satisfies IdentityConfig;
registerModuleConfigBaseline("identity", IDENTITY_CONFIG_BASELINE);

// ── 资源模块配置的读取 seam（宿主测试进程）──

// 资源模块的路由在请求期经 `getModuleConfig()` 读自己的配置，而宿主测试进程刻意不初始化应用基础设施
// （理由见 `@fenix/platform-sdk/testing` 的 module-config-stub：platform-sdk 自己的用例依赖「未初始化时
// 读取必须失败」）。没有 seam，任何「路由可达」类宿主用例都会在请求期直接 500——这是迁移后的路由与旧
// 宿主路由最本质的差别。这里只在**基础设施尚未初始化**这一种情况下退回模块配置替身注册表（preload 期
// 登记的基线 + 用例覆盖）；已初始化时保持生产读取路径不变。未登记该模块的基线时原样抛出平台错误：
// platform-sdk 的 `server-infrastructure.test.ts` 断言的是「未初始化必须报应用基础设施尚未初始化」，
// 换成替身自己的「未登记」错误会让那条契约用例失去意义。
const platformServer = await import("@fenix/platform-sdk/server");
// 真实实现必须在这里先取到值：`mock.module` 会就地替换模块导出，若在替身里回头调用 `platformServer` 的
// 同名属性，拿到的就是替身自己（实测表现为栈溢出）。
const realGetModuleConfig = platformServer.getModuleConfig;
// 资源包的仓储/服务经平台契约 `getDatabase()` 取 DB 句柄（迁移前读宿主 `db` 导出，由 `getDbStub()` 转发）。
// 同一条 seam 里一并接上：不接的话包内任何仓储调用都会抛「应用基础设施尚未初始化」（实测：
// `round19-isolated-repository-boundaries.test.ts` 的机器/任务日志用例、`config-integration.test.ts`
// 的 Agent 标签投影共 26 项）。回退条件比模块配置多一层：只有用例**登记过** DB 替身（`hasDbStub()`）
// 才回退——没登记说明该用例不碰 DB，必须原样抛出平台错误，`server-infrastructure.test.ts` 的两条契约
// 用例正是断言这种情形。
const realGetDatabase = platformServer.getDatabase;
mock.module("@fenix/platform-sdk/server", () => ({
  ...platformServer,
  getModuleConfig: <TConfig>(moduleId: string): TConfig => {
    try {
      return realGetModuleConfig<TConfig>(moduleId);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("应用基础设施尚未初始化")) {
        throw error;
      }
      if (!hasModuleConfigStub(moduleId)) throw error;
      return getModuleConfigStub<TConfig>(moduleId);
    }
  },
  getDatabase: <TDatabase>(): TDatabase => {
    try {
      return realGetDatabase<TDatabase>();
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("应用基础设施尚未初始化")) {
        throw error;
      }
      if (!hasDbStub()) throw error;
      return getDbStub() as TDatabase;
    }
  },
}));

// 资源模块配置基线：字段清单与缺省值取自包自身的 `./server/testing`（唯一真相），宿主不另抄一份字段表。
// 登记范围＝宿主测试进程里「请求期会经 `getModuleConfig()` 读自己配置」的全部模块；漏登记一个，该模块的
// 「路由可达」类宿主用例就会在请求期 500（实测：补齐前 `apps/server/src/__tests__/` 有 33 项因此失败）。
// 缺省值与 `apps/server/src/config.ts` 的部署默认值一致；两侧一旦分歧，宿主 main.ts 的注入清单与包内
// `strictObject` 校验会在启动期先失败，不会静默走测试缺省值。
registerModuleConfigBaseline("agent-config", createAgentConfigModuleConfig());
registerModuleConfigBaseline("agent-runtime", createAgentRuntimeModuleConfig());
registerModuleConfigBaseline("knowledge", createKnowledgeModuleConfig());
registerModuleConfigBaseline("machine", createMachineModuleConfig());
registerModuleConfigBaseline("memory", createMemoryModuleConfig());
registerModuleConfigBaseline("model-management", createModelManagementModuleConfig());
registerModuleConfigBaseline("sandbox", createSandboxModuleConfig());
registerModuleConfigBaseline("skill", createSkillModuleConfig());
registerModuleConfigBaseline("workflow", createWorkflowModuleConfig());

// ── 宿主模块替身的复位登记 ──

// 平台契约的 `resetAllStubs()` 只复位它自己持有的替身；宿主模块替身（config-pg、system-api、
// services/* 与 environment 的注册表）由本目录的 `stubs/*` 持有，跨进程唯一入口是这里登记的复位器。
// 用例只调用一个复位入口（`@fenix/platform-sdk/testing` 的 `resetAllStubs`），漏复位哪一层都会让该层的
// 用例级配置泄漏到下一条用例，症状是「单独跑通过、全量跑失败」。登记在 preload 期完成，早于任何用例。
registerStubResetter(() => {
  resetConfigPgStubs();
  resetModuleStubs();
  resetEnvironmentRepoStub();
  resetSystemApiStubs();
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
  getIdentityConfig: () => getModuleConfigStub<IdentityConfig>("identity"),
}));

// ── 身份只读窄契约（IdentityDirectory）──

// 生产由宿主 main.ts 在装配阶段 `registerIdentityDirectory()` 注入 identity 的实现；测试进程不装配
// 宿主，若这里不注册，任何经 `getIdentityDirectory()` 的调用都会抛错（org-context、acp 空闲监控、
// observer 名称解析等）。注册的是转发代理而非快照：用例在任意时刻 `stubIdentityDirectory()` 都能
// 立即生效，不需要重新注册。
registerTestIdentityDirectory();

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

// ── workflow 的 pg-storage-adapter / custom-tools：不在这里安装 ──
// 这两个模块级导出的替身由 owner 包自持（`packages/resources/workflow/src/server/testing.ts`）。
// 在 preload 里再按模块路径装一份会**压过**包内替身（Bun 1.3.13 实测：preload 注册的同路径
// mock 优先于包内后注册的 mock，与「后注册者生效」的直觉相反），后果是包内用例
// `stubPgStorageAdapter(...)` 写的是包内注册表、真正生效的却是宿主注册表，断言全部落空
// （workflow-runs 等 32 项因 `listRuns` 返回 undefined 触发响应校验 422）。
// 上面的 import `@fenix/resource-workflow/server/testing` 已把包内替身装好；宿主用例需要配置时
// 也从那个子路径导入 `stubPgStorageAdapter` / `stubCustomTools`，与生效的 mock 读写同一个注册表。

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
  environmentRepo,
  findMachineConnectionById,
  getAgentNodeService,
  getAllEventBuses,
  getOwnedEnvironment,
  removeEventBus,
  resolveWorkspacePath,
  triggerMachineCleanupByMachineId,
} = await import("@fenix/agent-runtime/server");
// 测试 preload 以惰性 stub 绑定路由依赖；该测试钩子不得进入 Machine 的生产公开入口。
const { bindMachineEnvironmentPort, bindMachineHostPort } = await import("@fenix/resource-machine/server");
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
// Machine 包的宿主运行态与环境读取端口（1.4 起由装配层绑定，包不再反向导入 agent-runtime）。
// 转发方向与上面的 core runtime 端口一致：Core runtime 句柄走 coreBootstrapRegistry（用例经
// stubCoreBootstrap 配置），环境读取走 environmentRepo 的实时 Proxy（用例经 stubEnvironmentRepo 配置）。
bindMachineHostPort({
  resolveWorkspacePath,
  // 可选链保留「未配置 stub 时查无此机」的既有语义：`createStubRegistry` 是 throwOnMissing=false
  // （未配置返回空函数），无 stub 时 `getCoreRuntime()` 求值为 undefined，对账面据此判定节点不存在；
  // 直接取 `.getNode` 会 TypeError 把「未配置」变成测试崩溃。
  getCoreRuntimeNode: (machineId) => coreBootstrapRegistry.get("getCoreRuntime")()?.getNode(machineId) ?? null,
  unregisterCoreRuntimeNode: (machineId) => {
    coreBootstrapRegistry.get("unregisterRemoteNode")(machineId);
  },
  findMachineConnectionById,
  triggerMachineCleanupByMachineId,
});
bindMachineEnvironmentPort({
  getEnvironmentById: (environmentId) => environmentRepo.getById(environmentId),
  getOwnedEnvironment,
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
