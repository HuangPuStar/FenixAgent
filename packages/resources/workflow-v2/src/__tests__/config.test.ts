import { expect, test } from "bun:test";
import { loadDeclaredEnv } from "@fenix/platform-sdk";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { moduleManifest } from "../../fenix.module";
import { getWorkflowV2Config } from "../server/config";
import { createWorkflowV2ModuleConfig, initializeWorkflowV2ModuleConfig } from "../server/testing";

/**
 * 骨架（1A）的配置面契约测试。
 *
 * 两段彼此独立的口径：
 * 1. **声明侧**（`fenix.module.ts` 的 envDefinitions）——键集合、必填性与默认值必须与冻结 §2.2 逐项一致。
 *    它是启动期校验与部署模板（`.env.example` / `docker/main/.env.example`）的真相来源，改错不会在包内报错，只会在部署时才暴露；
 * 2. **读取侧**（`config.ts` 的 `getWorkflowV2Config()`）——宿主投影进来的形状经校验后才可用，白名单的
 *    字符串 → 数组归一只发生在这里。
 *
 * 用真实的 manifest 而不是 fixture 声明：默认值写在 manifest 里，用 fixture 等于把同一批字面量抄第二遍，
 * 抄错时测试与实现一起错。
 */

/**
 * 冻结 §2.2 的九枚键 + 4A/4B（2026-09-29）追加的三枚对账/限流旋钮 + 对外触发面（2026-10-09）追加的
 * 一枚限流旋钮；顺序即声明序（部署模板按它生成）。
 *
 * 后四枚尚未回写进冻结 §2.2（`docs/design/**` 由设计 owner 维护），落差登记在 `docs/arch/25-workflow-v2.md`
 * 与本次任务回报里。
 */
const DECLARED_KEYS = [
  "WORKFLOW_V2_UPSTREAM_BASE_URL",
  "WORKFLOW_CANVAS_UPSTREAM_URL",
  "WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL",
  "WORKFLOW_V2_PLATFORM_ACCOUNT_PASSWORD",
  "WORKFLOW_V2_TICKET_SECRET",
  "WORKFLOW_V2_IFRAME_CODE_TTL_SECONDS",
  "WORKFLOW_V2_IFRAME_TICKET_TTL_SECONDS",
  "WORKFLOW_V2_UPSTREAM_TIMEOUT_MS",
  "WORKFLOW_V2_NODE_WHITELIST",
  "WORKFLOW_V2_RECONCILE_INTERVAL_SECONDS",
  "WORKFLOW_V2_BFF_RATE_LIMIT_PER_MINUTE",
  "WORKFLOW_V2_SESSION_RATE_LIMIT_PER_MINUTE",
  "WORKFLOW_V2_API_RATE_LIMIT_PER_MINUTE",
] as const;

/** 无默认值的三枚必填键。 */
const REQUIRED_KEYS = [
  "WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL",
  "WORKFLOW_V2_PLATFORM_ACCOUNT_PASSWORD",
  "WORKFLOW_V2_TICKET_SECRET",
] as const;

/** 必填键的最小可用取值；测试不读进程环境，全部经入参注入。 */
const requiredInput: Record<string, string> = {
  WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL: "account@example.invalid",
  WORKFLOW_V2_PLATFORM_ACCOUNT_PASSWORD: "fixture-password",
  WORKFLOW_V2_TICKET_SECRET: "fixture-ticket-secret",
};

// 声明键是键 owner 的唯一表达：多一枚少一枚都说明冻结 §2.2（+ 4A/4B 追加的三枚）与本包脱节。
test("manifest 声明冻结 §2.2 与 4A/4B 追加的全部键", () => {
  expect(moduleManifest.envDefinitions.map((definition) => definition.key)).toEqual([...DECLARED_KEYS]);
  // 三枚密钥材料必须标 secret：preflight 与部署模板据此决定是否脱敏。
  const secretKeys = moduleManifest.envDefinitions
    .filter((definition) => definition.secret)
    .map((definition) => definition.key);
  expect(secretKeys).toEqual(["WORKFLOW_V2_PLATFORM_ACCOUNT_PASSWORD", "WORKFLOW_V2_TICKET_SECRET"]);
});

