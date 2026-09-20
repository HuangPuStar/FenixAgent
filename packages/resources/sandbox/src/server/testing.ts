/**
 * Sandbox 服务端测试装配入口；不得从生产 `./server` 入口导出。
 *
 * 宿主测试（`apps/server/src/test-utils/setup-mocks.ts`）与本包用例都经这里构造沙盒模块配置：同一份
 * 「必填字段 + 缺省值」只写一次，避免宿主手抄一份字段清单、包内再抄一份，漏字段时两侧都不可见。
 */

import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import type { SandboxModuleConfig } from "./config";

/**
 * 构造一份字段齐全的沙盒模块配置。
 *
 * 缺省值取宿主 `apps/server/src/config.ts` 的部署默认值（`RCS_SANDBOX_ENABLED` 默认关闭，Provider 与
 * Runtime 超时默认 10s），因此「宿主默认装配」可以直接用缺省调用；需要启用沙盒的用例显式传
 * `{ sandboxEnabled: true }`，而不是依赖一个只对测试成立的默认值。
 */
export function createSandboxModuleConfig(overrides: Partial<SandboxModuleConfig> = {}): SandboxModuleConfig {
  return {
    sandboxEnabled: false,
    sandboxRuntimeConnectTimeoutMs: 10_000,
    sandboxProviderRequestTimeoutMs: 10_000,
    sandboxProviderCreateTimeoutMs: 10_000,
    sandboxProviderResumeTimeoutMs: 10_000,
    sandboxProviderDestroyTimeoutMs: 10_000,
    ...overrides,
  };
}

/**
 * 复位全部替身后以给定配置初始化应用基础设施。
 *
 * 必须经 `initializeTestApplicationInfrastructure` 走生产读取路径（`getModuleConfig("sandbox")`），
 * 而不是给模块留测试专用的配置分支；初始化只允许一次，故先复位。
 */
export function initializeSandboxModuleConfig(overrides: Partial<SandboxModuleConfig> = {}): void {
  resetAllStubs();
  initializeTestApplicationInfrastructure({
    moduleConfigs: { sandbox: createSandboxModuleConfig(overrides) },
  });
}
