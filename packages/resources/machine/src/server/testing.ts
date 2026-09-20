/**
 * Machine 服务端测试装配入口；不得从生产 `./server` 入口导出。
 *
 * 四部分：模块配置构造（宿主 `apps/server/src/test-utils/setup-mocks.ts` 与本包用例共用同一份「必填字段 +
 * 缺省值」）、经生产读取路径完成的基础设施装配（含 DB 句柄转发代理）、本包依赖替换入口（路由/服务/传输各自
 * 的可替换句柄），以及复位登记（用例只调 `resetAllStubs()` 一处，避免漏复位导致「单独跑通过、全量跑失败」）。
 *
 * 为什么这里没有 host 侧那套 `stubRegistry` 之类的转发代理：本包用例跑在生产读取路径上
 * （`getModuleConfig("machine")` / `getDatabase()`），替身只应来自平台契约与包内句柄；宿主 preload 的模块级
 * 替身是宿主测试的装配手段，包不得依赖。
 */

import { NotFoundError } from "@fenix/platform-sdk";
import { overrideModuleConfig } from "@fenix/platform-sdk/server";
import {
  getDbStub,
  initializeTestApplicationInfrastructure,
  registerStubResetter,
  resetAllStubs,
} from "@fenix/platform-sdk/testing";
import type { MachineModuleConfig } from "./config";
import { getMachineConfig } from "./config";
import type { MachineEnvironmentRecord } from "./environment-port";
import { setMachineEnvironmentPort } from "./environment-port";
import { setMachineHostPort } from "./host-port";
import { setFileWsTransport } from "./transport/file-ws-port";

// ── 依赖替换入口（转发本包各模块的可替换句柄，供用例与宿主测试统一从这里取）──
export { setRegistryRouteDeps } from "./routes/web/registry";
/** 文件变更事件告警落库替换（避免 file-ws 协议用例写 registryEvent）。 */
export { resetFileMachineEventDeps, setFileMachineEventDeps } from "./services/file-machine-events";
/** 心跳写入依赖替换（避免用例接触真实 DB）。 */
export { resetRegistryHeartbeatDeps, setRegistryHeartbeatDeps } from "./services/registry-heartbeat";

/**
 * 构造一份字段齐全的 Machine 模块配置。
 *
 * 缺省值取宿主 `apps/server/src/config.ts` 的部署默认值：file-ws 身份绑定默认宽松（`RCS_FILE_WS_IDENTITY_STRICT`
 * 默认 false）、文件事件连接上限默认 200（`RCS_FILE_EVENTS_MAX_CLIENTS`）、无兜底机器
 * （`RCS_DEFAULT_MACHINE_ID` 未设置）。需要兜底机器的用例显式传 `defaultMachineId`，而不是依赖一个只对测试
 * 成立的默认值。
 */
export function createMachineModuleConfig(overrides: Partial<MachineModuleConfig> = {}): MachineModuleConfig {
  return {
    fileWsIdentityStrict: false,
    fileEventsMaxClients: 200,
    ...overrides,
  };
}

/**
 * DB 句柄替身的转发代理。
 *
 * `initializeApplicationInfrastructure()` 持有的是初始化那一刻的对象**引用**，而用例在 `beforeEach` 里才
 * 登记本用例的 DB 替身（`stubDb()`）——直接传当次替身会让后续每次 `stubDb()` 都不生效，症状是「第二个用例
 * 起读到上一个用例的 db」。因此传代理，按每次属性访问转发到当前替身（与宿主 preload 的 `createDbMock`、
 * 以及 knowledge/sandbox 的同名代理同形，三处指向同一个 `getDbStub()`）。
 */
// biome-ignore lint/suspicious/noExplicitAny: Drizzle 句柄形状随用例变化，读取方（仓储）自行收窄
const machineDbProxy = new Proxy({} as Record<string, any>, {
  get: (_target, prop) => getDbStub()[prop as string],
});

/**
 * 复位全部替身后以给定配置初始化应用基础设施。
 *
 * 必须经 `initializeTestApplicationInfrastructure` 走生产读取路径（`getModuleConfig("machine")`），而不是给模块
 * 留测试专用的配置分支；初始化只允许一次，故先复位。
 *
 * 只注入 Machine 自己的模块配置：沙盒路由判定已随 1.4 迁回 Sandbox 模块并经
 * `bindMachineSandboxRoutePort` 注入（见 `host-port.ts` 的同批说明），本包不再读 `getSandboxConfig()`。
 */