// 未配置的旋钮必须解析成冻结 §2.2 的默认值，而不是 undefined 传到消费方。
test("未配置的旋钮按声明默认值解析", () => {
  const env = loadDeclaredEnv(moduleManifest.envDefinitions, requiredInput);

  expect(env.WORKFLOW_V2_UPSTREAM_BASE_URL).toBe("http://127.0.0.1:18080");
  expect(env.WORKFLOW_CANVAS_UPSTREAM_URL).toBe("http://127.0.0.1:18080");
  expect(env.WORKFLOW_V2_IFRAME_CODE_TTL_SECONDS).toBe(60);
  expect(env.WORKFLOW_V2_IFRAME_TICKET_TTL_SECONDS).toBe(900);
  expect(env.WORKFLOW_V2_UPSTREAM_TIMEOUT_MS).toBe(10_000);
  // 许可集默认值是数字串（冻结 §5 更正后）：名称形式会被判定层忽略并回退默认集，不能作为声明值。
  expect(env.WORKFLOW_V2_NODE_WHITELIST).toBe("1,2,3,5,8,11,13,15,18,20,30,31,45,58");
  // 对账默认开启（5 分钟一轮）；限流阈值默认值必须与设计里的「远高于正常画布轮询」量级一致，
  // 对外触发面则相反——每次调用都可能产生一次真实运行，默认值取与票据端点同档的 60。
  expect(env.WORKFLOW_V2_RECONCILE_INTERVAL_SECONDS).toBe(300);
  expect(env.WORKFLOW_V2_BFF_RATE_LIMIT_PER_MINUTE).toBe(1200);
  expect(env.WORKFLOW_V2_SESSION_RATE_LIMIT_PER_MINUTE).toBe(60);
  expect(env.WORKFLOW_V2_API_RATE_LIMIT_PER_MINUTE).toBe(60);
});

// 必填键缺失必须在启动期失败（消息含键名，部署才知道该配哪个），且失败点与配置了哪些键无关。
test("三枚必填键缺失时逐个失败且消息含键名", () => {
  for (const key of REQUIRED_KEYS) {
    const input = Object.fromEntries(Object.entries(requiredInput).filter(([candidate]) => candidate !== key));
    expect(() => loadDeclaredEnv(moduleManifest.envDefinitions, input)).toThrow(key);
  }
});

// 数值旋钮经声明 schema 归一：部署面给字符串（env 只能是字符串）也要落成 number。
test("数值旋钮接受字符串并归一为数字", () => {
  const env = loadDeclaredEnv(moduleManifest.envDefinitions, {
    ...requiredInput,
    WORKFLOW_V2_IFRAME_CODE_TTL_SECONDS: "120",
    WORKFLOW_V2_UPSTREAM_TIMEOUT_MS: "5000",
  });

  expect(env.WORKFLOW_V2_IFRAME_CODE_TTL_SECONDS).toBe(120);
  expect(env.WORKFLOW_V2_UPSTREAM_TIMEOUT_MS).toBe(5_000);
});

// 读取侧：宿主投影的形状经校验后才可用，白名单的「逗号分隔串 → 类型名数组」只在这一步发生。
test("模块配置按声明形状读取并把白名单拆成数组", () => {
  const config = createWorkflowV2ModuleConfig({ nodeWhitelist: "start, llm ,,http," });
  initializeWorkflowV2ModuleConfig(config);

  const resolved = getWorkflowV2Config();
  expect(resolved.upstreamBaseUrl).toBe(config.upstreamBaseUrl);
  expect(resolved.accountEmail).toBe(config.accountEmail);
  expect(resolved.accountPassword).toBe(config.accountPassword);
  expect(resolved.codeTtlSeconds).toBe(60);
  expect(resolved.nodeWhitelist).toEqual(["start", "llm", "http"]);
});

// 宿主投影漏字段时读配置即失败：错误必须给出字段路径，便于定位到 module-configs.ts 的那一行。
test("配置缺字段时拒绝读取并报字段路径", () => {
  resetAllStubs();
  initializeTestApplicationInfrastructure({
    moduleConfigs: { "workflow-v2": { ...createWorkflowV2ModuleConfig(), codeTtlSeconds: undefined } },
  });

  expect(() => getWorkflowV2Config()).toThrow("codeTtlSeconds");
});

// 字段类型不符同样在读取期失败：`codeTtlSeconds: 0` 过不了 positive()，不会被当成「0 秒 TTL」用下去。
test("配置字段取值非法时拒绝读取", () => {
  initializeWorkflowV2ModuleConfig({ codeTtlSeconds: 0, upstreamTimeoutMs: -1 });

  expect(() => getWorkflowV2Config()).toThrow("codeTtlSeconds");
});

// 密钥材料不得出现在错误信息里：失败只报路径与错误码，值一律不回显。
test("配置校验失败不回显敏感值", () => {
  const marker = "marker-4f7c-not-a-secret";
  resetAllStubs();
  initializeTestApplicationInfrastructure({
    moduleConfigs: { "workflow-v2": { ...createWorkflowV2ModuleConfig(), accountPassword: { leaked: marker } } },
  });

  let message = "";
  try {
    getWorkflowV2Config();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("accountPassword");
  expect(message).not.toContain(marker);
});
