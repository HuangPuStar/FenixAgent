import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const outputFile = resolve(repositoryRoot, "apps/generated/module-registry.ts");

/**
 * 只扫描本仓库受版本控制的 module manifest；产物使用静态 import，运行时不会扫描或动态加载。
 * EE 生成器会额外扫描其固定版本的 CE submodule，见同路径脚本。
 */
async function generateModuleRegistry() {
  const manifestFiles = await Array.fromAsync(
    new Bun.Glob("packages/**/fenix.module.ts").scan({ cwd: repositoryRoot }),
  );
  manifestFiles.sort();
  if (manifestFiles.length === 0) throw new Error("未发现任何 fenix.module.ts");
  const modules = manifestFiles.map((file) => {
    const packageRoot = resolve(repositoryRoot, dirname(file));
    const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")) as { name?: string };
    if (!packageJson.name) throw new Error(`模块缺少 package name: ${file}`);
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
    "/** 构建期收集的可信模块集合；apps 在启动时按 assembly profile 选择其中的模块。 */",
    `export const generatedModuleManifests = [${modules.map((_, index) => `manifest${index}`).join(", ")}] as const;`,
    "",
  ].join("\n");
  mkdirSync(dirname(outputFile), { recursive: true });
  await Bun.write(outputFile, registrySource);
  console.log(`已生成 ${modules.length} 个 CE 模块 manifest: ${outputFile}`);
}

await generateModuleRegistry();
