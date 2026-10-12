import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type GitModuleConfig, getGitService, resetGitModuleForTesting } from "@fenix/git/server";
import { type AssemblyProfile, createModuleRegistry, type ModuleManifest } from "@fenix/platform-sdk";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { resolveAssemblyEnv } from "@server/bootstrap/assembly-env";
import { buildModuleConfigs } from "@server/bootstrap/module-configs";
import { config } from "@server/config";
import { generatedModuleManifests } from "../../../generated/module-registry";
import { CE_ASSEMBLY_PROFILE_PATH, loadAssemblyProfile } from "../assembly-config";
import { bootstrapServerAssembly, type ServerAssemblyBootstrapOptions } from "../bootstrap";
import { loadServerEnv } from "../env-loader";

/**
 * 公共 Git 在宿主装配面上的接线（T01 单元 D + F2）。
 *
 * 用例用**真实 profile 文件 + 真实生成的 registry + 真实 git manifest**，只把其余模块的工厂替换成最小
 * fixture：真实运行面在装配期会绑定进程级单例（实测第二次装配 sandbox 即报
 * `MachineSandboxRoutePort has already been bound`），而 `bun test` 的多个测试文件共享进程——真跑一次就会
 * 让同批的 `route-contributions.test.ts` 也撞上「已绑定/已初始化」。全量真实装配由该文件覆盖，profile 与
 * registry 的解析契约由 `module-assembly.test.ts` 覆盖；本文件聚焦 git 自己的三件事：启用面（ce.json 不含、
 * ce-git.json 只多一个）、失败面（未配置时 create 阶段失败且不回显凭据）、释放面（dispose 可重复调用）。
 *
 * 用例**不读进程环境**（`loadEnv` 全部经输入注入），也不触网：git 的适配器在构造期只建配置与信号量，
 * 首次调用才连 Forgejo，因此「装配成功」本身就是「没有出站请求」的证据。
 */

/** 启动面所需的必填项：两枚宿主键 + workflow-v2 的三枚无默认值声明（真实 profile 会聚合它们）。 */
const BASE_INPUT = {
  DATABASE_URL: "postgres://127.0.0.1:5432/fenix",
  RCS_API_KEYS: "test-api-keys",
  WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL: "workflow-v2@example.test",
  WORKFLOW_V2_PLATFORM_ACCOUNT_PASSWORD: "test-password",
  WORKFLOW_V2_TICKET_SECRET: "test-ticket-secret",
} as const;

/** 启用 git 的发布组合：与 `ce.json` 同目录，路径由默认入口推导而不是硬编码仓库根。 */
const GIT_ASSEMBLY_PROFILE_PATH = join(dirname(CE_ASSEMBLY_PROFILE_PATH), "ce-git.json");

/** 合成凭据：只用于断言错误消息不回显凭据值，不指向任何真实实例。 */
const PROVISION_TOKEN = "provision-token-sentinel";
const SERVICE_TOKEN = "service-token-sentinel";

type LoadEnv = NonNullable<ServerAssemblyBootstrapOptions["loadEnv"]>;

/** 全量注入的环境加载器：不从 process.env 取值，用例因此不受本机 .env 影响。 */
function loadEnvFrom(input: Readonly<Record<string, unknown>>): LoadEnv {
  return (definitions) => loadServerEnv(definitions, input);
}

/** 取回装配失败的错误；成功返回即断言失败（比 `rejects.toThrow` 更便于检查消息内容）。 */
async function failureOf(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("期望装配失败，但成功了");
}

/**
 * 按真实 profile 的解析结果构造「最小工厂」清单：git 用真实 manifest，其余模块的工厂只记录调用顺序。
 *
 * git manifest 即使不在该 profile 的启用面上也会留在清单里：它没被构造，才能证明「profile 没启用」，
 * 而不是「清单里压根没有这个模块」。
 */
function fixtureManifests(profile: AssemblyProfile, events: string[]): readonly ModuleManifest[] {
  const gitManifest = generatedModuleManifests.find((manifest) => manifest.id === "git");
  if (gitManifest === undefined) throw new Error("生成的 registry 里没有 git manifest");

  const resolved = createModuleRegistry(generatedModuleManifests).resolveProfile(profile);
  const serverManifests = resolved.modules.map((manifest): ModuleManifest => {
    if (manifest.id === "git") return gitManifest;
    return {
      id: manifest.id,
      kind: manifest.kind,
      dependsOn: manifest.dependsOn,
      // Web 贡献随真实 manifest 一起带过来：profile 的 `web` 列表要经它解析出归属模块，去掉就等于改小了 profile。
      ...(manifest.web === undefined ? {} : { web: manifest.web }),
      create: ({ registerCleanup }) => {
        events.push(`create:${manifest.id}`);
        registerCleanup(() => {
          events.push(`dispose:${manifest.id}`);
        });
        return { id: manifest.id };
      },
    };
  });

  const enabledGit = serverManifests.some((manifest) => manifest.id === "git");
  return [
    ...serverManifests,
    ...(enabledGit ? [] : [gitManifest]),
    ...generatedModuleManifests.filter((manifest) => manifest.kind === "web-shell"),
  ];
}

