import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { DependencyService } from "@fenix/platform-sdk";
import { DEPENDENCY_ORCHESTRATIONS } from "../lib/module-dependency-facts";
import { describeReleaseFailure, type ReleaseStep, ReleaseStepError } from "../lib/release-steps";
import { deploy, release } from "../release";

/**
 * 部署入口（`scripts/release.ts`）的用例。
 *
 * fixture 走临时 workspace：生成物是**字节比对**的交付面，「哪些声明会产出什么文本」必须被逐条锁住；
 * 发布路径（`deploy`）同样在这里测——它真跑时连数据库、起容器，用例注入假执行器断言命令序列与
 * 「前一步失败即停」。最后一个用例跑真实仓库，断言已提交的 `deploy/manifests/` 与
 * `deploy/compose/overlays/` 与当前声明一致（这就是生成物的漂移门禁——`precheck` 会跑 `scripts/__tests__/`）。
 */

/** 临时 workspace 中的一个 manifest fixture；字段与 `fenix.module.ts` 的声明面一致。 */
interface ManifestFixture {
  readonly path: string;
  readonly name?: string;
  readonly id?: string;
  readonly kind?: string;
  readonly dependsOn?: readonly string[];
  readonly capabilities?: readonly string[];
  /** 声明面里的环境变量键；fixture 会为每个键生成一条最小 `envDefinitions`。 */
  readonly envKeys?: readonly string[];
  /** 依赖服务声明的源码文本，逐字插入 `dependencyServices: [...]`。 */
  readonly dependencyServices?: string;
}

/** 把 JS 值渲染成 manifest 源码里的字面量形态。 */
function literal(value: unknown): string {
  return JSON.stringify(value);
}

