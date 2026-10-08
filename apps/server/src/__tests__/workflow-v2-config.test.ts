import { expect, test } from "bun:test";
import { moduleManifest } from "@fenix/resource-workflow-v2/module";
import type { WorkflowV2ModuleConfigInput } from "@fenix/resource-workflow-v2/server";
import { buildModuleConfigs } from "@server/bootstrap/module-configs";
import { applyEnv, config } from "@server/config";
import { loadServerEnv } from "@server/env-loader";

/**
 * workflow-v2「部署值 → 模块配置」的接线契约。
 *
 * 这条缝**两端都是无类型的**：宿主投影出的是 `Record<string, unknown>`，包内用 `getModuleConfig("workflow-v2")`
 * 取回来再自行校验。字段名写错、键名写错都不会有报错——只表现为请求期读不到配置。因此这里逐字段断言投影
 * 结果，并把期望值标注成包内的 `WorkflowV2ModuleConfigInput`：包内字段改名会在 typecheck 期失败。
 *
 * 环境不经 `resolveAssemblyEnv` 构造：本用例只覆盖「本模块声明键 → 投影块」这一段，直接经宿主唯一的
 * 环境加载边界 `loadServerEnv()` 注入本模块的声明即可——校验、默认值与 `coerce` 走的是同一条生产路径。
 * 「真实 profile 把启用模块的声明聚合进同一个 env」这一段由 `assembly-env.test.ts` 覆盖，不在这里重复。
 */

/** 宿主 schema 的两个必填项；其余键由模块声明提供默认值。 */
const baseInput = {
  DATABASE_URL: "postgres://127.0.0.1:5432/fenix",
  RCS_API_KEYS: "test-api-keys",
};

/** 三枚必填键的 fixture 取值（占位值，不是任何环境的真实凭据）。 */
const requiredInput = {
  WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL: "workflow-v2-fixture@example.invalid",
  WORKFLOW_V2_PLATFORM_ACCOUNT_PASSWORD: "fixture-password",
  WORKFLOW_V2_TICKET_SECRET: "fixture-ticket-secret",
};

/** 走宿主环境加载与投影路径，取出 `workflow-v2` 那一块。 */
function projectWorkflowV2Config(input: Record<string, unknown>): unknown {
  const env = loadServerEnv(moduleManifest.envDefinitions, { ...baseInput, ...input });
  // `buildModuleConfigs` 读的是宿主 config 单例，必须先 applyEnv；调用点与 main.ts 的启动顺序一致。
  applyEnv(env);
  return buildModuleConfigs(env, config)["workflow-v2"];
}

// 未配置的旋钮按声明默认值投影（与冻结 §2.2 一致），必填键原样透传——包内读取时不再补默认值。
test("未配置的旋钮按声明默认值投影", () => {
  const expected: WorkflowV2ModuleConfigInput = {
    upstreamBaseUrl: "http://127.0.0.1:18080",
    canvasUpstreamUrl: "http://127.0.0.1:18080",
    accountEmail: requiredInput.WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL,
    accountPassword: requiredInput.WORKFLOW_V2_PLATFORM_ACCOUNT_PASSWORD,
    ticketSecret: requiredInput.WORKFLOW_V2_TICKET_SECRET,
    codeTtlSeconds: 60,
    ticketTtlSeconds: 900,
    upstreamTimeoutMs: 10_000,
    nodeWhitelist: "1,2,3,5,8,11,13,15,18,20,30,31,45,58",
    // 4A/4B（2026-09-29）追加的三枚旋钮：默认值必须经同一条投影路径到达包内。
    reconcileIntervalSeconds: 300,
    bffRateLimitPerMinute: 1200,
    sessionRateLimitPerMinute: 60,
  };

  expect(projectWorkflowV2Config(requiredInput)).toEqual(expected);
});

// 显式配置逐字段透传：字符串数字经声明的 z.coerce 归一为数字，白名单保持声明面的逗号分隔串
// （拆成数组是包内 `getWorkflowV2Config()` 的职责，投影层不解释领域形状）。
test("显式配置逐字段透传", () => {
  const expected: WorkflowV2ModuleConfigInput = {
    upstreamBaseUrl: "http://upstream.internal:8888",
    canvasUpstreamUrl: "http://canvas.internal:8888",
    accountEmail: "platform@example.invalid",
    accountPassword: "explicit-password",
    ticketSecret: "explicit-ticket-secret",
    codeTtlSeconds: 30,
    ticketTtlSeconds: 120,
    upstreamTimeoutMs: 3000,
    nodeWhitelist: "start,end,llm",
    reconcileIntervalSeconds: 300,
    bffRateLimitPerMinute: 1200,
    sessionRateLimitPerMinute: 60,
  };

  expect(
    projectWorkflowV2Config({
      WORKFLOW_V2_UPSTREAM_BASE_URL: expected.upstreamBaseUrl,
      WORKFLOW_CANVAS_UPSTREAM_URL: expected.canvasUpstreamUrl,
      WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL: expected.accountEmail,
      WORKFLOW_V2_PLATFORM_ACCOUNT_PASSWORD: expected.accountPassword,
      WORKFLOW_V2_TICKET_SECRET: expected.ticketSecret,
      WORKFLOW_V2_IFRAME_CODE_TTL_SECONDS: String(expected.codeTtlSeconds),
      WORKFLOW_V2_IFRAME_TICKET_TTL_SECONDS: String(expected.ticketTtlSeconds),
      WORKFLOW_V2_UPSTREAM_TIMEOUT_MS: String(expected.upstreamTimeoutMs),
      WORKFLOW_V2_NODE_WHITELIST: expected.nodeWhitelist,
    }),
  ).toEqual(expected);
});

// 三枚追加旋钮显式配置时同样逐字段透传（含 `0`：对账禁用是合法取值，不能被默认值回填抹掉）。
test("对账与限流旋钮显式配置时透传（含禁用值 0）", () => {
  const projected = projectWorkflowV2Config({
    ...requiredInput,
    WORKFLOW_V2_RECONCILE_INTERVAL_SECONDS: "0",
    WORKFLOW_V2_BFF_RATE_LIMIT_PER_MINUTE: "600",
    WORKFLOW_V2_SESSION_RATE_LIMIT_PER_MINUTE: "30",
  }) as WorkflowV2ModuleConfigInput;

  expect(projected.reconcileIntervalSeconds).toBe(0);
  expect(projected.bffRateLimitPerMinute).toBe(600);
  expect(projected.sessionRateLimitPerMinute).toBe(30);
});
