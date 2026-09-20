/**
 * Workflow 服务端测试装配入口；不得从生产 `./server` 入口导出。
 *
 * 三件事在这里收敛，避免宿主 preload、包内用例各抄一份：
 * 1. 「字段齐全 + 缺省值」的模块配置构造（缺省值取宿主 `apps/server/src/config.ts` 的部署默认值）；
 * 2. 经 `initializeTestApplicationInfrastructure()` 走生产读取路径（`getDatabase()` / `getModuleConfig()`）
 *    完成替身装配，而不是给包内代码留测试专用分支；
 * 3. 本包自身模块的替身（PG 存储适配器、CustomNode 工具表）——**只在这里**安装模块替身。
 *
 * 为什么第 3 条用 `mock.module()`：`createPgStorageAdapter` 与 `getCustomToolsRegistry` 是模块级导出，
 * 用例无法通过参数注入替换（路由工厂的依赖面刻意只留认证守卫）。这两个替身原先由宿主 preload
 * （`apps/server/src/test-utils/setup-mocks.ts`）按模块路径安装，于是包内用例必须 import 宿主内部路径才能
 * 配置它们——正是本任务要切断的依赖。改为由包的 `/server/testing` 在被 import 时安装：包内用例只 import
 * 本文件即可自持。用例文件本身不调用 `mock.module()`。
 *
 * ⚠️ 宿主 preload 因此**不得**再安装同名替身：Bun 1.3.13 实测 preload 注册的 mock 优先于包内后注册的
 * 同路径 mock（与「后注册者生效」的直觉相反），两份并存会让 `stubPgStorageAdapter(...)` 写的注册表
 * 与生效的 mock 读的注册表不是同一个——症状是路由断言全部落空（workflow-runs 等 32 项 422）。
 * 宿主用例需要配置这两个替身时，也从本子路径导入 `stubPgStorageAdapter` / `stubCustomTools`。
 *
 * 复位统一走 `@fenix/platform-sdk/testing` 的 `resetAllStubs()`：本文件用 `registerStubResetter`
 * 把两个注册表挂进去，用例只调用一个复位入口；漏挂会让「单独跑通过、全量跑失败」。
 */

import { mock } from "bun:test";
import {
  createStubRegistry,
  getDbStub,
  initializeTestApplicationInfrastructure,
  registerStubResetter,
  resetAllStubs,
} from "@fenix/platform-sdk/testing";
import type { WorkflowModuleConfig } from "./config";

/**
 * 构造一份字段齐全的 Workflow 模块配置。
 *
 * 缺省值对齐宿主部署默认：`ACPX_G_URL` 默认 `http://localhost:8848`；`RCS_BASE_URL` 为空时宿主
 * `getBaseUrl()` 回退到 `http://localhost:${RCS_PORT}`（`RCS_PORT` 默认 3000）并去掉尾部斜杠；
 * `WORKFLOW_TOOLS_DIR` 未配置时包内回退到 `<cwd>/tools`；HMAC 密钥未配置时由进程随机生成，故缺省留空。
 */
export function createWorkflowModuleConfig(overrides: Partial<WorkflowModuleConfig> = {}): WorkflowModuleConfig {
  return {
    baseUrl: "http://localhost:3000",
    acpxGUrl: "http://localhost:8848",
    ...overrides,
  };
}

/**
 * DB 句柄替身的转发代理。
 *
 * `initializeApplicationInfrastructure()` 持有的是初始化那一刻的对象**引用**，而用例在 `beforeEach`
 * 里才登记本用例的 DB 替身（`stubDb()`）。若直接把当前替身传进去，后续每次 `stubDb()` 都不生效，
 * 症状是「第二个用例起读到上一个用例的 db」。因此这里传代理，按每次属性访问转发到当前替身。
 *
 * 与宿主 preload 的 `createDbMock` 同形（那边是 `@server/db` 的替身），两处指向同一个 `getDbStub()`，
 * 宿主用例与包内用例看到同一份 DB。
 */
const workflowDbProxy = new Proxy({} as Record<string, unknown>, {
  get: (_target, prop) => getDbStub()[prop as string],
});

/**
 * 复位全部替身后以给定配置初始化应用基础设施。
 *
 * 必须在 `beforeEach` 调用：初始化只允许一次，`resetAllStubs()` 会连同应用基础设施一起复位，
 * 因此每个用例都能重新装配自己的配置与 DB 替身。
 *
 * 第二个参数声明「本用例还会读到哪些模块的配置」：用例经本包的生产路径间接读其他资源包的模块配置
 * （如 `skill` 的技能根目录）时必须一并声明，否则生产读取路径会以「模块 X 未声明应用基础设施配置」
 * 失败。配置对象由**对方包的 `/server/testing` 工厂**产出（字段清单归各包自持），本包不手抄字段表。
 */
