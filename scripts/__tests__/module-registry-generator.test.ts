import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ts from "typescript";
import { generateModuleRegistry } from "../generate-module-registry";
import { MODULE_KINDS } from "../lib/module-manifest-source";

/** 临时 workspace 中的一个 manifest fixture；路径是仓库相对路径。 */
interface ManifestFixture {
  readonly path: string;
  readonly name?: string;
  readonly id?: string;
  readonly kind?: string;
  readonly dependsOn?: readonly string[];
  readonly dependencies?: Readonly<Record<string, string>>;
  /** `undefined` 用默认的 `./fenix.module.ts`；`null` 表示完全不声明 `exports["./module"]`。 */
  readonly moduleExport?: string | null;
  /** 追加在描述符之前的原始源码行，用于构造非法导入用例。 */
  readonly prologue?: string;
  /** 追加进描述符字面量的原始字段行。 */
  readonly fields?: string;
  /** 包内源码文件（包内相对路径 → 内容），用于构造跨模块导入用例。 */
  readonly sources?: Readonly<Record<string, string>>;
}

/** 临时 workspace 的架构例外台账条目；字段与 `scripts/architecture/exceptions.json` 一致。 */
interface LedgerEntryFixture {
  readonly rule: string;
  readonly from: string;
  readonly to: string;
}

function defaultModuleId(fixture: ManifestFixture): string {
  const id = fixture.id ?? fixture.path.split("/").pop();
  if (!id) throw new Error(`fixture 缺少 id: ${fixture.path}`);
  return id;
}

function renderManifestSource(fixture: ManifestFixture): string {
  return [
    fixture.prologue ?? "",
    "export const moduleManifest = {",
    `  id: "${defaultModuleId(fixture)}",`,
    `  kind: "${fixture.kind ?? "resource"}",`,
    `  dependsOn: [${(fixture.dependsOn ?? []).map((dependencyId) => `"${dependencyId}"`).join(", ")}],`,
    fixture.fields ?? "",
    "};",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** 在临时可信 workspace 中执行 registry 生成器。 */
async function withWorkspace(
  fixtures: readonly ManifestFixture[],
  run: (root: string, outputFile: string) => Promise<void>,
  options: { readonly ledger?: readonly LedgerEntryFixture[] } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "fenix-module-registry-"));
  const outputFile = join(root, "apps/generated/module-registry.ts");
  try {
    for (const fixture of fixtures) {
      const packageRoot = join(root, fixture.path);
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, "fenix.module.ts"), renderManifestSource(fixture));

      const exportsField =
        fixture.moduleExport === null ? {} : { exports: { "./module": fixture.moduleExport ?? "./fenix.module.ts" } };
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: fixture.name,
          dependencies: fixture.dependencies ?? {},
          ...exportsField,
        }),
      );

      for (const [relativePath, source] of Object.entries(fixture.sources ?? {})) {
        const sourcePath = join(packageRoot, relativePath);
        await mkdir(dirname(sourcePath), { recursive: true });
        await writeFile(sourcePath, source);
      }
    }

    if (options.ledger) {
      await mkdir(join(root, "scripts/architecture"), { recursive: true });
      await writeFile(
        join(root, "scripts/architecture/exceptions.json"),
        JSON.stringify({
          exceptions: options.ledger.map((entry) => ({
            ...entry,
            owner: "1.3",
            removeWhen: "fixture 用例结束",
            rationale: "fixture",
          })),
        }),
      );
    }

    await run(root, outputFile);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

/** 从 platform-sdk 源码读出 ModuleKind 的字面量成员，用于守护生成器的类别列表。 */
function readModuleKindUnion(sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(
    "module-manifest.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  for (const statement of sourceFile.statements) {
    if (!ts.isTypeAliasDeclaration(statement) || statement.name.text !== "ModuleKind") continue;
    if (!ts.isUnionTypeNode(statement.type)) throw new Error("ModuleKind 不是联合类型");
    return statement.type.types.map((member) => {
      if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteralLike(member.literal)) {
        throw new Error("ModuleKind 只能由字符串字面量成员组成");
      }
      return member.literal.text;
    });
  }
  throw new Error("未找到 ModuleKind 类型别名");
}

