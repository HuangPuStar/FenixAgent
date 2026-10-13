import type { TraceModuleConfig } from "./config";

/**
 * Trace 资源包的测试装配入口；不得从生产 `./server` 入口导出。
 *
 * 宿主测试（`apps/server/src/test-utils/setup-mocks.ts`）登记本包配置基线时要与包内用例共用同一份字段
 * 清单与缺省值，避免两侧各抄一份，漏字段时两侧都不可见。
 */

/**
 * 构造一份字段齐全的 trace 模块配置。
 *
 * 缺省值取宿主的部署缺省：三个 `LANGFUSE_*` 变量未设置即观测读取未启用，与
 * `apps/server/src/config.ts` 的缺省一致；宿主一旦改成「默认指向某个后端」，这里也必须同步，
 * 否则宿主用例会在「已配置」的假设下跑而生产缺省其实是引导态。
 */
export function createTraceModuleConfig(overrides: Partial<TraceModuleConfig> = {}): TraceModuleConfig {
  return {
    langfuseBaseUrl: undefined,
    langfusePublicKey: undefined,
    langfuseSecretKey: undefined,
    ...overrides,
  };
}
