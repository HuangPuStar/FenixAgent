import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import type { WorkflowV2ModuleConfigInput } from "./config";

/**
 * Workflow V2 资源包的测试装配入口；不得从生产 `./server` 入口导出。
 *
 * 只放两件事：模块配置的 fixture 构造与「按 fixture 初始化应用基础设施」。放在这里而不是各用例里，
 * 是为了让宿主的 test-utils、包内后续任务（1B/1C/2B/2C）的用例共用同一份字段清单——各自手抄一份
 * 「必填字段 + 缺省值」时，漏字段在两侧都不可见（同 `@fenix/resource-skill` 的 testing.ts 口径）。
 */

/** fixture 里的账号邮箱：明显不可投递的保留域，避免被误当成可用的部署值。 */
const TEST_ACCOUNT_EMAIL = "workflow-v2-test@example.invalid";

/**
 * fixture 里的节点许可集：与冻结 §5 的默认值逐字一致，保持测试与部署默认同形。
 *
 * 契约是 fail-closed 许可集，因此这里也必须是数字串——名称形式会让判定层解析为空并回退默认集，
 * 相邻用例会因此在不自知的情况下测到「默认集」而不是 fixture。
 */
const TEST_NODE_WHITELIST = "1,2,3,5,8,11,13,15,18,20,30,31,45,58";

/**
 * fixture 里的对账周期：`0` = 禁用。
 *
 * 用例必须显式需要才启动对账（`overrides` 里给正数）：它会在装配时排上定时器并打上游，默认开着的 fixture
 * 会让「模块装配」这类用例静默产生后台任务。
 */
const TEST_RECONCILE_INTERVAL_SECONDS = 0;

/** fixture 里的限流阈值：与 manifest 默认值一致（用例要放宽/收紧时经 overrides 覆盖）。 */
const TEST_BFF_RATE_LIMIT_PER_MINUTE = 1200;
const TEST_SESSION_RATE_LIMIT_PER_MINUTE = 60;
const TEST_API_RATE_LIMIT_PER_MINUTE = 60;

/**
 * 构造一份字段齐全的模块配置（写入形状）。
 *
 * 两处密钥材料（账号密码、票据签名密钥）**在运行期生成、不落源码**：它们是 fixture 而非部署值，
 * 写死一个看起来像密码的字面量会让安全扫描与人工评审都要重新判断一次「这是不是真凭据」。
 */
export function createWorkflowV2ModuleConfig(
  overrides: Partial<WorkflowV2ModuleConfigInput> = {},
): WorkflowV2ModuleConfigInput {
  return {
    upstreamBaseUrl: "http://127.0.0.1:18080",
    canvasUpstreamUrl: "http://127.0.0.1:18080",
    accountEmail: TEST_ACCOUNT_EMAIL,
    accountPassword: crypto.randomUUID(),
    ticketSecret: crypto.randomUUID(),
    codeTtlSeconds: 60,
    ticketTtlSeconds: 900,
    upstreamTimeoutMs: 10_000,
    nodeWhitelist: TEST_NODE_WHITELIST,
    reconcileIntervalSeconds: TEST_RECONCILE_INTERVAL_SECONDS,
    bffRateLimitPerMinute: TEST_BFF_RATE_LIMIT_PER_MINUTE,
    sessionRateLimitPerMinute: TEST_SESSION_RATE_LIMIT_PER_MINUTE,
    apiRateLimitPerMinute: TEST_API_RATE_LIMIT_PER_MINUTE,
    ...overrides,
  };
}

/**
 * 复位全部替身后以给定配置初始化应用基础设施。
 *
 * 必须经 `initializeTestApplicationInfrastructure` 走生产读取路径（`getModuleConfig("workflow-v2")`），
 * 而不是给模块留测试专用的配置分支；初始化只允许一次，故先复位。
 */
export function initializeWorkflowV2ModuleConfig(overrides: Partial<WorkflowV2ModuleConfigInput> = {}): void {
  resetAllStubs();
  initializeTestApplicationInfrastructure({
    moduleConfigs: { "workflow-v2": createWorkflowV2ModuleConfig(overrides) },
  });
}
