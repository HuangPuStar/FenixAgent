/**
 * Agent Runtime 服务端测试装配入口；不得从生产 `./server` 入口导出。
 *
 * 与 machine / knowledge / sandbox 的同名入口同口径，收敛三件事，避免宿主 preload 与包内用例各抄一份字段清单：
 * 1. 「字段齐全 + 缺省值」的模块配置构造（宿主 preload 的基线登记与本包用例共用这一份真相）；
 * 2. 经 `initializeTestApplicationInfrastructure()` 走**生产读取路径**（`getAgentRuntimeConfig()` →
 *    `getModuleConfig("agent-runtime")`）完成装配，而不是给包内代码留测试专用配置分支；
 * 3. 用例内调整配置的 `overrideModuleConfig()` 入口（基础设施只允许初始化一次）。
 *
 * 为什么包内用例不能改用 `getModuleConfigStub()`：那是宿主 preload 为「刻意不初始化基础设施」的进程准备的
 * 模块级替身（见 platform-sdk 的 `module-config-stub.ts`）；本包生产代码读的是 `getModuleConfig()`，
 * 配置必须真的经 `initializeApplicationInfrastructure()` 装进去。
 */

import { overrideModuleConfig } from "@fenix/platform-sdk/server";
import { getDbStub, initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import type { AgentRuntimeModuleConfig } from "./config";
import { getAgentRuntimeConfig } from "./config";

/**
 * 构造一份字段齐全的 Agent Runtime 模块配置。
 *
 * 四个超时/保活旋钮取宿主部署默认值（`apps/server/src/env.ts` 的 zod default，与 `apps/server/src/config.ts`
 * 同源）：ACP 空闲 / 巡检 / 业务超时 300 / 300 / 1200 秒，WS 保活间隔 20 秒。
 *
 * **三个并发上限刻意不设置**。它们在宿主 env schema 里是 `optional`（`RCS_USER_AGENT_MAX_CONCURRENCY` 除外，
 * 部署默认 10），而迁移前宿主测试进程读到的是 `buildConfig({} as Env)`——即全部 `undefined`，限流不生效。
 * 这里若照抄部署默认值，`userAgentMaxConcurrency: 10` 会给宿主用例新引入一条它们从未见过的用户级配额
 * （单用户多实例的用例会变成 429）。需要验证限流的用例显式传值。
 */
export function createAgentRuntimeModuleConfig(
  overrides: Partial<AgentRuntimeModuleConfig> = {},
): AgentRuntimeModuleConfig {
  return {
    acpIdleTimeoutSeconds: 300,
    acpIdleSweepIntervalSeconds: 300,
    acpActivityTimeoutSeconds: 1200,
    wsKeepaliveInterval: 20,
    ...overrides,
  };
}

/**
 * DB 句柄替身的转发代理。
 *
 * `initializeApplicationInfrastructure()` 持有的是初始化那一刻的对象**引用**，而用例在 `beforeEach`
 * 里才登记本用例的 DB 替身（`stubDb()`）。若直接把当次替身传进去，后续每次 `stubDb()` 都不生效，
 * 症状是「第二个用例起读到上一个用例的 db」。因此这里传代理，按每次属性访问转发到当前替身
 * （与宿主 preload 的 `createDbMock` 同形，两处指向同一个 `getDbStub()`）。
 */
// biome-ignore lint/suspicious/noExplicitAny: Drizzle 句柄形状随用例变化，读取方（仓储）自行收窄
const agentRuntimeDbProxy = new Proxy({} as Record<string, any>, {
  get: (_target, prop) => getDbStub()[prop as string],
});

/**
 * 复位全部替身后以给定配置初始化应用基础设施。
 *
 * 必须在 `beforeEach` 调用：初始化只允许一次，而 `resetAllStubs()` 会连同应用基础设施一起复位，
 * 因此每个用例都能重新装配自己的配置与 DB 句柄。
 */
export function initializeAgentRuntimeModuleConfig(overrides: Partial<AgentRuntimeModuleConfig> = {}): void {
  resetAllStubs();
  initializeTestApplicationInfrastructure({
    database: agentRuntimeDbProxy,
    moduleConfigs: { "agent-runtime": createAgentRuntimeModuleConfig(overrides) },
  });
}

/**
 * 用例内改动模块配置。
 *
 * 基础设施持有的是初始化那一刻的整份配置，因此运行期调整走 `overrideModuleConfig()`——它是**整值替换**，
 * 这里按合并语义补齐其余字段：用例只想改一个并发上限，不该顺带把已设好的超时清空。读取经
 * `getAgentRuntimeConfig()`，与生产路径同一次校验。显式传 `undefined` 可回到「该上限不生效」。
 */
export function stubAgentRuntimeConfig(overrides: Partial<AgentRuntimeModuleConfig>): void {
  overrideModuleConfig("agent-runtime", { ...getAgentRuntimeConfig(), ...overrides });
}

/** 读取当前生效的模块配置（走生产校验路径，便于用例断言注入值确实被消费方看到）。 */
export { getAgentRuntimeConfig };