// registry 使用公开 package export，排序不受目录枚举顺序影响。
test("生成按 package name 排序的静态 import registry", async () => {
  await withWorkspace(
    [
      { path: "packages/resources/agent-config", name: "@fenix/agent-config", id: "agent-config" },
      { path: "packages/platform/access-control", name: "@fenix/access-control", id: "access-control" },
    ],
    async (root, outputFile) => {
      const result = await generateModuleRegistry({ repositoryRoot: root, outputFile });
      const source = await readFile(outputFile, "utf8");

      expect(result.moduleCount).toBe(2);
      expect(source).toContain('from "@fenix/access-control/module";');
      expect(source).toContain('from "@fenix/agent-config/module";');
      expect(source.indexOf("@fenix/access-control/module")).toBeLessThan(source.indexOf("@fenix/agent-config/module"));
      expect(source.indexOf("@fenix/agent-config/module")).toBeLessThan(source.indexOf("@fenix/platform-sdk"));
      expect(source).not.toContain("import(");
    },
  );
});

// apps 下的 Shell manifest 由生成物相对导入，避免 registry 引入 apps → apps 的包依赖。
test("apps 下的 web-shell manifest 使用相对路径导入", async () => {
  await withWorkspace(
    [
      { path: "packages/platform/access-control", name: "@fenix/access-control", id: "access-control" },
      { path: "apps/web", name: "@fenix/web-app", id: "default", kind: "web-shell" },
    ],
    async (root, outputFile) => {
      const result = await generateModuleRegistry({ repositoryRoot: root, outputFile });
      const source = await readFile(outputFile, "utf8");

      expect(result.moduleCount).toBe(2);
      expect(source).toContain('import { moduleManifest as manifest1 } from "../web/fenix.module.ts";');
      expect(source).not.toContain("@fenix/web-app");
      expect(source).toContain("export const generatedModuleManifests = [manifest0, manifest1]");
    },
  );
});

// 缺少 package name 时无法生成稳定公开 import，必须显式失败。
test("拒绝缺少 package name 的 manifest", async () => {
  await withWorkspace([{ path: "packages/platform/broken" }], async (root, outputFile) => {
    await expect(generateModuleRegistry({ repositoryRoot: root, outputFile })).rejects.toThrow(
      "模块缺少 package name: packages/platform/broken/fenix.module.ts",
    );
  });
});

// 两个 manifest 指向同一公开入口会产生不确定注册项，生成阶段必须拒绝。
test("拒绝重复 package name", async () => {
  await withWorkspace(
    [
      { path: "packages/platform/first", name: "@fenix/duplicate", id: "first" },
      { path: "packages/platform/second", name: "@fenix/duplicate", id: "second" },
    ],
    async (root, outputFile) => {
      await expect(generateModuleRegistry({ repositoryRoot: root, outputFile })).rejects.toThrow(
        "模块 package name 重复: @fenix/duplicate",
      );
    },
  );
});

// 两个包声明同一模块 ID 会让 profile 引用产生歧义，生成阶段必须拒绝。
test("拒绝重复模块 ID", async () => {
  await withWorkspace(
    [
      { path: "packages/platform/first", name: "@fenix/first", id: "same" },
      { path: "packages/platform/second", name: "@fenix/second", id: "same" },
    ],
    async (root, outputFile) => {
      await expect(generateModuleRegistry({ repositoryRoot: root, outputFile })).rejects.toThrow(
        "模块 ID 重复: same (@fenix/first 与 @fenix/second)",
      );
    },
  );
});

// 排序必须基于 UTF-16 代码单元，不得受构建机 locale/ICU 标点权重影响。
test("使用跨环境稳定的代码点顺序生成 registry", async () => {
  await withWorkspace(
    [
      { path: "packages/platform/underscore", name: "@fenix/a_b", id: "third" },
      { path: "packages/platform/dot", name: "@fenix/a.b", id: "second" },
      { path: "packages/platform/dash", name: "@fenix/a-b", id: "first" },
    ],
    async (root, outputFile) => {
      await generateModuleRegistry({ repositoryRoot: root, outputFile });
      const source = await readFile(outputFile, "utf8");

      expect(source.indexOf("@fenix/a-b/module")).toBeLessThan(source.indexOf("@fenix/a.b/module"));
      expect(source.indexOf("@fenix/a.b/module")).toBeLessThan(source.indexOf("@fenix/a_b/module"));
    },
  );
});

