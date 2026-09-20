/**
 * Memory 服务端测试装配入口；不得从生产 `./server` 入口导出。
 *
 * 宿主测试 preload（`apps/server/src/test-utils/setup-mocks.ts`）与本包用例都经这里构造记忆模块配置：
 * 同一份「字段清单 + 缺省值」只写一次，避免宿主手抄一份字段清单、包内再抄一份，漏字段时两侧都不可见。
 */

import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import type { MemoryModuleConfig } from "./config";

/**
 * 构造一份字段齐全的记忆模块配置。
 *
 * 缺省值取宿主 `apps/server/src/env.ts` 的部署默认值：`HINDSIGHT_MCP_URL` 可选，未设置即「记忆能力
 * 未启用」，因此缺省调用等价于宿主未配置记忆服务。需要启用记忆的用例显式传
 * `{ hindsightMcpUrl: "..." }`，而不是依赖一个只对测试成立的默认值。
 */
export function createMemoryModuleConfig(overrides: Partial<MemoryModuleConfig> = {}): MemoryModuleConfig {
  return {
    hindsightMcpUrl: undefined,
    ...overrides,
  };
}

/**
 * 复位全部替身后以给定配置初始化应用基础设施。
 *
 * 必须经 `initializeTestApplicationInfrastructure` 走生产读取路径（`getModuleConfig("memory")`），
 * 而不是给模块留测试专用的配置分支；初始化只允许一次，故先复位。
 */
export function initializeMemoryModuleConfig(overrides: Partial<MemoryModuleConfig> = {}): void {
  resetAllStubs();
  initializeTestApplicationInfrastructure({
    moduleConfigs: { memory: createMemoryModuleConfig(overrides) },
  });
}
