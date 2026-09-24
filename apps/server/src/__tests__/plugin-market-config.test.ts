import { describe, expect, test } from "bun:test";
import type { PluginMarketModuleConfig } from "@fenix/resource-plugin-market/server";
import { resolveAssemblyEnv } from "@server/bootstrap/assembly-env";
import { buildModuleConfigs } from "@server/bootstrap/module-configs";
import { applyEnv, config } from "@server/config";

/**
 * 插件市场「部署值 → 模块配置」的接线契约。
 *
 * 这条缝**两端都是无类型的**：宿主投影出的是 `Record<string, unknown>`，包内用 `getModuleConfig()`
 * 取回来再自行校验。字段名写错、模块 ID 写错、声明键写错，都不会有任何报错——只表现为请求期读不到配置
 * （发布路径直接失败，浏览路径静默用不上源地址）。因此这里逐字段断言投影结果，并把期望值标注成包内的
 * `PluginMarketModuleConfig`：包内字段改名会在 typecheck 期失败，而不是等到运行时才发现。
 *
 * 取值经 `resolveAssemblyEnv`（真实 profile + 真实清单）走完整启动路径，因此声明侧的默认值、空串归一与
 * `coerce` 都在本用例的覆盖范围内，不需要另一条用例单独测声明形状。
 */

/** 宿主 schema 的两个必填项；其余键由模块声明提供默认值。 */
const baseInput = {
  DATABASE_URL: "postgres://127.0.0.1:5432/fenix",
  RCS_API_KEYS: "test-api-keys",
};

/** 走完整装配路径并把投影结果取出来。 */
async function projectPluginMarketConfig(input: Record<string, unknown>): Promise<unknown> {
  const { env } = await resolveAssemblyEnv({ input: { ...baseInput, ...input } });
  // `buildModuleConfigs` 读的是宿主 config 单例，必须先 applyEnv；调用点与 main.ts 的启动顺序一致。
  applyEnv(env);
  return buildModuleConfigs(env, config)["plugin-market"];
}

describe("plugin-market module config projection", () => {
  // 未配置私有源时，源地址与凭据投影为 null 而不是 undefined：包内契约用 `.nullable()` 表达「未配置」，
  // 浏览器据此得到「部署未配置」这一明确提示，而不是一个含义含混的空值。超时/上限/来源标识走声明默认值。
  test("projects null source values and declared defaults when unconfigured", async () => {
    const expected: PluginMarketModuleConfig = {
      sourceId: "npm",
      registryUrl: null,
      registryToken: null,
      registryTimeoutMs: 8000,
      registryMaxBytes: 4194304,
    };

    expect(await projectPluginMarketConfig({})).toEqual(expected);
  });

  // 显式配置时逐字段透传，且字符串数字经声明的 z.coerce 归一为数字——投影层不做第二份类型转换。
  test("passes configured values through unchanged", async () => {
    const expected: PluginMarketModuleConfig = {
      sourceId: "npm-internal",
      registryUrl: "http://registry.internal:4873/",
      registryToken: "registry-token",
      registryTimeoutMs: 1500,
      registryMaxBytes: 1024,
    };

    expect(
      await projectPluginMarketConfig({
        PLUGIN_MARKET_REGISTRY_URL: expected.registryUrl,
        PLUGIN_MARKET_REGISTRY_TOKEN: expected.registryToken,
        PLUGIN_MARKET_REGISTRY_TIMEOUT_MS: "1500",
        PLUGIN_MARKET_REGISTRY_MAX_BYTES: "1024",
        PLUGIN_MARKET_SOURCE_ID: expected.sourceId,
      }),
    ).toEqual(expected);
  });

  // 空串等同未配置：.env 未设置时 docker-compose 的 `${VAR:-}` 透传的是空串，声明侧的 z.preprocess 把它
  // 归一为 undefined。不归一的话空串会撞上包内配置的 min(1)，把「没配私有源」变成启动期拒绝启动。
  test("treats empty strings as unconfigured", async () => {
    expect(
      await projectPluginMarketConfig({ PLUGIN_MARKET_REGISTRY_URL: "", PLUGIN_MARKET_REGISTRY_TOKEN: "" }),
    ).toEqual({
      sourceId: "npm",
      registryUrl: null,
      registryToken: null,
      registryTimeoutMs: 8000,
      registryMaxBytes: 4194304,
    } satisfies PluginMarketModuleConfig);
  });
});