/** 渲染一条依赖服务声明；字段顺序与真实 manifest 一致，便于阅读用例。 */
function serviceSource(service: Partial<DependencyService> & { id: string; kind: string }): string {
  const { id, kind, ...rest } = service;
  const entries = Object.entries(rest)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${literal(value)}`)
    .join(", ");
  return `{ id: ${literal(id)}, healthCheck: { kind: ${literal(kind)}, addressKey: "SERVICE_URL", path: "/health" }, ${entries} }`;
}

function renderManifestSource(fixture: ManifestFixture): string {
  const id = fixture.id ?? fixture.path.split("/").pop() ?? "module";
  const envKeys = fixture.envKeys ?? [];
  const lines = [
    'import { z } from "zod/v4";',
    "export const moduleManifest = {",
    `  id: ${literal(id)},`,
    `  kind: ${literal(fixture.kind ?? "resource")},`,
    `  dependsOn: [${(fixture.dependsOn ?? []).map(literal).join(", ")}],`,
    `  capabilities: [${(fixture.capabilities ?? [`resource.${id}`]).map(literal).join(", ")}],`,
    "  envDefinitions: [",
    ...envKeys.map(
      (key) =>
        `    { moduleId: ${literal(id)}, key: ${literal(key)}, schema: z.string(), secret: false, restartRequired: true, description: "fixture" },`,
    ),
    "  ],",
    fixture.dependencyServices === undefined ? "" : `  dependencyServices: [${fixture.dependencyServices}],`,
    "};",
    "",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

/** 在临时 workspace 中执行生成器；`profile` 是 `deploy/assembly/ce.json` 的内容。 */
async function withWorkspace(
  fixtures: readonly ManifestFixture[],
  run: (root: string) => Promise<void>,
  options: { readonly profile?: Record<string, unknown> } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "fenix-release-"));
  try {
    for (const fixture of fixtures) {
      const packageRoot = join(root, fixture.path);
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, "fenix.module.ts"), renderManifestSource(fixture));
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: fixture.name ?? `@fenix/${fixture.path.split("/").pop()}`, dependencies: {} }),
      );
    }

    const profile = options.profile ?? {
      accessControl: "access-control",
      agentRuntime: "agent-runtime",
      identity: "identity",
      resources: ["knowledge"],
      web: [],
      webShell: "default",
    };
    await mkdir(join(root, "deploy/assembly"), { recursive: true });
    await writeFile(join(root, "deploy/assembly/ce.json"), JSON.stringify(profile));

    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** 三个基础槽位 + Shell 的最小 fixture 集，供各用例叠加自己的模块。 */
function foundationFixtures(): readonly ManifestFixture[] {
  return [
    { id: "identity", kind: "identity", path: "packages/platform/identity" },
    { id: "access-control", kind: "access-control", path: "packages/platform/access-control" },
    { id: "agent-runtime", kind: "agent-runtime", path: "packages/agent-runtime" },
    { id: "default", kind: "web-shell", path: "apps/web" },
  ];
}

/** 本仓编排的服务声明（`compose-overlay`）的 fixture 文本。 */
const overlayServiceFixture = serviceSource({
  description: "由本仓编排的测试服务",
  envKeys: ["SERVICE_URL"],
  id: "gotenberg",
  image: "gotenberg/gotenberg:8",
  kind: "http",
  orchestration: "compose-overlay",
  ports: ["3200:3000"],
  required: false,
});

// 生成物是部署交付面：模块索引、profile 视图与模块 overlay 三份文件必须同时产出且互相自洽。
test("按 profile 生成模块索引、部署视图与模块 overlay", async () => {
  await withWorkspace(
    [
      ...foundationFixtures(),
      {
        dependencyServices: overlayServiceFixture,
        envKeys: ["SERVICE_URL"],
        id: "knowledge",
        path: "packages/resources/knowledge",
      },
    ],
    async (root) => {
      const result = await release({ repositoryRoot: root });

      expect(result.files).toEqual([
        "deploy/manifests/modules.json",
        "deploy/manifests/profiles/ce.json",
        "deploy/compose/overlays/knowledge.yml",
      ]);

      const modules = JSON.parse(await readFile(join(root, "deploy/manifests/modules.json"), "utf8"));
      expect(modules.generatedBy).toBe("scripts/release.ts");
      expect(modules.modules.map((module: { id: string }) => module.id)).toEqual([
        "access-control",
        "agent-runtime",
        "default",
        "identity",
        "knowledge",
      ]);
      expect(modules.modules.at(-1).kind).toBe("resource");

      const profile = JSON.parse(await readFile(join(root, "deploy/manifests/profiles/ce.json"), "utf8"));
      // Web Shell 是应用级组合：它出现在模块索引里，但不进装配顺序。
      expect(profile.enabledModules).toEqual(["identity", "access-control", "agent-runtime", "knowledge"]);
      expect(profile.dependencyServices).toEqual([
        {
          declaredBy: ["knowledge"],
          description: "由本仓编排的测试服务",
          envKeys: ["SERVICE_URL"],
          healthCheck: { addressKey: "SERVICE_URL", kind: "http", path: "/health" },
          id: "gotenberg",
          orchestration: "compose-overlay",
          overlays: ["deploy/compose/overlays/knowledge.yml"],
          required: false,
        },
      ]);
      expect(profile.compose.files).toEqual(["deploy/compose/base.yml", "deploy/compose/overlays/knowledge.yml"]);

      const overlay = await readFile(join(root, "deploy/compose/overlays/knowledge.yml"), "utf8");
      expect(overlay).toContain("由 scripts/release.ts 生成");
      expect(overlay).toContain('  gotenberg:\n    image: gotenberg/gotenberg:8\n    ports:\n      - "3200:3000"');
    },
  );
});

// 编排在别处的服务不进 overlay：在这里再定义一遍就是同一栈的第二份真相，只留入口指针。
test("separate 服务只写进部署视图并留下入口指针注释", async () => {
  await withWorkspace(
    [
      ...foundationFixtures(),
      {
        dependencyServices: serviceSource({
          composeFile: "docker/ragflow/docker-compose.yml",
          description: "外部栈",
          envKeys: ["SERVICE_URL"],
          id: "ragflow",
          kind: "http",
          orchestration: "separate",
          required: false,
        }),
        envKeys: ["SERVICE_URL"],
        id: "knowledge",
        path: "packages/resources/knowledge",
      },
    ],
    async (root) => {
      await release({ repositoryRoot: root });

      // 没有本仓编排的服务 => 不产出 overlay 文件。
      await expect(readFile(join(root, "deploy/compose/overlays/knowledge.yml"), "utf8")).rejects.toThrow();

      const profile = JSON.parse(await readFile(join(root, "deploy/manifests/profiles/ce.json"), "utf8"));
      expect(profile.dependencyServices[0].composeFile).toBe("docker/ragflow/docker-compose.yml");
      expect(profile.compose.files).toEqual(["deploy/compose/base.yml"]);
    },
  );
});

// profile 引用了未注册模块时必须在生成期失败：产物描述一个装不起来的组合比没有产物更糟。
test("拒绝 profile 引用未注册模块", async () => {
  await withWorkspace(foundationFixtures(), async (root) => {
    await expect(release({ repositoryRoot: root })).rejects.toThrow("引用了未注册模块: knowledge");
  });
});

// 槽位类别必须匹配：identity 槽位指向资源模块会让装配顺序与 profile 语义脱节。
test("拒绝槽位类别不匹配的模块", async () => {
  await withWorkspace(
    [...foundationFixtures(), { id: "knowledge", path: "packages/resources/knowledge" }],
    async (root) => {
      await expect(release({ repositoryRoot: root, profileFile: "deploy/assembly/ce.json" })).rejects.toThrow(
        "模块 knowledge 必须是 identity",
      );
    },
    {
      profile: {
        accessControl: "access-control",
        agentRuntime: "agent-runtime",
        identity: "knowledge",
        resources: [],
        web: [],
        webShell: "default",
      },
    },
  );
});

// 装配依赖必须闭包：启用了依赖方却没启用被依赖方，产物里的 enabledModules 会自相矛盾。
test("拒绝未启用的装配依赖", async () => {
  await withWorkspace(
    [
      ...foundationFixtures(),
      { id: "machine", path: "packages/resources/machine" },
      { dependsOn: ["machine"], id: "sandbox", path: "packages/resources/sandbox" },
    ],
    async (root) => {
      await expect(release({ repositoryRoot: root })).rejects.toThrow("依赖未启用的模块 machine");
    },
    {
      profile: {
        accessControl: "access-control",
        agentRuntime: "agent-runtime",
        identity: "identity",
        resources: ["sandbox"],
        web: [],
        webShell: "default",
      },
    },
  );
});

// capability 冲突必须拦下：同一 capability 由两个启用模块提供时，装配层无法判定谁是权威实现。
test("拒绝已启用模块的 capability 冲突", async () => {
  await withWorkspace(
    [
      ...foundationFixtures(),
      { capabilities: ["resource.dup"], id: "knowledge", path: "packages/resources/knowledge" },
      { capabilities: ["resource.dup"], id: "skill", path: "packages/resources/skill" },
    ],
    async (root) => {
      await expect(release({ repositoryRoot: root })).rejects.toThrow("capability resource.dup 同时由");
    },
    {
      profile: {
        accessControl: "access-control",
        agentRuntime: "agent-runtime",
        identity: "identity",
        resources: ["knowledge", "skill"],
        web: [],
        webShell: "default",
      },
    },
  );
});

// 探针锚点写错在运行期只表现为「自检静默失败」，生成期的这条校验是唯一能拦住它的地方。
test("拒绝探针引用未声明的环境变量键", async () => {
  await withWorkspace(
    [
      ...foundationFixtures(),
      {
        dependencyServices: serviceSource({
          description: "探针指向未声明的键",
          envKeys: ["SERVICE_URL"],
          id: "gotenberg",
          image: "gotenberg/gotenberg:8",
          kind: "http",
          orchestration: "compose-overlay",
          required: false,
        }).replace('"SERVICE_URL"', '"UNDECLARED_URL"'),
        envKeys: ["SERVICE_URL"],
        id: "knowledge",
        path: "packages/resources/knowledge",
      },
    ],
    async (root) => {
      await expect(release({ repositoryRoot: root })).rejects.toThrow("引用了未声明的环境变量 UNDECLARED_URL");
    },
  );
});

// 同一服务被两个模块声明：形态一致时合并（required 取并集），形态不一致时必须失败。
test("按 ID 合并同一服务并取 required 并集", async () => {
  const shared = (required: boolean) =>
    serviceSource({
      description: "共享服务",
      envKeys: ["SERVICE_URL"],
      id: "shared",
      image: "example/shared:1",
      kind: "tcp",
      orchestration: "compose-overlay",
      required,
    });

  await withWorkspace(
    [
      ...foundationFixtures(),
      {
        dependencyServices: shared(false),
        envKeys: ["SERVICE_URL"],
        id: "knowledge",
        path: "packages/resources/knowledge",
      },
      { dependencyServices: shared(true), envKeys: ["SERVICE_URL"], id: "skill", path: "packages/resources/skill" },
    ],
    async (root) => {
      await release({ repositoryRoot: root });

      const profile = JSON.parse(await readFile(join(root, "deploy/manifests/profiles/ce.json"), "utf8"));
      expect(profile.dependencyServices).toHaveLength(1);
      expect(profile.dependencyServices[0].declaredBy).toEqual(["knowledge", "skill"]);
      expect(profile.dependencyServices[0].required).toBe(true);
      expect(profile.compose.files).toEqual([
        "deploy/compose/base.yml",
        "deploy/compose/overlays/knowledge.yml",
        "deploy/compose/overlays/skill.yml",
      ]);
    },
    {
      profile: {
        accessControl: "access-control",
        agentRuntime: "agent-runtime",
        identity: "identity",
        resources: ["knowledge", "skill"],
        web: [],
        webShell: "default",
      },
    },
  );
});

// 形态不一致的同名服务必须失败：同一服务两份编排定义会让部署方无法判断哪份生效。
test("拒绝同名服务的形态不一致", async () => {
  await withWorkspace(
    [
      ...foundationFixtures(),
      {
        dependencyServices: serviceSource({
          description: "共享服务",
          envKeys: ["SERVICE_URL"],
          id: "shared",
          image: "example/shared:1",
          kind: "tcp",
          orchestration: "compose-overlay",
          required: false,
        }),
        envKeys: ["SERVICE_URL"],
        id: "knowledge",
        path: "packages/resources/knowledge",
      },
      {
        dependencyServices: serviceSource({
          description: "共享服务",
          envKeys: ["SERVICE_URL"],
          id: "shared",
          image: "example/other:2",
          kind: "tcp",
          orchestration: "compose-overlay",
          required: false,
        }),
        envKeys: ["SERVICE_URL"],
        id: "skill",
        path: "packages/resources/skill",
      },
    ],
    async (root) => {
      await expect(release({ repositoryRoot: root })).rejects.toThrow("声明成不同形态");
    },
    {
      profile: {
        accessControl: "access-control",
        agentRuntime: "agent-runtime",
        identity: "identity",
        resources: ["knowledge", "skill"],
        web: [],
        webShell: "default",
      },
    },
  );
});

// --check 是漂移门禁：产物与声明一致时通过，被改动或残留时必须失败。
test("check 模式拦住过期产物与残留文件", async () => {
  await withWorkspace(
    [
      ...foundationFixtures(),
      {
        dependencyServices: overlayServiceFixture,
        envKeys: ["SERVICE_URL"],
        id: "knowledge",
        path: "packages/resources/knowledge",
      },
    ],
    async (root) => {
      await release({ repositoryRoot: root });
      await expect(release({ repositoryRoot: root, check: true })).resolves.toBeDefined();

      // 手改产物 → 过期。
      await writeFile(join(root, "deploy/manifests/modules.json"), "{}\n");
      await expect(release({ repositoryRoot: root, check: true })).rejects.toThrow("部署产物已过期");

      // 重新生成后追加一个不属于任何模块的 overlay → 残留。
      await release({ repositoryRoot: root });
      await writeFile(join(root, "deploy/compose/overlays/ghost.yml"), "services: {}\n");
      await expect(release({ repositoryRoot: root, check: true })).rejects.toThrow("有非生成物残留");

      // 生成模式与 --check 同口径：残留的 overlay 会被清掉，而不是留到下一次人工收尾。
      await release({ repositoryRoot: root });
      await expect(readFile(join(root, "deploy/compose/overlays/ghost.yml"), "utf8")).rejects.toThrow();

      // 产物缺失同样要失败，避免「本地生成过、CI 里没有」的假通过。
      await rm(join(root, "deploy/manifests/profiles/ce.json"));
      await expect(release({ repositoryRoot: root, check: true })).rejects.toThrow("部署产物不存在");
    },
  );
});

// 声明了本仓编排服务的模块才有 overlay：没有服务的模块不该产出空文件。
test("只为有本仓编排服务的模块产出 overlay", async () => {
  await withWorkspace(
    [...foundationFixtures(), { id: "knowledge", path: "packages/resources/knowledge" }],
    async (root) => {
      const result = await release({ repositoryRoot: root });

      expect(result.files).toEqual(["deploy/manifests/modules.json", "deploy/manifests/profiles/ce.json"]);
    },
  );
});

// 生成期与 SDK 的编排归属取值必须同集合：两处漂移会让生成器接受 SDK 拒绝、或反之。
test("编排归属取值与 SDK 类型穷尽一致", () => {
  const sdkKinds = ["compose-overlay", "separate"] as const satisfies readonly DependencyService["orchestration"][];

  expect([...DEPENDENCY_ORCHESTRATIONS].sort()).toEqual([...sdkKinds].sort());
});

// 真实仓库的已提交产物必须与当前声明一致：这是生成物进版本控制后的漂移门禁。
test("真实仓库的部署产物与声明一致", async () => {
  const repositoryRoot = resolve(import.meta.dir, "../..");
  const result = await release({ repositoryRoot, check: true });

  expect(result.profileId).toBe("ce");
  expect(result.files).toContain("deploy/manifests/modules.json");
  expect(result.files).toContain("deploy/manifests/profiles/ce.json");
  expect(result.files).toContain("deploy/compose/overlays/knowledge.yml");
});

/** 发布路径的 fixture：先由生成器产出部署视图，`deploy` 的启动命令正是从它读取的。 */
async function withGeneratedWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  await withWorkspace(
    [
      ...foundationFixtures(),
      {
        dependencyServices: overlayServiceFixture,
        envKeys: ["SERVICE_URL"],
        id: "knowledge",
        path: "packages/resources/knowledge",
      },
    ],
    async (root) => {
      await release({ repositoryRoot: root });
      await run(root);
    },
  );
}

/** 记录步骤序列的假执行器；`failOn` 指定的步骤返回 1，其余返回 0。 */
function recordingRunner(executed: ReleaseStep[], failOn?: string): (step: ReleaseStep) => Promise<number> {
  return async (step) => {
    executed.push(step);
    return step.id === failOn ? 1 : 0;
  };
}

// 发布顺序是契约（docs/operations/upgrade.md §1）：迁移走仓库既有入口，部署命令只来自生成的部署视图。
test("deploy 按序执行迁移与部署，命令取自既有入口与部署视图", async () => {
  await withGeneratedWorkspace(async (root) => {
    const executed: ReleaseStep[] = [];
    const result = await deploy({ log: () => {}, repositoryRoot: root, runStep: recordingRunner(executed) });

    expect(executed.map((step) => step.id)).toEqual(["ddl-migrate", "data-migrate", "compose-up"]);
    expect(executed.map((step) => step.command)).toEqual([
      ["bun", "run", "scripts/migrate.ts"],
      ["bun", "run", "run-data-migrations"],
      ["sh", "-c", "docker compose -f deploy/compose/base.yml -f deploy/compose/overlays/knowledge.yml up -d"],
    ]);
    expect(result.composeUp).toBe(
      "docker compose -f deploy/compose/base.yml -f deploy/compose/overlays/knowledge.yml up -d",
    );
    expect(result.steps.map((step) => step.title)).toEqual(["DDL 迁移", "数据迁移", "容器部署"]);
  });
});

// 失败即停：数据迁移非零退出后不得进入容器部署，报告必须回答「哪一步、为什么、能不能重跑」。
test("deploy 在某一步失败后停止并报告定位、原因与可重跑性", async () => {
  await withGeneratedWorkspace(async (root) => {
    const executed: ReleaseStep[] = [];
    const failure = await deploy({
      log: () => {},
      logError: () => {},
      repositoryRoot: root,
      runStep: recordingRunner(executed, "data-migrate"),
    }).catch((error: unknown) => error);

    expect(executed.map((step) => step.id)).toEqual(["ddl-migrate", "data-migrate"]);
    expect(failure).toBeInstanceOf(ReleaseStepError);
    const report = describeReleaseFailure(failure as ReleaseStepError);
    expect(report[0]).toContain("第 2 步「数据迁移」");
    expect(report[0]).toContain("退出码 1");
    // 「后续步骤未执行」是发布结论的一部分：操作者据此判断运行环境停在哪一步。
    expect(report[1]).toContain("「容器部署」");
    expect(report[2]).toContain("可重跑性");
  });
});

// 第 0 步是部署面校验：产物与声明不一致时连第一步都不执行，否则会按过期视图起错组合。
test("deploy 在部署面过期时停在第一步之前", async () => {
  await withGeneratedWorkspace(async (root) => {
    await writeFile(join(root, "deploy/manifests/modules.json"), "{}\n");

    const executed: ReleaseStep[] = [];
    const failure = await deploy({
      log: () => {},
      logError: () => {},
      repositoryRoot: root,
      runStep: recordingRunner(executed),
    }).catch((error: unknown) => error);

    expect(executed).toEqual([]);
    expect(failure).toBeInstanceOf(ReleaseStepError);
    const report = describeReleaseFailure(failure as ReleaseStepError);
    expect(report[0]).toContain("第 0 步「部署面校验」");
    expect(report[0]).toContain("部署产物已过期");
    expect(report[1]).toContain("「DDL 迁移」");
  });
});

// 产物缺失时第 0 步同样拦住：缺失比过期更危险，命令文本根本读不到。
test("deploy 在部署视图缺失时停在第一步之前", async () => {
  await withGeneratedWorkspace(async (root) => {
    await rm(join(root, "deploy/manifests/profiles/ce.json"));

    const failure = await deploy({
      log: () => {},
      logError: () => {},
      repositoryRoot: root,
      runStep: recordingRunner([]),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ReleaseStepError);
    expect(describeReleaseFailure(failure as ReleaseStepError)[0]).toContain("部署产物不存在");
  });
});
