import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

const GENERATED_HEADER = "// 此文件由 scripts/generate-module-registry.ts 生成，请勿手动编辑。";
const PACKAGE_NAME_PATTERN = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

/** registry 生成或检查的配置。 */
export interface GenerateModuleRegistryOptions {
  readonly repositoryRoot?: string;
  readonly outputFile?: string;
  readonly check?: boolean;
}

/** registry 生成结果，供 CLI 和测试报告确定性模块数量。 */
export interface GenerateModuleRegistryResult {
  readonly moduleCount: number;
  readonly outputFile: string;
}

interface DiscoveredModule {
  readonly manifestFile: string;
  readonly packageName: string;
}

function normalizePath(filePath: string): string {
  return filePath.split(sep).join("/");
}

async function discoverModules(repositoryRoot: string): Promise<readonly DiscoveredModule[]> {
  const manifestFiles = await Array.fromAsync(
    new Bun.Glob("packages/**/fenix.module.ts").scan({ cwd: repositoryRoot, onlyFiles: true }),
  );
  manifestFiles.sort();

  const modules = await Promise.all(
    manifestFiles.map(async (manifestFile): Promise<DiscoveredModule> => {
      const packageJsonPath = resolve(repositoryRoot, dirname(manifestFile), "package.json");
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { name?: unknown };
      const normalizedManifestFile = normalizePath(manifestFile);
      if (typeof packageJson.name !== "string" || !PACKAGE_NAME_PATTERN.test(packageJson.name)) {
        throw new Error(`模块缺少 package name: ${normalizedManifestFile}`);
      }
      return { manifestFile: normalizedManifestFile, packageName: packageJson.name };
    }),
  );

  modules.sort((left, right) =>
    left.packageName < right.packageName ? -1 : left.packageName > right.packageName ? 1 : 0,
  );
  for (let index = 1; index < modules.length; index += 1) {
    if (modules[index - 1]?.packageName === modules[index]?.packageName) {
      throw new Error(`模块 package name 重复: ${modules[index]?.packageName}`);
    }
  }
  return modules;
}

function renderRegistry(modules: readonly DiscoveredModule[]): string {
  const manifestImports = modules.map(
    (module, index) => `import { moduleManifest as manifest${index} } from "${module.packageName}/module";`,
  );
  const manifestNames = modules.map((_, index) => `manifest${index}`).join(", ");
  return [
    GENERATED_HEADER,
    "",
    ...manifestImports,
    'import type { ModuleManifest } from "@fenix/platform-sdk";',
    "",
    "/** 构建期收集的可信模块集合；应用启动时只能从该集合选择模块。 */",
    `export const generatedModuleManifests = [${manifestNames}] as const satisfies readonly ModuleManifest[];`,
    "",
  ].join("\n");
}

/** 扫描可信 workspace manifest，并生成或校验只含静态 import 的 registry。 */
export async function generateModuleRegistry(
  options: GenerateModuleRegistryOptions = {},
): Promise<GenerateModuleRegistryResult> {
  const repositoryRoot = resolve(options.repositoryRoot ?? resolve(import.meta.dir, ".."));
  const outputFile = resolve(options.outputFile ?? resolve(repositoryRoot, "apps/generated/module-registry.ts"));
  const modules = await discoverModules(repositoryRoot);
  const registrySource = renderRegistry(modules);

  if (options.check) {
    let currentSource: string;
    try {
      currentSource = await readFile(outputFile, "utf8");
    } catch (error) {
      throw new Error(`静态 module registry 不存在: ${normalizePath(relative(repositoryRoot, outputFile))}`, {
        cause: error,
      });
    }
    if (currentSource !== registrySource) {
      throw new Error("静态 module registry 已过期，请运行 bun run generate:module-registry");
    }
  } else {
    await mkdir(dirname(outputFile), { recursive: true });
    await writeFile(outputFile, registrySource);
  }

  return { moduleCount: modules.length, outputFile };
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const result = await generateModuleRegistry({ check });
  console.log(`${check ? "已验证" : "已生成"} ${result.moduleCount} 个模块 manifest: ${result.outputFile}`);
}
