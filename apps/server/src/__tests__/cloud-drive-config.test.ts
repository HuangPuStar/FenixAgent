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
 * `CLOUDRIVE_BASE_URL` 导致模块始终「未配置」；本用例锁住四个键的拼写与透传。
 */
test("cloud-drive 的四个声明键投影到模块配置", () => {
  const manifests: readonly ModuleManifest[] = generatedModuleManifests;
  const definitions = manifests.flatMap((manifest) => manifest.envDefinitions ?? []);
  const env = loadServerEnv(definitions, {
    DATABASE_URL: "postgres://127.0.0.1:5432/fenix",
    CLOUDDRIVE_BASE_URL: "http://127.0.0.1:8080",
    CLOUDDRIVE_MASTER_KEY: "test-master-key",
    CLOUDDRIVE_KEY_ID: "demo",
    CLOUDDRIVE_TIMEOUT_MS: "180000",
  });

  applyEnv(env);
  const configs = buildModuleConfigs(env, config) as Record<string, unknown>;

  expect(configs["cloud-drive"]).toEqual({
    baseUrl: "http://127.0.0.1:8080",
    masterKey: "test-master-key",
    keyId: "demo",
    timeoutMs: 180000,
  });
});