/**
 * 用例级临时目录：连接配置写在系统临时目录而不是仓库里。
 *
 * 配置文件里只有 `{env:NAME}` 引用，凭据值经 `loadEnv` 注入，所以临时文件本身不含密钥材料。
 */
const tempDir = mkdtempSync(join(tmpdir(), "fenix-git-assembly-"));

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeGitConfigFile(): string {
  const path = join(tempDir, "git-connections.json");
  writeFileSync(
    path,
    JSON.stringify({
      connections: [
        { id: "primary", baseUrl: "http://forgejo.test:3210", provisionTokenRef: "{env:AOS_GIT_PROVISION_TOKEN}" },
      ],
    }),
    "utf8",
  );
  return path;
}

/** 走「真实 profile → 宿主投影」把 git 模块配置取出来；这一块只读 env 声明的键，不依赖宿主 config 单例。 */
async function projectGitConfig(input: Readonly<Record<string, unknown>>): Promise<unknown> {
  const { env } = await resolveAssemblyEnv({
    profilePath: GIT_ASSEMBLY_PROFILE_PATH,
    input: { ...BASE_INPUT, ...input },
  });
  return buildModuleConfigs(env, config)["git"];
}

/**
 * 复位本文件用到的进程级状态。
 *
 * 前后都要复位：`bun test` 的多文件共享进程，应用基础设施（只允许初始化一次）与 git 单例漏复位，会让下一个
 * 测试文件里的装配报「已初始化」——症状与失败文件相隔很远，正是「单独跑通过、全量跑失败」那类泄漏。
 */
function resetGitTestState(): void {
  resetAllStubs();
  // git 单例由模块自己持有（manifest 不登记 cleanup），用例之间必须显式复位。
  resetGitModuleForTesting();
}

beforeEach(resetGitTestState);
afterEach(resetGitTestState);

// ce-git.json 与 ce.json 的差集只能是一个 git：顺手改动 web 列表或身份槽位，会让「只多了 Git 能力」这个前提静默失效。
test("ce-git.json 只在 resources 末尾追加 git", async () => {
  const [ce, ceGit] = await Promise.all([
    loadAssemblyProfile(CE_ASSEMBLY_PROFILE_PATH),
    loadAssemblyProfile(GIT_ASSEMBLY_PROFILE_PATH),
  ]);

  expect(ceGit.resources).toEqual([...ce.resources, "git"]);
  expect({ ...ceGit, resources: [] }).toEqual({ ...ce, resources: [] });
});

// 默认发布组合（ce.json）不启用 git：真实 registry 的解析结果里没有它，装配也不会构造它——git 未配置模块配置，若被构造必然抛错。
test("ce.json 不启用 git 且不构造 git 模块", async () => {
  const ceProfile = await loadAssemblyProfile(CE_ASSEMBLY_PROFILE_PATH);
  initializeTestApplicationInfrastructure();

  const result = await bootstrapServerAssembly({
    profile: ceProfile,
    manifests: fixtureManifests(ceProfile, []),
    loadEnv: loadEnvFrom(BASE_INPUT),
  });

  expect(
    createModuleRegistry(generatedModuleManifests)
      .resolveProfile(ceProfile)
      .modules.map((m) => m.id),
  ).not.toContain("git");
  expect(result.modules.map((manifest) => manifest.id)).not.toContain("git");
  expect(result.instances.has("git")).toBe(false);
  expect(() => getGitService()).toThrow();

  await result.dispose();
});

// 装配成功后的 dispose 可重复调用：宿主可能同时从信号处理与错误路径触发关闭，重复释放不得重跑 cleanup。
test("装配成功后的 dispose 幂等", async () => {
  const ceProfile = await loadAssemblyProfile(CE_ASSEMBLY_PROFILE_PATH);
  const events: string[] = [];
  initializeTestApplicationInfrastructure();

  const result = await bootstrapServerAssembly({
    profile: ceProfile,
    manifests: fixtureManifests(ceProfile, events),
    loadEnv: loadEnvFrom(BASE_INPUT),
  });

  await result.dispose();
  await result.dispose();

  const disposals = events.filter((event) => event.startsWith("dispose:"));
  expect(disposals.length).toBeGreaterThan(0);
  // 每个模块只释放一次：dispose 的幂等由 platform-sdk 的 `??=` 保证，重复调用不得重跑 cleanup。
  expect(new Set(disposals).size).toBe(disposals.length);
});

