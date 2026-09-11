import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateModuleRegistry } from "../generate-module-registry";

/** 在临时可信 workspace 中执行 registry 生成器。 */
async function withWorkspace(
  packages: readonly { path: string; name?: string }[],
  run: (root: string, outputFile: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "fenix-module-registry-"));
  const outputFile = join(root, "apps/generated/module-registry.ts");
  try {
    for (const modulePackage of packages) {
      const packageRoot = join(root, "packages", modulePackage.path);
      await mkdir(packageRoot, { recursive: true });
      await writeFile(join(packageRoot, "fenix.module.ts"), "export const moduleManifest = {};\n");
      await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: modulePackage.name }));
    }
    await run(root, outputFile);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

// registry 使用公开 package export，排序不受目录枚举顺序影响。
test("生成按 package name 排序的静态 import registry", async () => {
  await withWorkspace(
    [
      { path: "resources/agent-config", name: "@fenix/agent-config" },
      { path: "platform/access-control", name: "@fenix/access-control" },
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

// 缺少 package name 时无法生成稳定公开 import，必须显式失败。
test("拒绝缺少 package name 的 manifest", async () => {
  await withWorkspace([{ path: "platform/broken" }], async (root, outputFile) => {
    await expect(generateModuleRegistry({ repositoryRoot: root, outputFile })).rejects.toThrow(
      "模块缺少 package name: packages/platform/broken/fenix.module.ts",
    );
  });
});

// 两个 manifest 指向同一公开入口会产生不确定注册项，生成阶段必须拒绝。
test("拒绝重复 package name", async () => {
  await withWorkspace(
    [
      { path: "platform/first", name: "@fenix/duplicate" },
      { path: "platform/second", name: "@fenix/duplicate" },
    ],
    async (root, outputFile) => {
      await expect(generateModuleRegistry({ repositoryRoot: root, outputFile })).rejects.toThrow(
        "模块 package name 重复: @fenix/duplicate",
      );
    },
  );
});

// 排序必须基于 UTF-16 代码单元，不得受构建机 locale/ICU 标点权重影响。
test("使用跨环境稳定的代码点顺序生成 registry", async () => {
  await withWorkspace(
    [
      { path: "platform/underscore", name: "@fenix/a_b" },
      { path: "platform/dot", name: "@fenix/a.b" },
      { path: "platform/dash", name: "@fenix/a-b" },
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
    [{ path: "platform/access-control", name: "@fenix/access-control" }],
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
