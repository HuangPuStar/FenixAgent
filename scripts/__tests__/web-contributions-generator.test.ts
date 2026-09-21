import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateWebContributions } from "../generate-web-contributions";

/** 临时 workspace 中的一个 manifest fixture；路径是仓库相对路径。 */
interface WebFixture {
  readonly path: string;
  readonly name: string;
  readonly id?: string;
  readonly kind?: string;
  /** `undefined` 用默认的 `@fenix/<id>/web/contribution`；`null` 表示完全不声明 `web`。 */
  readonly contribution?: string | null;
  /** 覆盖 `web.id`；默认等于模块 id，用于构造 `web.id` 重复用例。 */
  readonly webId?: string;
  /** `web` 字段的原始字面量，优先于 `contribution`，用于构造非字面量 / 非法形状用例。 */
  readonly webSource?: string;
  /** `exports["<key>"]` 的值；默认 `"./web/contribution.ts"`。 */
  readonly contributionExport?: string;
  /** 入口文件的仓库相对路径；默认 `<pkg>/web/contribution.ts`。 */
  readonly contributionFile?: string | null;
}

/** 临时 workspace 的装配 profile fixture。 */
interface ProfileFixture {
  readonly resources?: readonly string[];
  readonly web: readonly string[];
}

function defaultModuleId(fixture: WebFixture): string {
  const id = fixture.id ?? fixture.path.split("/").pop();
  if (!id) throw new Error(`fixture 缺少 id: ${fixture.path}`);
  return id;
}

function renderManifestSource(fixture: WebFixture): string {
  const moduleId = defaultModuleId(fixture);
  const webLine =
    fixture.webSource ??
    (fixture.contribution === null
      ? ""
      : `web: { id: "${fixture.webId ?? moduleId}", contribution: "${fixture.contribution ?? `@fenix/${moduleId}/web/contribution`}" },`);

  return [
    "export const moduleManifest = {",
    `  id: "${moduleId}",`,
    `  kind: "${fixture.kind ?? "resource"}",`,
    "  dependsOn: [],",
    webLine,
    "};",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** 在临时可信 workspace 中执行浏览器 web contribution 生成器。 */
async function withWorkspace(
  fixtures: readonly WebFixture[],
  profile: ProfileFixture,
  run: (root: string, profileFile: string, outputFile: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "fenix-web-contributions-"));
  const profileFile = join(root, "deploy/assembly/ce.json");
  const outputFile = join(root, "apps/generated/web-contributions.ts");
  try {
    for (const fixture of fixtures) {
      const packageRoot = join(root, fixture.path);
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, "fenix.module.ts"), renderManifestSource(fixture));
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: fixture.name,
          exports: { "./web/contribution": fixture.contributionExport ?? "./web/contribution.ts" },
        }),
      );

      if (fixture.contributionFile === null) continue;
      const entryFile = join(root, fixture.contributionFile ?? `${fixture.path}/web/contribution.ts`);
      await mkdir(dirname(entryFile), { recursive: true });
      await writeFile(entryFile, "export const webContribution = { navigation: [] };\n");
    }

    await mkdir(dirname(profileFile), { recursive: true });
    await writeFile(
      profileFile,
      JSON.stringify({
        identity: "identity",
        accessControl: "access-control",
        agentRuntime: "agent-runtime",
        webShell: "default",
        resources: profile.resources ?? fixtures.map(defaultModuleId),
        web: profile.web,
      }),
    );

    await run(root, profileFile, outputFile);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

/** 两个可用的 web 贡献 fixture：`alpha` 在前、`beta` 在后，用于验证顺序。 */
const ALPHA: WebFixture = { name: "@fenix/alpha", path: "packages/resources/alpha" };
const BETA: WebFixture = { name: "@fenix/beta", path: "packages/resources/beta" };

test("按 profile 的 web 顺序生成只含静态 import 的产物", async () => {
  await withWorkspace([ALPHA, BETA], { web: ["alpha", "beta"] }, async (root, profileFile, outputFile) => {
    const result = await generateWebContributions({ profileFile, repositoryRoot: root, outputFile });
    const source = await readFile(outputFile, "utf8");

    expect(result.contributionCount).toBe(2);
    expect(source).toContain('from "@fenix/alpha/web/contribution";');
    expect(source).toContain('from "@fenix/beta/web/contribution";');
    expect(source.indexOf("@fenix/alpha/web/contribution")).toBeLessThan(
      source.indexOf("@fenix/beta/web/contribution"),
    );
    // 产物只被浏览器消费，出现动态 import 就意味着选择集可能在运行期变化。
    expect(source).not.toContain("import(");
    expect(source).toContain("as const satisfies readonly WebAppContribution[]");
  });
});

test("profile 的 web 列表为空时产出空数组而不是报错", async () => {
  await withWorkspace([ALPHA], { web: [] }, async (root, profileFile, outputFile) => {
    const result = await generateWebContributions({ profileFile, repositoryRoot: root, outputFile });
    const source = await readFile(outputFile, "utf8");

    expect(result.contributionCount).toBe(0);
    expect(source).toContain("export const generatedWebContributions = []");
  });
});