export function initializeWorkflowModuleConfig(
  overrides: Partial<WorkflowModuleConfig> = {},
  extraModuleConfigs: Record<string, object> = {},
): void {
  resetAllStubs();
  initializeTestApplicationInfrastructure({
    database: workflowDbProxy,
    moduleConfigs: { workflow: createWorkflowModuleConfig(overrides), ...extraModuleConfigs },
  });
}

// ── 本包模块替身 ──

/**
 * PG 存储适配器替身（`createPgStorageAdapter` 返回对象的各方法）。
 *
 * 路由用例关心的是协议映射（分页参数怎么传、错误怎么映射），不是 SQL；让真实 Drizzle 查询链跑在替身
 * DB 上需要构造完整查询构建器，成本与收益不成比例。未登记的方法返回空函数（`throwOnMissing = false`，
 * 与迁移前宿主 preload 替身的行为一致），因此用例只需登记它断言到的方法。
 */
export const pgStorageAdapterRegistry = createStubRegistry("pgStorageAdapter", false);

/**
 * CustomNode 工具表替身（`getCustomToolsRegistry()` / `initCustomToolsRegistry()`）。
 *
 * 工具表在装配期扫描磁盘目录，用例不应依赖真实目录内容；注册表让用例直接给出 `list()` 结果。
 */
export const customToolsRegistry = createStubRegistry("customTools", false);

/** 登记 PG 存储适配器替身方法。 */
export function stubPgStorageAdapter(
  // biome-ignore lint/suspicious/noExplicitAny: 替身要承载任意适配器方法签名，读取方在路由层收窄
  overrides: Record<string, (...args: any[]) => any>,
): void {
  pgStorageAdapterRegistry.stub(overrides);
}

/** 登记 CustomNode 工具表替身函数。 */
export function stubCustomTools(
  // biome-ignore lint/suspicious/noExplicitAny: 同上，替身函数签名由用例决定
  overrides: Record<string, (...args: any[]) => any>,
): void {
  customToolsRegistry.stub(overrides);
}

/**
 * PG 存储适配器模块替身（整体替换，不做「未登记时回退真实实现」）。
 *
 * 替身对象按「方法名 → 注册表」惰性转发：适配器是每次调用 `createPgStorageAdapter()` 新建的对象，
 * 而用例在 `beforeEach` 才登记方法，因此不能把方法快照进返回值。
 *
 * ⚠️ 为什么**不能**写成「未登记时 import 真实模块回退」：`mock.module(本路径)` 注册后，本文件里
 * `import * as actual` 拿到的就是被替换后的命名空间，`actual.createPgStorageAdapter()` 会再进本工厂，
 * 无限递归（实测 `RangeError: Maximum call stack size exceeded`，且 `bun test` 此时整个文件挂死不报错）。
 * 迁移前宿主 preload（`apps/server/src/test-utils/setup-mocks.ts`）对该模块也是无条件整体替换，
 * 因此「未登记的方法返回空函数」与迁移前语义一致，用例只登记它断言到的方法。
 */
mock.module("./services/workflow/pg-storage-adapter", () => ({
  createPgStorageAdapter: (_organizationId: string) =>
    new Proxy(
      {},
      {
        // 非字符串键（Symbol.toPrimitive、then 等）必须什么都不返回（等价于 undefined），否则调用方做
        // `await adapter` / 隐式转换时会拿到一个函数并被当成 thenable，导致永久挂起。
        get: (_target, prop) => {
          if (typeof prop !== "string") return;
          return (...args: unknown[]) => pgStorageAdapterRegistry.get(prop)(...args);
        },
      },
    ),
}));

/**
 * CustomNode 工具表模块替身（整体替换，理由同上）。
 *
 * 只导出被用例需要替换的两个函数；真实实现（磁盘扫描）在包内用例中不可用——迁移前宿主 preload
 * 也是同样的两键替换。
 */
mock.module("./services/workflow/custom-tools", () => ({
  getCustomToolsRegistry: () => customToolsRegistry.get("getCustomToolsRegistry")(),
  initCustomToolsRegistry: (toolsDir?: string) => customToolsRegistry.get("initCustomToolsRegistry")(toolsDir),
}));

// 复位登记：`resetAllStubs()` 是包内用例的唯一复位入口（见文件头注释）。
registerStubResetter(() => {
  pgStorageAdapterRegistry.reset();
  customToolsRegistry.reset();
});
