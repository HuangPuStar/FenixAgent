import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type GitModuleConfig, getGitService, resetGitModuleForTesting } from "@fenix/git/server";
import { type AssemblyProfile, createModuleRegistry, type ModuleManifest } from "@fenix/platform-sdk";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import {
  getTicketsServerModule,
  resetTicketsServerModule,
  TICKET_PROJECT_RESOURCE_TYPE,
  type TicketsModuleDeps,
  ticketProjectResource,
} from "@fenix/resource-tickets/server";
import { generatedModuleManifests } from "../../../generated/module-registry";
import { CE_ASSEMBLY_PROFILE_PATH, loadAssemblyProfile } from "../assembly-config";
import { bootstrapServerAssembly, type ServerAssemblyBootstrapOptions } from "../bootstrap";
import { resolveAssemblyEnv } from "../bootstrap/assembly-env";
import { loadServerEnv } from "../env-loader";

/**
 * 工单模块在宿主装配面上的接线（单元 G2；backend contract §10 表末行）。
 *
 * 与 `git-tickets-assembly.test.ts` 同一套手法：**真实 profile 文件 + 真实生成的 registry + 真实
 * git/tickets manifest**，只把其余模块的工厂换成最小 fixture——真实运行面会在装配期绑定进程级单例，
 * 而 `bun test` 的多个测试文件共享进程，真跑一次就会让同批其它文件撞上「已绑定 / 已初始化」。
 * git 自身的启用面、失败面与释放面由那个文件覆盖，本文件只补工单的四件事：
 * `ce-tickets.json` 的差集、tickets 依赖未启用时在副作用前失败、默认 profile 不构造 tickets 且不出站、
 * ce-tickets.json 下 git 先于 tickets 构造且 tickets 装入进程级槽位（路由贡献的读取点）。
 *
 * 用例**不读进程环境**（`loadEnv` 全部经输入注入），也不触网：git 适配器在构造期只建配置与信号量，
 * 首次调用才连 Forgejo，因此「装配成功」本身就是「没有出站请求」的证据；默认 profile 那条用例额外给
 * `globalThis.fetch` 装桩，把这句话从注释变成断言。
 */

/** 启动面所需的必填项：两枚宿主键 + workflow-v2 的三枚无默认值声明（真实 profile 会聚合它们）。 */
const BASE_INPUT = {
  DATABASE_URL: "postgres://127.0.0.1:5432/fenix",
  RCS_API_KEYS: "test-api-keys",
  WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL: "workflow-v2@example.test",
  WORKFLOW_V2_PLATFORM_ACCOUNT_PASSWORD: "test-password",
  WORKFLOW_V2_TICKET_SECRET: "test-ticket-secret",
} as const;

/** 启用 git 与工单的两份发布组合：路径由默认入口推导，不硬编码仓库根。 */
const GIT_ASSEMBLY_PROFILE_PATH = join(dirname(CE_ASSEMBLY_PROFILE_PATH), "ce-git.json");
const TICKETS_ASSEMBLY_PROFILE_PATH = join(dirname(CE_ASSEMBLY_PROFILE_PATH), "ce-tickets.json");

/** 合成凭据：只喂给凭据引用，不指向任何真实实例。 */
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
 * 取真实 manifest；缺失即报错，避免用 `!` 把生成器的回归变成 `undefined` 的静默传播。
 */
function requireManifest(id: string): ModuleManifest {
  const manifest = generatedModuleManifests.find((candidate) => candidate.id === id);
  if (manifest === undefined) throw new Error(`生成的 registry 里没有 ${id} manifest`);
  return manifest;
}

/**
 * 装配期不得触达的授权端口：形状取自 `TicketsModuleDeps` 的前三项，不另写一份契约类型。
 *
 * `src/module.ts` 只检查这三件端口的**存在性**，授权判定发生在请求期；装配期触达它们说明模块把授权
 * 前置到了启动路径，那是需要评审的行为变更，因此这里一被调用就抛错而不是返回空实现。
 */