// CI check 只比较确定性产物，不在检查阶段静默覆写陈旧 registry。
test("check 模式拒绝陈旧生成物且不覆写文件", async () => {
  await withWorkspace(
    [{ path: "packages/platform/access-control", name: "@fenix/access-control", id: "access-control" }],
    async (root, outputFile) => {
      await mkdir(join(root, "apps/generated"), { recursive: true });
      await writeFile(outputFile, "stale\n");

      await expect(generateModuleRegistry({ repositoryRoot: root, outputFile, check: true })).rejects.toThrow(
        "静态 module registry 已过期",
      );
      expect(await readFile(outputFile, "utf8")).toBe("stale\n");
    },
  );
});

// manifest 必须是可静态求值的字面量，否则生成器的校验结论不可靠。
test("拒绝非字面量描述符与非法 kind", async () => {
  await withWorkspace([{ path: "packages/platform/dynamic", name: "@fenix/dynamic" }], async (root, outputFile) => {
    await writeFile(join(root, "packages/platform/dynamic/fenix.module.ts"), "export const moduleManifest = {};\n");
    await expect(generateModuleRegistry({ repositoryRoot: root, outputFile })).rejects.toThrow(
      "manifest 必须声明合法模块 ID 字面量 id",
    );
  });

  await withWorkspace(
    [{ path: "packages/platform/bad-kind", name: "@fenix/bad-kind", id: "bad-kind", kind: "plugin" }],
    async (root, outputFile) => {
      await expect(generateModuleRegistry({ repositoryRoot: root, outputFile })).rejects.toThrow(
        "manifest 的 kind 必须是",
      );
    },
  );
});

// registry 必须能通过稳定公开入口引用 manifest，否则构建产物无法解析。
test("拒绝缺少或错配 exports[./module] 的模块包", async () => {
  await withWorkspace(
    [{ path: "packages/platform/no-export", name: "@fenix/no-export", id: "no-export", moduleExport: null }],
    async (root, outputFile) => {
      await expect(generateModuleRegistry({ repositoryRoot: root, outputFile })).rejects.toThrow(
        '模块包必须在 package.json 声明 exports["./module"] 指向 manifest',
      );
    },
  );

  await withWorkspace(
    [
      {
        path: "packages/platform/wrong-export",
        name: "@fenix/wrong-export",
        id: "wrong-export",
        moduleExport: "./src/index.ts",
      },
    ],
    async (root, outputFile) => {
      await expect(generateModuleRegistry({ repositoryRoot: root, outputFile })).rejects.toThrow(
        'exports["./module"] 必须指向 fenix.module.ts，实际指向 src/index.ts',
      );
    },
  );
});

// Shell 由 apps/web 消费，落错位置或携带运行期代码都会破坏 server 装配图的边界。
test("只允许 apps 下存在纯元数据的 web-shell manifest", async () => {
  await withWorkspace(
    [{ path: "packages/platform/shell", name: "@fenix/shell", id: "default", kind: "web-shell" }],
    async (root, outputFile) => {
      await expect(generateModuleRegistry({ repositoryRoot: root, outputFile })).rejects.toThrow(
        "web-shell manifest 必须位于 apps/ 而不是 packages/",
      );
    },
  );

  await withWorkspace(
    [{ path: "apps/web", name: "@fenix/web-app", id: "default", kind: "resource" }],
    async (root, outputFile) => {
      await expect(generateModuleRegistry({ repositoryRoot: root, outputFile })).rejects.toThrow(
        "apps 下的 manifest 只能是 web-shell 类别，实际为 resource",
      );
    },
  );

  await withWorkspace(
    [
      {
        path: "apps/web",
        name: "@fenix/web-app",
        id: "default",
        kind: "web-shell",
        prologue: 'import { createShell } from "../web/src/shell";',
      },
    ],
    async (root, outputFile) => {
      await expect(generateModuleRegistry({ repositoryRoot: root, outputFile })).rejects.toThrow(
        "web-shell manifest 只能使用 import type",
      );
    },
  );

  await withWorkspace(
    [
      {
        path: "apps/web",
        name: "@fenix/web-app",
        id: "default",
        kind: "web-shell",
        prologue: 'import type { ModuleManifest } from "@fenix/platform-sdk";',
        fields: "  create: () => ({}),",
      },
    ],
    async (root, outputFile) => {
      await expect(generateModuleRegistry({ repositoryRoot: root, outputFile })).rejects.toThrow(
        "web-shell manifest 不得声明运行期字段 create",
      );
    },
  );
});

