import { expect, test } from "bun:test";
import type { EnvDefinition, ModuleManifest } from "@fenix/platform-sdk";
import { z } from "zod/v4";
import { generatedModuleManifests } from "../../../generated/module-registry";
import { loadAssemblyProfile } from "../assembly-config";
import { resolveAssemblyEnv } from "../bootstrap/assembly-env";
import { parseEnv } from "../env";

/**
 * 该测试锁定 1.7 的模块声明回流通道：模块声明的 envDefinitions 必须与宿主 schema 的字段汇入同一个
 * `env` 对象，宿主的 `config` / `buildModuleConfigs` 才读得到。在此之前 `main.ts` 用 `loadServerEnv([])`，
 * 模块声明只到模块工厂，宿主侧永远看不到，补声明等于空转。
 *
 * 1.7 C 块迁出 53 个宿主键后，本文件同时承担**迁出键的校验面**：这些键的 schema 不再在
 * `apps/server/src/env.ts`，默认值与校验规则改由各模块 manifest 给出——`env-validation.test.ts` 里原先
 * 针对它们的断言（默认值、coerce 归一、非法值拒绝）随之下沉到这里，经真实清单验证。移到本文件而不是
 * 留在原处的原因：那里用的是 `validateEnv()`（只跑宿主 schema），迁出键在那里永远取不到。
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

/**
 * 枚举宿主 `env.ts` schema 声明的**全部**键。
 *
 * 为什么不写死键名清单：清单会随 `env.ts` 增删而静默漂移，而这条枚举的失效方式是「漏报冲突」——
 * 漂移方向恰好不可见。`env.ts` 只导出 `parseEnv` / `Env` 类型、没有导出 schema 对象，所以改用
 * 「探测输入」让 schema 自己报出键集合：zod 解析对象时逐键读 `input[key]`，用一个记录访问的 Proxy
 * 当输入即可收齐全部键。
 *
 * 必填项（`DATABASE_URL` / `RCS_API_KEYS`）缺失会让 `parseEnv` 抛 ZodError——本函数只关心「读过哪些键」，
 * 异常直接吞掉；zod 逐键收集 issue，不会因某个键失败就跳过后续键（若未来 zod 改成短路，调用方的
 * 「物化键包含于枚举结果」护栏会立即失败，不会静默漏报）。
 */
function readHostEnvKeys(): Set<string> {
  const keys = new Set<string>();
  const probe = new Proxy({} as Record<string, unknown>, {
    get: (_target, property) => {
      if (typeof property === "string") keys.add(property);
    },
  });
  try {
    parseEnv(probe);
  } catch {
    // 探测输入缺必填项必然失败；键集合已在 get 陷阱里收齐。
  }
  return keys;
}