function unusedAccessControlPorts(): Pick<TicketsModuleDeps, "accessControl" | "scopeStore" | "authorizedQuery"> {
  const unused = async (): Promise<never> => {
    throw new Error("工单模块的装配期不应触达授权端口");
  };
  return {
    accessControl: {
      id: "access-control-fixture",
      resolveInitialScope: unused,
      initializeResourceAccess: unused,
      authorize: unused,
      createListConstraint: unused,
      resolveAccess: unused,
      resolveAccessMany: unused,
    },
    scopeStore: { initialize: unused, getMany: unused, update: unused, remove: unused },
    authorizedQuery: { list: unused, count: unused, findById: unused },
  };
}

/** 记录构造顺序的最小工厂：只登记 cleanup，不读 env、不持有句柄。 */
function recordingFixture(manifest: ModuleManifest, events: string[]): ModuleManifest {
  return {
    id: manifest.id,
    kind: manifest.kind,
    dependsOn: manifest.dependsOn,
    // Web 贡献随真实 manifest 一起带过来：profile 的 `web` 列表要经它解析出归属模块，去掉等于改小了 profile。
    ...(manifest.web === undefined ? {} : { web: manifest.web }),
    create: ({ registerCleanup }) => {
      events.push(`create:${manifest.id}`);
      registerCleanup(() => {
        events.push(`dispose:${manifest.id}`);
      });
      return { id: manifest.id };
    },
  };
}

/**
 * 按真实 profile 的解析结果构造「最小工厂」清单。
 *
 * git 与 tickets 用**真实** manifest（包一层记录构造顺序）：它们的接线正确性是本文件的被测对象。
 * access-control 用 fixture 但补上三个端口，否则 tickets 的工厂会因端口缺失当场失败——那是
 * `module-assembly` 级别的另一条用例，不该在这里被顺带覆盖。
 *
 * 未被 profile 启用的 git / tickets 也留在清单里：它们没被构造，才能证明「profile 没启用」，
 * 而不是「清单里压根没有这个模块」。两者必须成对保留（tickets 的 `dependsOn: ["git"]` 在注册期校验）。
 */
function fixtureManifests(profile: AssemblyProfile, events: string[]): readonly ModuleManifest[] {
  const trackCreation = (manifest: ModuleManifest): ModuleManifest => ({
    ...manifest,
    create: (context) => {
      events.push(`create:${manifest.id}`);
      return manifest.create?.(context);
    },
  });

  const resolved = createModuleRegistry(generatedModuleManifests).resolveProfile(profile);
  const serverManifests = resolved.modules.map((manifest): ModuleManifest => {
    if (manifest.id === "git" || manifest.id === "tickets") return trackCreation(manifest);
    if (manifest.id === "access-control") {
      return {
        ...manifest,
        create: ({ registerCleanup }) => {
          events.push(`create:${manifest.id}`);
          registerCleanup(() => {
            events.push(`dispose:${manifest.id}`);
          });
          return { id: manifest.id, ...unusedAccessControlPorts() };
        },
      };
    }
    return recordingFixture(manifest, events);
  });

  const listed = new Set(serverManifests.map((manifest) => manifest.id));
  const idle = [
    ...(listed.has("git") ? [] : [trackCreation(requireManifest("git"))]),
    ...(listed.has("tickets") ? [] : [trackCreation(requireManifest("tickets"))]),
  ];
  return [...serverManifests, ...idle, ...generatedModuleManifests.filter((manifest) => manifest.kind === "web-shell")];
}

/**
 * 用例级临时目录：连接配置写在系统临时目录而不是仓库里。
 *
 * 配置文件里只有 `{env:NAME}` 引用，凭据值经 `loadEnv` 注入，所以临时文件本身不含密钥材料。
 */
const tempDir = mkdtempSync(join(tmpdir(), "fenix-tickets-assembly-"));

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

/** 启用 git 与工单所需的完整输入；ce-tickets.json 不新增任何必填键（见「环境声明」用例）。 */
const ENABLED_INPUT = {
  ...BASE_INPUT,
  AOS_GIT_CONFIG_FILE: writeGitConfigFile(),
  AOS_GIT_PROVISION_TOKEN: PROVISION_TOKEN,
  AOS_GIT_SERVICE_TOKEN: SERVICE_TOKEN,
} as const;

