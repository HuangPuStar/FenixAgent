import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const ceRepositoryRoot = resolve(repositoryRoot, "../ce");
const outputFile = resolve(repositoryRoot, "apps/generated/module-registry.ts");

/**
 * demo 从相邻 CE 目录收集；真实 EE 从 vendor/fenix-ce/packages 收集固定 submodule 提交。
 * 扫描只发生在构建期，生成物只含静态 import。
 */
async function generateModuleRegistry() {
  const roots = [repositoryRoot, ceRepositoryRoot];
  const manifestFiles = (
    await Promise.all(
      roots.map(async (root) =>
        Array.fromAsync(new Bun.Glob("packages/**/fenix.module.ts").scan({ cwd: root })).then((files) =>
          files.map((file) => resolve(root, file)),
        ),
      ),
    )
  ).flat();
  manifestFiles.sort();
  if (manifestFiles.length === 0) throw new Error("未发现任何 fenix.module.ts");
  const modules = manifestFiles.map((sourceFile) => {
    const packageRoot = dirname(sourceFile);
    const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as { name?: string };
    if (!packageJson.name) throw new Error(`模块缺少 package name: ${sourceFile}`);
    return { packageName: packageJson.name };
  });
  modules.sort((left, right) => left.packageName.localeCompare(right.packageName));
  const imports = modules.map(
    (module, index) => `import { moduleManifest as manifest${index} } from "${module.packageName}/module";`,
  );
  const registrySource = [
    "// 此文件由 scripts/generate-module-registry.ts 生成，请勿手动编辑。",
    "",
    ...imports,
    "",
    "/** 构建期收集的 EE 与固定 CE submodule 模块集合。 */",
    `export const generatedModuleManifests = [${modules.map((_, index) => `manifest${index}`).join(", ")}] as const;`,
    "",
  ].join("\n");
  mkdirSync(dirname(outputFile), { recursive: true });
  await Bun.write(outputFile, registrySource);
  console.log(`已生成 ${modules.length} 个 EE/CE 模块 manifest: ${outputFile}`);
}

await generateModuleRegistry();