/** 真实清单里各模块声明键的并集。 */
function declaredKeys(): string[] {
  const manifests: readonly ModuleManifest[] = generatedModuleManifests;
  return manifests.flatMap((manifest) => (manifest.envDefinitions ?? []).map((envDefinition) => envDefinition.key));
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

// 真实清单下宿主 schema 的每个键都必须是宿主 schema 的值——模块声明只做叠加，不得覆盖任何一个宿主键。
// 覆盖会静默改掉启动行为，而 `assertNoHostKeyOverride` 只拦「同名声明」这一条路径，拦不住实现层面的改序。
test("真实清单不改变宿主 schema 的任何键值", async () => {
  const { env } = await resolveAssemblyEnv({ input: baseInput });

  const hostEnv = parseEnv(baseInput);
  const changed = Object.entries(hostEnv).filter(([key, value]) => env[key] !== value);
  expect(changed).toEqual([]);
});

// profile 由本入口解析后透传给装配层，两处拿到必须是同一份，否则装配层会再读一次文件。
test("解析出的 profile 与 loadAssemblyProfile 一致", async () => {
  const { profile } = await resolveAssemblyEnv({ input: baseInput });

  expect(profile).toEqual(await loadAssemblyProfile());
});

// 模块声明宿主仍持有的键时启动失败。`RCS_PORT` 是今天的真实宿主自有键（HTTP/WebSocket 段的宿主运行参数，
// 不与任何模块声明重叠）；迁出前这条用 `WORKSPACE_ROOT` 验证，它 1.7 C 块已归 agent-runtime 声明。
// 「同名即失败」是迁移的硬约束：某键的声明搬进模块时忘了同批删除宿主行，启动即失败而不是静默覆盖。
test("模块声明宿主已有的键时启动失败", async () => {
  await expect(
    resolveAssemblyEnv({
      manifests: withEnvDefinitions("agent-runtime", [definition("RCS_PORT")]),
      input: { ...baseInput, RCS_PORT: "3000" },
    }),
  ).rejects.toThrow("同时由宿主 env schema 与模块声明提供");
});

// 「同名即失败」今天只在真的启动一次（`assertNoHostKeyOverride`）时才撞得上：校验发生在 `parseEnv`
// 之后，服务一起就退出。本条把同一冲突提前到 precheck——迁移某个键时忘了同批删除宿主声明，
// 会在门禁而不是部署时失败。
test("模块声明的键与宿主 env.ts schema 的键不相交", () => {
  const hostKeys = readHostEnvKeys();

  // 护栏：枚举必须真的读到了宿主 schema。物化出来的键（有默认值或已提供）全部来自 schema，
  // 探测结果没覆盖它们说明枚举机制失效，此时下面的交集判定会静默漏报。
  const materialized = Object.keys(parseEnv(baseInput));
  expect(materialized.filter((key) => !hostKeys.has(key))).toEqual([]);

  // 冲突键要在失败信息里原样列出：它们正是「声明方已就位、宿主声明还没删」的那批键。
  const collisions = declaredKeys().filter((key) => hostKeys.has(key));
  expect(collisions).toEqual([]);
});

// 迁出键的默认值仍由声明方给出（原先断言在 env-validation.test.ts 的「可选变量使用默认值」里）。
// 这几个键覆盖三类形状：字符串默认值、数字 default、以及 optional 无默认值（取到 undefined）。
test("声明键未设置时使用模块声明的默认值", async () => {
  const { env } = await resolveAssemblyEnv({ input: baseInput });

  expect(env.SKILL_DIR).toBe("./data/skills");
  expect(env.WORKFLOW_TOOLS_DIR).toBe("./tools");
  expect(env.RCS_TRUSTED_ORIGINS).toBe("");
  expect(env.APP_HIDDEN_SIDEBAR_TABS).toBe("");
  expect(env.RCS_USER_AGENT_MAX_CONCURRENCY).toBe(10);
  expect(env.YJS_MAX_CLIENTS).toBe(200);
  expect(env.WORKSPACE_ROOT).toBeUndefined();
});

// 显式值经声明方的 schema 归一（`z.coerce`），与迁移前宿主 schema 的行为逐值相同
// （原先断言在 env-validation.test.ts 的两条「合法值时通过校验」）。
test("声明键的显式字符串值经 schema 归一为数字", async () => {
  const { env } = await resolveAssemblyEnv({
    input: { ...baseInput, RCS_AGENT_MAX_CONCURRENCY: "3", RCS_USER_AGENT_MAX_CONCURRENCY: "2" },
  });

  expect(env.RCS_AGENT_MAX_CONCURRENCY).toBe(3);
  expect(env.RCS_USER_AGENT_MAX_CONCURRENCY).toBe(2);
});

// 非法值在启动期由声明方的 schema 拒绝——校验面随声明一起迁出，不能出现「声明在模块、校验无人执行」。
// 断言错误文案含键名，确保失败的是**这个键**而不是别的键先炸（与原先 env-validation 的两条同类断言同口径）。
test("声明键的非法值在启动期被拒绝", async () => {
  await expect(resolveAssemblyEnv({ input: { ...baseInput, RCS_ACP_IDLE_TIMEOUT_SECONDS: "0" } })).rejects.toThrow(
    /RCS_ACP_IDLE_TIMEOUT_SECONDS/,
  );
  await expect(
    resolveAssemblyEnv({ input: { ...baseInput, RCS_SCHEDULED_AGENT_MAX_CONCURRENCY: "0" } }),
  ).rejects.toThrow(/RCS_SCHEDULED_AGENT_MAX_CONCURRENCY/);
});