/** 宿主投影出的 git 配置：标注成包内契约，投影字段改名会在 typecheck 期失败。 */
const GIT_MODULE_CONFIG: GitModuleConfig = {
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

/**
 * 复位本文件用到的进程级状态。
 *
 * 前后都要复位：应用基础设施只允许初始化一次，而 git 与 tickets 的单例槽位都由模块自己持有
 * （manifest 不登记 tickets 的 cleanup），漏复位会让同批下一个测试文件撞上「已初始化 / 已有装配结果」。
 */
function resetTicketsTestState(): void {
  resetAllStubs();
  resetGitModuleForTesting();
  resetTicketsServerModule();
}

beforeEach(resetTicketsTestState);
afterEach(resetTicketsTestState);

// ce-tickets.json 相对 ce-git.json 只多两处 tickets：`resources`（服务端可装配）与 `web`（前端载荷）。
// 其余字段必须逐字相同——顺手改动身份槽位或别的资源，会让「只多了工单能力」这个前提静默失效。
test("ce-tickets.json 相对 ce-git.json 只追加 tickets", async () => {
  const [ceGit, ceTickets] = await Promise.all([
    loadAssemblyProfile(GIT_ASSEMBLY_PROFILE_PATH),
    loadAssemblyProfile(TICKETS_ASSEMBLY_PROFILE_PATH),
  ]);

  expect(ceTickets.resources).toEqual([...ceGit.resources, "tickets"]);
  expect(ceTickets.web).toEqual([...ceGit.web, "tickets"]);
  expect({ ...ceTickets, resources: [], web: [] }).toEqual({ ...ceGit, resources: [], web: [] });
});

// 启用 tickets 而不启用 git 时装配必须在产生任何副作用前失败：profile 的依赖判定先于环境加载与工厂执行，
// 报错只指名两个模块 ID（不含路径与凭据），部署方据此能直接看出是 profile 少启用了一个模块。
test("tickets 启用而 git 未启用时在副作用前失败", async () => {
  const profile = await loadAssemblyProfile(TICKETS_ASSEMBLY_PROFILE_PATH);
  const broken: AssemblyProfile = { ...profile, resources: profile.resources.filter((id) => id !== "git") };
  const events: string[] = [];
  let loadEnvCalls = 0;

  const failure = await failureOf(
    bootstrapServerAssembly({
      profile: broken,
      manifests: fixtureManifests(profile, events),
      loadEnv: (definitions) => {
        loadEnvCalls += 1;
        return loadServerEnv(definitions, BASE_INPUT);
      },
    }),
  );

  expect(failure.message).toBe("模块 tickets 依赖未启用模块 git");
  // 「副作用前」：git 仍在清单里（缺的是 profile 里的启用项），但环境没读、任何工厂都没跑。
  expect(loadEnvCalls).toBe(0);
  expect(events).toEqual([]);
});

// 默认发布组合（ce.json）不启用也不构造 tickets，全程不产生任何出站请求：工单默认关闭是部署面可回滚的前提，
// 装配期若就把流量引向远端，关闭态就形同虚设。
test("ce.json 不构造 tickets 且装配期无出站请求", async () => {
  const ceProfile = await loadAssemblyProfile(CE_ASSEMBLY_PROFILE_PATH);
  const events: string[] = [];
  initializeTestApplicationInfrastructure();

  const originalFetch = globalThis.fetch;
  const requests: unknown[] = [];
  // Bun 的 `fetch` 类型还带 `preconnect`，测试替身只需要可调用的那一半，因此收窄后整体替换（用例结束还原）。
  globalThis.fetch = ((...args: Parameters<typeof globalThis.fetch>): Promise<Response> => {
    requests.push(args[0]);
    throw new Error("tickets 未启用时不得发起出站请求");
  }) as typeof globalThis.fetch;

  try {
    const manifests = fixtureManifests(ceProfile, events);
    const result = await bootstrapServerAssembly({
      profile: ceProfile,
      manifests,
      loadEnv: loadEnvFrom(BASE_INPUT),
    });

    expect(
      createModuleRegistry(generatedModuleManifests)
        .resolveProfile(ceProfile)
        .modules.map((manifest) => manifest.id),
    ).not.toContain("tickets");
    // git 与 tickets 的 manifest 都在清单里却没被构造：这才是「profile 未启用」的证据。
    expect(manifests.map((manifest) => manifest.id)).toContain("tickets");
    expect(result.modules.map((manifest) => manifest.id)).not.toContain("tickets");
    expect(result.instances.has("tickets")).toBe(false);
    expect(events).not.toContain("create:tickets");
    // 未装配即报错：关闭态下任何工单读取都必须失败，不得退化成「仓库未绑定」这类业务结果。
    expect(() => getTicketsServerModule()).toThrow("工单资源模块未装配");
    expect(requests).toEqual([]);

    await result.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// 启用 tickets 不给部署面增加环境变量：它与 ce-git.json 的声明键集合逐字相同，且投影出的 resource/web
// 列表各多一个 tickets（web 投影是前端载荷的归属依据，写错会让页面入口指向别的包）。
test("ce-tickets.json 的环境声明与 ce-git.json 相同且投影出 tickets", async () => {
  const [gitEnv, ticketsEnv] = await Promise.all([
    resolveAssemblyEnv({ profilePath: GIT_ASSEMBLY_PROFILE_PATH, input: BASE_INPUT }),
    resolveAssemblyEnv({ profilePath: TICKETS_ASSEMBLY_PROFILE_PATH, input: BASE_INPUT }),
  ]);

  expect(Object.keys(ticketsEnv.env).sort()).toEqual(Object.keys(gitEnv.env).sort());
  expect(ticketsEnv.assemblyModules.modules).toEqual([...gitEnv.assemblyModules.modules, "tickets"]);
  expect(ticketsEnv.assemblyModules.web).toEqual([...gitEnv.assemblyModules.web, "tickets"]);
});

// ce-tickets.json 配置齐备时按依赖序装配出 git 再装配 tickets：tickets 经 registry 的 `context.modules`
// 取 git 端口（不是包内单例），并把自己装入进程级槽位——路由贡献正是从那里读取装配结果的。
test("ce-tickets.json 按 git → tickets 顺序装配并装入进程级槽位", async () => {
  const profile = await loadAssemblyProfile(TICKETS_ASSEMBLY_PROFILE_PATH);
  const events: string[] = [];
  initializeTestApplicationInfrastructure({ moduleConfigs: { git: GIT_MODULE_CONFIG } });

  const result = await bootstrapServerAssembly({
    profile,
    manifests: fixtureManifests(profile, events),
    loadEnv: loadEnvFrom(ENABLED_INPUT),
  });

  expect(result.instances.get("git")).toBe(getGitService());
  expect(getGitService().connectionIds).toEqual(["primary"]);
  expect(result.webContributions.get("tickets")).toBe("@fenix/resource-tickets/web/contribution");

  // 构造顺序即依赖顺序：tickets 的工厂在 git 之后执行，取到的才是已装入的端口。
  const serverIds = result.modules.map((manifest) => manifest.id);
  expect(serverIds.indexOf("git")).toBeGreaterThanOrEqual(0);
  expect(serverIds.indexOf("git")).toBeLessThan(serverIds.indexOf("tickets"));
  expect(events.indexOf("create:git")).toBeGreaterThanOrEqual(0);
  expect(events.indexOf("create:git")).toBeLessThan(events.indexOf("create:tickets"));

  const installed = getTicketsServerModule();
  expect(result.instances.get("tickets")).toBe(installed);
  expect(installed.resource).toBe(ticketProjectResource);
  expect(installed.resource.definition.type).toBe(TICKET_PROJECT_RESOURCE_TYPE);

  await result.dispose();
  // 槽位不随 dispose 清空：工单模块没有可释放的句柄（`src/server/runtime.ts`），清空它反而会让关闭序里
  // 读槽位的调用拿到「未装配」。用例之间的复位因此必须显式调 `resetTicketsServerModule()`。
  expect(getTicketsServerModule()).toBe(installed);
  await result.dispose();
});