// 启用 git 但没配 AOS_GIT_CONFIG_FILE 时装配在 create 阶段失败：消息只指向配置键、不回显凭据值，且失败前已创建的模块被回滚清理。
test("ce-git.json 未配置 AOS_GIT_CONFIG_FILE 时 create 阶段失败", async () => {
  const gitProfile = await loadAssemblyProfile(GIT_ASSEMBLY_PROFILE_PATH);
  const events: string[] = [];
  initializeTestApplicationInfrastructure();

  const failure = await failureOf(
    bootstrapServerAssembly({
      profile: gitProfile,
      manifests: fixtureManifests(gitProfile, events),
      loadEnv: loadEnvFrom({
        ...BASE_INPUT,
        AOS_GIT_CONFIG_FILE: "",
        AOS_GIT_PROVISION_TOKEN: PROVISION_TOKEN,
        AOS_GIT_SERVICE_TOKEN: SERVICE_TOKEN,
      }),
    }),
  );

  expect(failure.message).toContain("AOS_GIT_CONFIG_FILE");
  expect(failure.message).not.toContain(PROVISION_TOKEN);
  expect(failure.message).not.toContain(SERVICE_TOKEN);
  // 失败不留下部分启动状态：git 之前创建的模块都被清理（identity 是最先创建的那个）。
  expect(events).toContain("dispose:identity");
  // 失败的初始化不进单例：配置修好后同一进程内必须能重新装配，而不是永久记住这次错误。
  expect(() => getGitService()).toThrow();
});

// 配置齐备时装配出 git 服务（连接与凭据值经宿主投影原样进入模块），且 dispose 可连续调用两次。
test("ce-git.json 配置齐备时装配出 git 服务且 dispose 幂等", async () => {
  const input = {
    ...BASE_INPUT,
    AOS_GIT_CONFIG_FILE: writeGitConfigFile(),
    AOS_GIT_PROVISION_TOKEN: PROVISION_TOKEN,
    AOS_GIT_SERVICE_TOKEN: SERVICE_TOKEN,
  };

  // 期望值标注成包内契约：投影字段改名会在 typecheck 期失败，而不是等到请求期读不到配置。
  const expectedConfig: GitModuleConfig = {
    connections: [
      {
        id: "primary",
        baseUrl: "http://forgejo.test:3210",
        provisionToken: PROVISION_TOKEN,
        requestTimeoutMs: 15_000,
        maxConcurrentRequests: 16,
      },
    ],
    secretValues: { AOS_GIT_PROVISION_TOKEN: PROVISION_TOKEN, AOS_GIT_SERVICE_TOKEN: SERVICE_TOKEN },
  };
  expect(await projectGitConfig(input)).toEqual(expectedConfig);

  const gitProfile = await loadAssemblyProfile(GIT_ASSEMBLY_PROFILE_PATH);
  initializeTestApplicationInfrastructure({ moduleConfigs: { git: expectedConfig } });
  const result = await bootstrapServerAssembly({
    profile: gitProfile,
    manifests: fixtureManifests(gitProfile, []),
    loadEnv: loadEnvFrom(input),
  });

  expect(result.modules.map((manifest) => manifest.id)).toContain("git");
  expect(result.instances.get("git")).toBe(getGitService());
  expect(getGitService().connectionIds).toEqual(["primary"]);

  await result.dispose();
  await result.dispose();
});

// 未配置 AOS_GIT_CONFIG_FILE（空串等同未配置）时投影空连接且不读文件：默认装配不含 git，`AOS_GIT_*` 根本不在 env 里。
test("未配置 AOS_GIT_CONFIG_FILE 时投影空连接", async () => {
  expect(await projectGitConfig({ AOS_GIT_CONFIG_FILE: "" })).toEqual({ connections: [], secretValues: {} });
});

// 配置了路径却读不出来时启动期直接失败（不降级成空连接）：否则部署会带着空连接集启动，直到第一次调用才暴露。
test("AOS_GIT_CONFIG_FILE 路径非法或读不出时启动期失败", async () => {
  const relative = await failureOf(projectGitConfig({ AOS_GIT_CONFIG_FILE: "deploy/git-connections.json" }));
  expect(relative.message).toContain("必须是绝对路径");

  const missing = await failureOf(projectGitConfig({ AOS_GIT_CONFIG_FILE: join(tempDir, "missing.json") }));
  expect(missing.message).toContain("AOS_GIT_CONFIG_FILE 读取失败");
});
