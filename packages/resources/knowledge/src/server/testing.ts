/**
 * Knowledge 服务端测试装配入口；不得从生产 `./server` 入口导出。
 *
 * 三件事在这里收敛，避免宿主 preload、包内用例各抄一份字段清单：
 * 1. 「字段齐全 + 缺省值」的模块配置构造（缺省值取宿主 `apps/server/src/config.ts` 的部署默认值）；
 * 2. 经 `initializeTestApplicationInfrastructure()` 走生产读取路径（`getModuleConfig("knowledge")`）
 *    完成替身装配，而不是给包内代码留测试专用分支；
 * 3. DB 句柄替身的转发代理（见 `knowledgeDbProxy` 的说明）。
 *
 * 复位统一走 `@fenix/platform-sdk/testing` 的 `resetAllStubs()`——它包含应用基础设施复位，因此每个
 * 用例都能重新装配自己的配置与 DB 替身。
 */

import { overrideModuleConfig } from "@fenix/platform-sdk/server";
import { getDbStub, initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import type { KnowledgeModuleConfig } from "./config";
import { getKnowledgeConfig } from "./config";

/**
 * 构造一份字段齐全的 Knowledge 模块配置。
 *
 * 缺省值对齐宿主部署默认（`RAGFLOW_API_URL` 默认 `http://localhost:9380`、`RAGFLOW_API_KEY` 默认空 =
 * 未配置 RAGFlow、`RAGFLOW_REQUEST_TIMEOUT_MS` 默认 30s、`GOTENBERG_URL` 默认 `http://127.0.0.1:3200`），
 * 因此「宿主默认装配」可以直接用缺省调用；需要走真实 provider 的用例显式传 key，而不是依赖一个只对
 * 测试成立的默认值。
 */
export function createKnowledgeModuleConfig(overrides: Partial<KnowledgeModuleConfig> = {}): KnowledgeModuleConfig {
  return {
    ragflowApiUrl: "http://localhost:9380",
    ragflowApiKey: "",
    ragflowRequestTimeoutMs: 30_000,
    gotenbergUrl: "http://127.0.0.1:3200",
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
const knowledgeDbProxy = new Proxy({} as Record<string, any>, {
  get: (_target, prop) => getDbStub()[prop as string],
});

/**
 * 复位全部替身后以给定配置初始化应用基础设施。
 *
 * 必须在 `beforeEach` 调用：初始化只允许一次，`resetAllStubs()` 会连同应用基础设施一起复位，
 * 因此每个用例都能重新装配自己的配置与 DB 句柄。
 */
export function initializeKnowledgeModuleConfig(overrides: Partial<KnowledgeModuleConfig> = {}): void {
  resetAllStubs();
  initializeTestApplicationInfrastructure({
    database: knowledgeDbProxy,
    moduleConfigs: { knowledge: createKnowledgeModuleConfig(overrides) },
  });
}

/**
 * 用例内改动模块配置。
 *
 * 基础设施持有的是初始化的整份配置（`initializeApplicationInfrastructure` 只允许一次），因此运行期
 * 调整走 `overrideModuleConfig()`——它是**整值替换**，这里按合并语义补齐其余字段：用例只想改超时
 * 不该顺带把之前设好的 key 清空。读取经 `getKnowledgeConfig()`，与生产路径同一次校验。
 */
export function stubKnowledgeConfig(overrides: Partial<KnowledgeModuleConfig>): void {
  overrideModuleConfig("knowledge", { ...getKnowledgeConfig(), ...overrides });
}