// 装配依赖必须同时也是编译依赖，否则 profile 启用顺序无法在类型层面成立。
test("要求 dependsOn 对应的包已声明 workspace 编译依赖", async () => {
  await withWorkspace(
    [
      { path: "packages/platform/owner", name: "@fenix/owner", id: "owner", dependsOn: ["dependency"] },
      { path: "packages/resources/dependency", name: "@fenix/dependency", id: "dependency" },
    ],
    async (root, outputFile) => {
      await expect(generateModuleRegistry({ repositoryRoot: root, outputFile })).rejects.toThrow(
        '但 @fenix/owner 的 package.json 未声明编译依赖 "@fenix/dependency": "workspace:*"',
      );
    },
  );

  await withWorkspace(
    [
      {
        path: "packages/platform/owner",
        name: "@fenix/owner",
        id: "owner",
        dependsOn: ["dependency"],
        dependencies: { "@fenix/dependency": "workspace:*" },
      },
      { path: "packages/resources/dependency", name: "@fenix/dependency", id: "dependency" },
    ],
    async (root, outputFile) => {
      const result = await generateModuleRegistry({ repositoryRoot: root, outputFile });
      expect(result.moduleCount).toBe(2);
    },
  );
});

// dependsOn 指向未注册模块或自身时，装配期无法解析依赖顺序。
test("拒绝 dependsOn 引用未注册模块或自身", async () => {
  await withWorkspace(
    [
      {
        path: "packages/platform/owner",
        name: "@fenix/owner",
        id: "owner",
        dependsOn: ["missing"],
        dependencies: { "@fenix/missing": "workspace:*" },
      },
    ],
    async (root, outputFile) => {
      await expect(generateModuleRegistry({ repositoryRoot: root, outputFile })).rejects.toThrow(
        "模块 owner 的 dependsOn 引用了未注册模块 missing",
      );
    },
  );

  await withWorkspace(
    [{ path: "packages/platform/self", name: "@fenix/self", id: "self", dependsOn: ["self"] }],
    async (root, outputFile) => {
      await expect(generateModuleRegistry({ repositoryRoot: root, outputFile })).rejects.toThrow(
        "模块 self 不能依赖自身",
      );
    },
  );
});

/** 资源包 pair fixture：`importer` 通过 `sourcePath` 里的 `source` 导入 `@fenix/dependency`。 */
function resourcePairFixture(input: {
  readonly source: string;
  readonly sourcePath?: string;
  readonly dependsOn?: readonly string[];
  readonly importerKind?: string;
}): ManifestFixture[] {
  return [
    { path: "packages/resources/dependency", name: "@fenix/dependency", id: "dependency" },
    {
      path: "packages/resources/importer",
      name: "@fenix/importer",
      id: "importer",
      kind: input.importerKind,
      dependsOn: input.dependsOn ?? [],
      dependencies: { "@fenix/dependency": "workspace:*" },
      sources: { [input.sourcePath ?? "src/server/consumer.ts"]: input.source },
    },
  ];
}

const STATIC_CROSS_IMPORT =
  'import { fromDependency } from "@fenix/dependency/server";\nexport const value = fromDependency;\n';