test("profile 引用未注册的 web 模块时失败", async () => {
  await withWorkspace([ALPHA], { web: ["alpha", "ghost"] }, async (root, profileFile, outputFile) => {
    await expect(generateWebContributions({ profileFile, repositoryRoot: root, outputFile })).rejects.toThrow(
      "装配配置引用了未注册 Web 模块: ghost",
    );
  });
});

test("web 模块的服务端模块未在 profile 启用时失败", async () => {
  await withWorkspace([ALPHA, BETA], { resources: ["alpha"], web: ["beta"] }, async (root, profileFile, outputFile) => {
    await expect(generateWebContributions({ profileFile, repositoryRoot: root, outputFile })).rejects.toThrow(
      "Web 模块 beta 的服务端模块 beta 未启用",
    );
  });
});

test("manifest 未声明 web 时不被索引为 web 模块", async () => {
  await withWorkspace([{ ...ALPHA, contribution: null }], { web: ["alpha"] }, async (root, profileFile, outputFile) => {
    await expect(generateWebContributions({ profileFile, repositoryRoot: root, outputFile })).rejects.toThrow(
      "装配配置引用了未注册 Web 模块: alpha",
    );
  });
});

test("web.id 重复时失败", async () => {
  await withWorkspace(
    [ALPHA, { ...BETA, webId: "alpha" }],
    { web: ["alpha"] },
    async (root, profileFile, outputFile) => {
      await expect(generateWebContributions({ profileFile, repositoryRoot: root, outputFile })).rejects.toThrow(
        "Web 模块 ID 重复: alpha",
      );
    },
  );
});

test("contribution 未在包 exports 声明时失败", async () => {
  await withWorkspace(
    [{ ...ALPHA, contribution: "@fenix/alpha/web/panel" }],
    { web: ["alpha"] },
    async (root, profileFile, outputFile) => {
      await expect(generateWebContributions({ profileFile, repositoryRoot: root, outputFile })).rejects.toThrow(
        '未在 exports 声明 "./web/panel"',
      );
    },
  );
});

test("contribution 不是子路径说明符时失败", async () => {
  await withWorkspace(
    [{ ...ALPHA, contribution: "@fenix/alpha" }],
    { web: ["alpha"] },
    async (root, profileFile, outputFile) => {
      await expect(generateWebContributions({ profileFile, repositoryRoot: root, outputFile })).rejects.toThrow(
        '必须是 "@scope/pkg/subpath" 形态',
      );
    },
  );
});

test("exports 目标越出包目录时失败", async () => {
  await withWorkspace(
    [{ ...ALPHA, contributionExport: "../../shared/contribution.ts" }],
    { web: ["alpha"] },
    async (root, profileFile, outputFile) => {
      await expect(generateWebContributions({ profileFile, repositoryRoot: root, outputFile })).rejects.toThrow(
        "越出包目录",
      );
    },
  );
});

test("exports 指向的入口文件不存在时失败", async () => {
  await withWorkspace(
    [{ ...ALPHA, contributionFile: null }],
    { web: ["alpha"] },
    async (root, profileFile, outputFile) => {
      await expect(generateWebContributions({ profileFile, repositoryRoot: root, outputFile })).rejects.toThrow(
        "指向的入口文件不存在",
      );
    },
  );
});

test("web 声明不是对象字面量时失败", async () => {
  await withWorkspace(
    [{ ...ALPHA, webSource: 'web: buildWeb("alpha"),' }],
    { web: ["alpha"] },
    async (root, profileFile, outputFile) => {
      await expect(generateWebContributions({ profileFile, repositoryRoot: root, outputFile })).rejects.toThrow(
        "manifest 的 web 必须是对象字面量",
      );
    },
  );
});

test("profile 的 web 有重复项时失败", async () => {
  await withWorkspace([ALPHA], { web: ["alpha", "alpha"] }, async (root, profileFile, outputFile) => {
    await expect(generateWebContributions({ profileFile, repositoryRoot: root, outputFile })).rejects.toThrow(
      "装配 profile 的 web 有重复项: alpha",
    );
  });
});

test("check 模式在产物缺失或过期时失败，一致时通过", async () => {
  await withWorkspace([ALPHA, BETA], { web: ["alpha"] }, async (root, profileFile, outputFile) => {
    await expect(
      generateWebContributions({ check: true, profileFile, repositoryRoot: root, outputFile }),
    ).rejects.toThrow("浏览器 web contribution 产物不存在");

    await generateWebContributions({ profileFile, repositoryRoot: root, outputFile });
    await expect(
      generateWebContributions({ check: true, profileFile, repositoryRoot: root, outputFile }),
    ).resolves.toEqual({ contributionCount: 1, outputFile });

    // profile 扩大选择集后同一份产物即为过期：check 必须发现，而不是静默沿用旧选择。
    await writeFile(
      profileFile,
      JSON.stringify({
        identity: "identity",
        accessControl: "access-control",
        agentRuntime: "agent-runtime",
        webShell: "default",
        resources: ["alpha", "beta"],
        web: ["alpha", "beta"],
      }),
    );
    await expect(
      generateWebContributions({ check: true, profileFile, repositoryRoot: root, outputFile }),
    ).rejects.toThrow("浏览器 web contribution 产物已过期");
  });
});
