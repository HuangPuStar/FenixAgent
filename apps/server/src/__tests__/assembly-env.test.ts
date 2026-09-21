import { expect, test } from "bun:test";
import type { EnvDefinition, ModuleManifest } from "@fenix/platform-sdk";
import { z } from "zod/v4";
import { generatedModuleManifests } from "../../../generated/module-registry";
import { loadAssemblyProfile } from "../assembly-config";
import { resolveAssemblyEnv } from "../bootstrap/assembly-env";
import { loadServerEnv } from "../env-loader";

/**
 * 该测试锁定 1.7「批 0」的回流通道：模块声明的 envDefinitions 必须与宿主 schema 的字段汇入同一个
 * `env` 对象，宿主的 `config` / `buildModuleConfigs` 才读得到。在此之前 `main.ts` 用 `loadServerEnv([])`，
 * 模块声明只到模块工厂，宿主侧永远看不到，补声明等于空转。
 *
 * fixture 用真实 ce.json profile（`resolveAssemblyEnv` 只接受 profilePath），因此 manifests 必须是
 * 真实的完整清单；需要注入声明时按模块 ID 替换其中一个。
 */

/** 宿主 schema 的两个必填项；测试不读进程环境，全部经 `input` 注入。 */
const baseInput = {
  DATABASE_URL: "postgres://127.0.0.1:5432/fenix",
  RCS_API_KEYS: "test-api-keys",
};

/** 把某个模块的 fixture 声明替换进真实清单，其余模块原样保留。 */
function withEnvDefinitions(moduleId: string, envDefinitions: readonly EnvDefinition[]): readonly ModuleManifest[] {
  const manifests: readonly ModuleManifest[] = generatedModuleManifests.map((manifest) =>
    manifest.id === moduleId ? { ...manifest, envDefinitions } : manifest,
  );
  return manifests;
}

/** 构造一条与宿主声明同形的 fixture 环境变量声明。 */
function definition(key: string): EnvDefinition {
  return {
    moduleId: "agent-runtime",
    key,
    schema: z.string().min(1),
    secret: false,
    restartRequired: false,
    description: "测试用声明",
  };
}

// 模块声明的键必须与宿主 schema 的字段出现在同一个 env 对象里，否则 moduleConfigs 读不到。
test("模块声明的 env 随宿主字段一起进入 env", async () => {
  const { env } = await resolveAssemblyEnv({
    manifests: withEnvDefinitions("agent-runtime", [definition("RCS_AGENT_RUNTIME_PROBE_URL")]),
    input: { ...baseInput, RCS_AGENT_RUNTIME_PROBE_URL: "http://127.0.0.1:1/probe" },
  });

  expect(env.RCS_AGENT_RUNTIME_PROBE_URL).toBe("http://127.0.0.1:1/probe");
  // 宿主 schema 的字段不受影响：回流是叠加，不是替换。
  expect(env.DATABASE_URL).toBe(baseInput.DATABASE_URL);
});

// 17 个模块当前零声明，批 0 必须做到逐键、逐值等价，否则就是顺手改了启动行为。
test("无模块声明时 env 与 loadServerEnv([]) 逐键相同", async () => {
  const { env } = await resolveAssemblyEnv({ input: baseInput });

  expect(env).toEqual(loadServerEnv([], baseInput));
});

// profile 由本入口解析后透传给装配层，两处拿到必须是同一份，否则装配层会再读一次文件。
test("解析出的 profile 与 loadAssemblyProfile 一致", async () => {
  const { profile } = await resolveAssemblyEnv({ input: baseInput });

  expect(profile).toEqual(await loadAssemblyProfile());
});

// 同一个变量两处声明会让「谁生效」取决于求值顺序，必须在启动期失败而不是静默覆盖。
// `WORKSPACE_ROOT` 是这条口径的真实迁移目标：它今天由宿主 `env.ts` 声明，批 1 要交给 agent-runtime
// 声明时必须**同批**从宿主 schema 删除，否则启动即失败。
test("模块声明宿主已有的键时启动失败", async () => {
  await expect(
    resolveAssemblyEnv({
      manifests: withEnvDefinitions("agent-runtime", [definition("WORKSPACE_ROOT")]),
      input: { ...baseInput, WORKSPACE_ROOT: "/srv/workspaces" },
    }),
  ).rejects.toThrow("同时由宿主 env schema 与模块声明提供");
});
