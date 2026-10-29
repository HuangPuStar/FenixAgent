import { expect, test } from "bun:test";
import type { ModuleManifest } from "@fenix/platform-sdk";
import { generatedModuleManifests } from "../../../generated/module-registry";
import { buildModuleConfigs } from "../bootstrap/module-configs";
import { applyEnv, config } from "../config";
import { loadServerEnv } from "../env-loader";

/**
 * cloud-drive「部署变量 → 模块配置」的接线契约。
 *
 * 这条缝两端都没有类型约束：宿主投影出的是 `Record<string, unknown>`，包内用
 * `getModuleConfig("cloud-drive")` 读。联调时曾因宿主把 `CLOUDDRIVE_BASE_URL` 误写成
 * `CLOUDRIVE_BASE_URL` 导致模块始终「未配置」；本用例锁住九个键的拼写、默认值与透传。
 */
test("cloud-drive 的九个声明键投影到模块配置", () => {
  const manifests: readonly ModuleManifest[] = generatedModuleManifests;
  const definitions = manifests.flatMap((manifest) => manifest.envDefinitions ?? []);
  const env = loadServerEnv(definitions, {
    DATABASE_URL: "postgres://127.0.0.1:5432/fenix",
    CLOUDDRIVE_BASE_URL: "http://127.0.0.1:8080",
    CLOUDDRIVE_MASTER_KEY: "test-master-key",
    CLOUDDRIVE_KEY_ID: "demo",
    CLOUDDRIVE_TIMEOUT_MS: "180000",
    CLOUDDRIVE_MCP_TOKEN_SECRET: "test-mcp-secret",
    CLOUDDRIVE_MCP_TOKEN_TTL_SECONDS: "7200",
    CLOUDDRIVE_MCP_LAUNCH_TTL_SECONDS: "90000",
    CLOUDDRIVE_MCP_SCOPE: "write",
    CLOUDDRIVE_MCP_TIMEOUT_MS: "9000",
  });

  applyEnv(env);
  const configs = buildModuleConfigs(env, config) as Record<string, unknown>;

  expect(configs["cloud-drive"]).toEqual({
    baseUrl: "http://127.0.0.1:8080",
    masterKey: "test-master-key",
    keyId: "demo",
    timeoutMs: 180000,
    mcpTokenSecret: "test-mcp-secret",
    mcpTokenTtlSeconds: 7200,
    mcpLaunchTtlSeconds: 90000,
    mcpScope: "write",
    mcpTimeoutMs: 9000,
  });
});

// 未配置 MCP 相关键时按声明默认值投影：scope 默认只读，两个 TTL 与读超时有固定默认。
test("未设置的 MCP 键投影为声明默认值", () => {
  const manifests: readonly ModuleManifest[] = generatedModuleManifests;
  const definitions = manifests.flatMap((manifest) => manifest.envDefinitions ?? []);
  const env = loadServerEnv(definitions, {
    DATABASE_URL: "postgres://127.0.0.1:5432/fenix",
  });

  applyEnv(env);
  const configs = buildModuleConfigs(env, config) as Record<string, Record<string, unknown>>;
  const cloudDrive = configs["cloud-drive"];

  expect(cloudDrive?.mcpTokenSecret).toBeUndefined();
  expect(cloudDrive?.mcpTokenTtlSeconds).toBe(3600);
  expect(cloudDrive?.mcpLaunchTtlSeconds).toBe(86400);
  expect(cloudDrive?.mcpScope).toBe("read");
  expect(cloudDrive?.mcpTimeoutMs).toBe(15000);
});