export function initializeMachineModuleConfig(overrides: Partial<MachineModuleConfig> = {}): void {
  resetAllStubs();
  initializeTestApplicationInfrastructure({
    database: machineDbProxy,
    moduleConfigs: {
      machine: createMachineModuleConfig(overrides),
    },
  });
}

/**
 * 用例内改动模块配置。
 *
 * 基础设施持有的是初始化时的整份配置（初始化只允许一次），因此运行期调整走 `overrideModuleConfig()`——它是
 * **整值替换**，这里按合并语义补齐其余字段：用例只想改兜底机器不该顺带把此前设好的 file-ws 严格模式清空。
 * 读取经 `getMachineConfig()`，与生产路径同一次校验。
 */
export function stubMachineConfig(overrides: Partial<MachineModuleConfig>): void {
  overrideModuleConfig("machine", { ...getMachineConfig(), ...overrides });
}

/**
 * 替换环境读取实现（`getEnvironmentById` / `getOwnedEnvironment`）。
 *
 * 刻意不做「初始化 + 替换」的合并入口：配置必须在 `initializeMachineModuleConfig` 之前定好（初始化只允许一次），
 * 句柄替换则可以发生在用例中任意时刻，两者生命周期不同。
 */
export function stubMachineEnvironment(overrides: Parameters<typeof setMachineEnvironmentPort>[0]): void {
  setMachineEnvironmentPort(overrides);
}

/**
 * 用一条环境记录同时替换两个环境读取原语（`getOwnedEnvironment` + `getEnvironmentById`）。
 *
 * fs 路由用例的最小装配：门面的 `ensureEnvironment` 读归属校验、workspace 路径解析读记录读取，两者由
 * 同一条记录驱动，才不会出现「校验通过但路径解析拿不到记录」的半装配状态。传 `null` 表示环境不存在：
 * 记录读取返回 null（路径解析走 404 分支），归属校验抛 `NotFoundError`——与生产实现（agent-runtime 的
 * `getOwnedEnvironment` 在记录缺失/跨组织时抛 `NotFoundError`）同类型同消息，因此路由按 `not_found`
 * 映射的结果不依赖 DB 替身恰好返回空对象这一偶然行为。
 *
 * 需要断言归属/角色失败（403、跨组织 404）的用例直接用 `stubMachineEnvironment` 传自定义
 * `getOwnedEnvironment`，不经本夹具。
 */
export function stubMachineEnvironmentRecord(record: MachineEnvironmentRecord | null): void {
  if (record) {
    stubMachineEnvironment({
      getEnvironmentById: async () => record,
      getOwnedEnvironment: async () => record,
    });
    return;
  }
  stubMachineEnvironment({
    getEnvironmentById: async () => null,
    getOwnedEnvironment: async () => {
      throw new NotFoundError("环境不存在");
    },
  });
}

/**
 * 替换 file-ws 传输实现（连接查询 / 文件操作请求应答）。
 *
 * 传 `null` 恢复包内真实实现，便于「默认实现仍然生效」的断言。
 */
export function stubFileWsTransport(overrides: Parameters<typeof setFileWsTransport>[0]): void {
  setFileWsTransport(overrides);
}

// 复位登记：本包的可替换句柄是模块级状态，不复位会跨用例泄漏（症状是「单独跑通过、全量跑失败」）。
// 注意：工作区根锁**不在这里**复位——它的生命周期是「用例持有到用例结束」，挂进 `resetAllStubs()` 等于在
// 每个 `beforeEach` 里放锁，互斥立刻失效。
registerStubResetter(() => {
  setFileWsTransport(null);
  setMachineEnvironmentPort(null);
  setMachineHostPort(null);
});

// 工作区根锁的**实现**归平台契约（`WORKSPACE_ROOT` 是跨包共享的进程级根：只有本包参与互斥等于没锁，
// 别的包的文件照旧改根），原因、用法与「先恢复再解锁」的顺序约束见
// `packages/platform/platform-sdk/src/testing/workspace-root-lock.ts`。这里只转发，包内用例继续从本入口取。
export {
  lockTestWorkspaceRoot as lockMachineWorkspaceRoot,
  unlockTestWorkspaceRoot as unlockMachineWorkspaceRoot,
} from "@fenix/platform-sdk/testing";