// 资源包导入了已注册资源模块却留空 dependsOn 时，装配校验拿到的是一张假依赖图：只有反向校验能拦住。
test("要求资源包 dependsOn 覆盖对其它已注册资源模块的静态值导入", async () => {
  await withWorkspace(resourcePairFixture({ source: STATIC_CROSS_IMPORT }), async (root, outputFile) => {
    await expect(generateModuleRegistry({ repositoryRoot: root, outputFile })).rejects.toThrow(
      "模块 importer 的服务端代码导入了已注册模块 dependency（packages/resources/importer/src/server/consumer.ts:1），" +
        '但 manifest 未声明 dependsOn: ["dependency"]',
    );
  });

  await withWorkspace(
    resourcePairFixture({ source: STATIC_CROSS_IMPORT, dependsOn: ["dependency"] }),
    async (root, outputFile) => {
      expect((await generateModuleRegistry({ repositoryRoot: root, outputFile })).moduleCount).toBe(2);
    },
  );

  // 类型导入编译期擦除，不产生运行期耦合。
  await withWorkspace(
    resourcePairFixture({
      source: 'import type { FromDependency } from "@fenix/dependency/server";\nexport type Value = FromDependency;\n',
    }),
    async (root, outputFile) => {
      expect((await generateModuleRegistry({ repositoryRoot: root, outputFile })).moduleCount).toBe(2);
    },
  );

  // 动态导入延迟求值，但仍是运行期耦合，只是失败点更晚。
  await withWorkspace(
    resourcePairFixture({ source: 'export function load() {\n  return import("@fenix/dependency/server");\n}\n' }),
    async (root, outputFile) => {
      await expect(generateModuleRegistry({ repositoryRoot: root, outputFile })).rejects.toThrow(
        '未声明 dependsOn: ["dependency"]',
      );
    },
  );

  // 测试装配不进入 profile，单元测试跨包导入不构成装配依赖。
  await withWorkspace(
    resourcePairFixture({ source: STATIC_CROSS_IMPORT, sourcePath: "src/__tests__/consumer.test.ts" }),
    async (root, outputFile) => {
      expect((await generateModuleRegistry({ repositoryRoot: root, outputFile })).moduleCount).toBe(2);
    },
  );

  // 基础模块在 profile 里是固定槽位，其跨类别边由 §2.3 矩阵与架构台账负责。
  await withWorkspace(
    resourcePairFixture({ source: STATIC_CROSS_IMPORT, importerKind: "agent-runtime" }),
    async (root, outputFile) => {
      expect((await generateModuleRegistry({ repositoryRoot: root, outputFile })).moduleCount).toBe(2);
    },
  );
});

// 台账登记的越界边必须消除而不是编码成装配依赖：声明它会让 profile 同时启用两者时装配循环失败。
test("已登记为越界边的跨模块导入不要求 dependsOn，也不得写入 dependsOn", async () => {
  const ledger = [{ rule: "special-dependency", from: "@fenix/importer", to: "@fenix/dependency" }];

  await withWorkspace(
    resourcePairFixture({ source: STATIC_CROSS_IMPORT }),
    async (root, outputFile) => {
      expect((await generateModuleRegistry({ repositoryRoot: root, outputFile })).moduleCount).toBe(2);
    },
    { ledger },
  );

  await withWorkspace(
    resourcePairFixture({ source: STATIC_CROSS_IMPORT, dependsOn: ["dependency"] }),
    async (root, outputFile) => {
      await expect(generateModuleRegistry({ repositoryRoot: root, outputFile })).rejects.toThrow(
        "已由架构台账登记为越界边（rule: special-dependency, owner: 1.3）",
      );
    },
    { ledger },
  );
});

// no-circular 的 from/to 只是环上被挑中的一条边，不能当作「这两个包的边已登记」。
test("no-circular 台账条目不能豁免缺失的 dependsOn", async () => {
  await withWorkspace(
    resourcePairFixture({ source: STATIC_CROSS_IMPORT }),
    async (root, outputFile) => {
      await expect(generateModuleRegistry({ repositoryRoot: root, outputFile })).rejects.toThrow(
        '未声明 dependsOn: ["dependency"]',
      );
    },
    { ledger: [{ rule: "no-circular", from: "@fenix/importer", to: "@fenix/dependency" }] },
  );
});

// 生成器重复维护了一份 ModuleKind 列表，必须与 platform-sdk 的权威类型保持同步。
test("生成器类别列表与 ModuleKind 保持一致", async () => {
  const source = await readFile(
    join(import.meta.dir, "../../packages/platform/platform-sdk/src/assembly/module-manifest.ts"),
    "utf8",
  );
  const declared = readModuleKindUnion(source).sort();
  expect([...MODULE_KINDS].sort()).toEqual(declared);
});

// 生成器输出的目录决定相对导入基准，避免 registry 落点变化时静默指向错误文件。
test("apps 相对导入以输出文件目录为基准", async () => {
  await withWorkspace(
    [{ path: "apps/web", name: "@fenix/web-app", id: "default", kind: "web-shell" }],
    async (root) => {
      const outputFile = join(root, "nested/registry/module-registry.ts");
      await generateModuleRegistry({ repositoryRoot: root, outputFile });
      const source = await readFile(outputFile, "utf8");

      expect(source).toContain('from "../../apps/web/fenix.module.ts";');
    },
  );
});

// fixture 目录会被 mkdtemp 清理，这里只断言 helper 自身构造的路径形态稳定。
test("fixture 路径解析保持仓库相对语义", () => {
  expect(dirname("apps/web/fenix.module.ts")).toBe("apps/web");
});
