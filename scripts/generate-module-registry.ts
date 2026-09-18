import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import ts from "typescript";

import { getImportReferences, parseTypeScriptSource } from "./lib/import-references";

const GENERATED_HEADER = "// 此文件由 scripts/generate-module-registry.ts 生成，请勿手动编辑。";
const PACKAGE_NAME_PATTERN = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
/** 与 `@fenix/platform-sdk` 的 `moduleIdSchema` 保持一致。 */
const MODULE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MANIFEST_EXPORT_NAME = "moduleManifest";
const PACKAGE_MODULE_EXPORT_KEY = "./module";

/** 受版本控制的 manifest 扫描根：workspace 包与应用骨架。 */
const PACKAGE_MANIFEST_GLOB = "packages/**/fenix.module.ts";
const APP_MANIFEST_GLOB = "apps/*/fenix.module.ts";

/** 声明这些字段即意味着 manifest 携带运行期代码，与「纯元数据描述符」互斥。 */
const RUNTIME_MANIFEST_FIELDS = ["create", "contributions", "web", "envDefinitions"] as const;

/**
 * 生成器认可的模块类别，必须与 `ModuleKind` 完全一致。
 *
 * 之所以在构建脚本里重复一份：生成器运行时不依赖 `@fenix/platform-sdk`。两者的漂移由
 * `scripts/__tests__/module-registry-generator.test.ts` 的类型穷尽断言守护。
 */
export const MODULE_KINDS = ["access-control", "agent-runtime", "identity", "resource", "web-shell"] as const;

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

/** 从 manifest 源码静态读出的描述符字段；生成器不执行 manifest。 */
interface ManifestDescriptor {
  readonly id: string;
  readonly kind: string;
  readonly dependsOn: readonly string[];
}

interface DiscoveredModule {
  /** 仓库相对 POSIX 路径，用于稳定排序与错误信息。 */
  readonly manifestFile: string;
  /** manifest 所在包目录，仓库相对 POSIX 路径。 */
  readonly packageDirectory: string;
  readonly packageName: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly descriptor: ManifestDescriptor;
  /** `packages/**` 走公开 `exports["./module"]`；`apps/*` 由生成物相对导入。 */
  readonly location: "package" | "app";
}

function normalizePath(filePath: string): string {
  return filePath.split(sep).join("/");
}

async function collectManifestFiles(repositoryRoot: string, pattern: string): Promise<string[]> {
  const files = await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: repositoryRoot, onlyFiles: true }));
  return files.map(normalizePath);
}

async function readPackageManifest(
  repositoryRoot: string,
  packageDirectory: string,
  manifestFile: string,
): Promise<{ name: string; dependencies: Record<string, string>; exports: unknown }> {
  const packageJsonPath = resolve(repositoryRoot, packageDirectory, "package.json");
  let source: string;
  try {
    source = await readFile(packageJsonPath, "utf8");
  } catch (error) {
    throw new Error(`模块所在目录缺少 package.json: ${packageDirectory} (${manifestFile})`, { cause: error });
  }

  const parsed = JSON.parse(source) as { dependencies?: unknown; exports?: unknown; name?: unknown };
  if (typeof parsed.name !== "string" || !PACKAGE_NAME_PATTERN.test(parsed.name)) {
    throw new Error(`模块缺少 package name: ${manifestFile}`);
  }

  const dependencies: Record<string, string> = {};
  if (parsed.dependencies !== undefined) {
    if (typeof parsed.dependencies !== "object" || parsed.dependencies === null || Array.isArray(parsed.dependencies)) {
      throw new Error(`package.json 的 dependencies 必须是对象: ${packageDirectory}`);
    }
    for (const [name, range] of Object.entries(parsed.dependencies)) {
      if (typeof range === "string") dependencies[name] = range;
    }
  }

  return { dependencies, exports: parsed.exports, name: parsed.name };
}

/** 剥离 `satisfies` / `as` / 括号包装，取出对象字面量。 */
function unwrapObjectLiteral(expression: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined {
  let node = expression;
  while (node && (ts.isSatisfiesExpression(node) || ts.isAsExpression(node) || ts.isParenthesizedExpression(node))) {
    node = node.expression;
  }
  return node && ts.isObjectLiteralExpression(node) ? node : undefined;
}

function findManifestObject(sourceFile: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== MANIFEST_EXPORT_NAME) continue;
      return unwrapObjectLiteral(declaration.initializer);
    }
  }
  return undefined;
}

function findProperty(
  objectLiteral: ts.ObjectLiteralExpression,
  propertyName: string,
): ts.PropertyAssignment | undefined {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    if ((ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === propertyName) return property;
  }
  return undefined;
}

function readStringProperty(
  objectLiteral: ts.ObjectLiteralExpression,
  propertyName: string,
  manifestFile: string,
): string | undefined {
  const property = findProperty(objectLiteral, propertyName);
  if (!property) return undefined;
  if (!ts.isStringLiteralLike(property.initializer)) {
    throw new Error(`manifest 的 ${propertyName} 必须是字符串字面量: ${manifestFile}`);
  }
  return property.initializer.text;
}

/**
 * 静态读取 manifest 描述符。
 *
 * 只接受字面量：生成器不执行 manifest 也不做常量折叠，任何计算值都会让校验结论不可靠。
 */
function readManifestDescriptor(sourceFile: ts.SourceFile, manifestFile: string): ManifestDescriptor {
  const objectLiteral = findManifestObject(sourceFile);
  if (!objectLiteral) {
    throw new Error(`manifest 必须导出字面量描述符 "export const moduleManifest = { ... }": ${manifestFile}`);
  }

  const id = readStringProperty(objectLiteral, "id", manifestFile);
  if (id === undefined || !MODULE_ID_PATTERN.test(id)) {
    throw new Error(`manifest 必须声明合法模块 ID 字面量 id: ${manifestFile}`);
  }

  const kind = readStringProperty(objectLiteral, "kind", manifestFile);
  if (kind === undefined || !(MODULE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`manifest 的 kind 必须是 ${MODULE_KINDS.join(" | ")} 之一: ${manifestFile}`);
  }

  const dependsOnProperty = findProperty(objectLiteral, "dependsOn");
  if (!dependsOnProperty || !ts.isArrayLiteralExpression(dependsOnProperty.initializer)) {
    throw new Error(`manifest 必须声明模块 ID 字面量数组 dependsOn: ${manifestFile}`);
  }
  const dependsOn = dependsOnProperty.initializer.elements.map((element) => {
    if (!ts.isStringLiteralLike(element) || !MODULE_ID_PATTERN.test(element.text)) {
      throw new Error(`manifest 的 dependsOn 只能包含模块 ID 字面量: ${manifestFile}`);
    }
    return element.text;
  });

  return { dependsOn, id, kind };
}

/** 声明了运行期字段的 manifest 不能再被当作纯元数据描述符引入 registry。 */
function findRuntimeFields(objectLiteral: ts.ObjectLiteralExpression): string[] {
  return RUNTIME_MANIFEST_FIELDS.filter((field) => findProperty(objectLiteral, field) !== undefined);
}

/** 从 `exports` 字段解析 `./module` 的目标路径，兼容字符串与条件对象两种写法。 */
function readModuleExportTarget(exportsField: unknown): string | undefined {
  if (typeof exportsField !== "object" || exportsField === null || Array.isArray(exportsField)) return undefined;

  const entry = (exportsField as Record<string, unknown>)[PACKAGE_MODULE_EXPORT_KEY];
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || entry === null) return undefined;

  for (const condition of ["types", "import", "require", "node", "default"]) {
    const target = (entry as Record<string, unknown>)[condition];
    if (typeof target === "string") return target;
  }
  return undefined;
}

/**
 * `web-shell` manifest 会被生成物静态引入 server 装配图，必须保持零运行期引用。
 *
 * 本断言是「Shell 落 `apps/web`」这一设计修订成立的前提：没有它，相对导入会让浏览器依赖
 * 沿 registry 进入 server 的编译与运行图。
 */
function assertWebShellIsPureMetadata(sourceFile: ts.SourceFile, manifestFile: string): void {
  for (const reference of getImportReferences(sourceFile)) {
    if (reference.kind !== "type") {
      throw new Error(
        `web-shell manifest 只能使用 import type，不得出现值导入或再导出 ("${reference.specifier}"): ${manifestFile}`,
      );
    }
  }

  const objectLiteral = findManifestObject(sourceFile);
  const runtimeFields = objectLiteral ? findRuntimeFields(objectLiteral) : [];
  if (runtimeFields.length > 0) {
    throw new Error(`web-shell manifest 不得声明运行期字段 ${runtimeFields.join(", ")}: ${manifestFile}`);
  }
}

/** 模块包必须把 manifest 暴露为稳定公开入口，否则 registry 无法用静态 import 引用它。 */
function assertModuleExport(
  repositoryRoot: string,
  packageDirectory: string,
  exportsField: unknown,
  manifestFile: string,
): void {
  const target = readModuleExportTarget(exportsField);
  if (target === undefined) {
    throw new Error(`模块包必须在 package.json 声明 exports["./module"] 指向 manifest: ${packageDirectory}`);
  }

  const packageDirectoryAbsolute = resolve(repositoryRoot, packageDirectory);
  const expectedTarget = normalizePath(relative(packageDirectoryAbsolute, resolve(repositoryRoot, manifestFile)));
  const resolvedTarget = normalizePath(relative(packageDirectoryAbsolute, resolve(packageDirectoryAbsolute, target)));
  if (resolvedTarget !== expectedTarget) {
    throw new Error(`exports["./module"] 必须指向 ${expectedTarget}，实际指向 ${resolvedTarget}: ${packageDirectory}`);
  }
}

/**
 * 校验 `dependsOn` 是本包显式声明的编译依赖。
 *
 * 只做单向校验：有编译依赖不必然在 profile 中同时启用，所以不要求编译依赖都出现在
 * `dependsOn` 中。装配依赖必须落在 `workspace:` 区间上，否则发布形态会指向错误版本。
 */
function assertDependsOnDeclared(modules: readonly DiscoveredModule[]): void {
  const packageNameByModuleId = new Map<string, string>();
  for (const module of modules) {
    const owner = packageNameByModuleId.get(module.descriptor.id);
    if (owner !== undefined) {
      throw new Error(`模块 ID 重复: ${module.descriptor.id} (${owner} 与 ${module.packageName})`);
    }
    packageNameByModuleId.set(module.descriptor.id, module.packageName);
  }

  for (const module of modules) {
    for (const dependencyId of module.descriptor.dependsOn) {
      if (dependencyId === module.descriptor.id) {
        throw new Error(`模块 ${module.descriptor.id} 不能依赖自身: ${module.manifestFile}`);
      }

      const dependencyPackage = packageNameByModuleId.get(dependencyId);
      if (dependencyPackage === undefined) {
        throw new Error(`模块 ${module.descriptor.id} 的 dependsOn 引用了未注册模块 ${dependencyId}`);
      }

      const range = module.dependencies[dependencyPackage];
      if (range === undefined || !range.startsWith("workspace:")) {
        throw new Error(
          `模块 ${module.descriptor.id} 依赖 ${dependencyId}，但 ${module.packageName} 的 package.json 未声明编译依赖 "${dependencyPackage}": "workspace:*"`,
        );
      }
    }
  }
}

/** `packages/**` 走公开导出，`apps/*` 由生成物相对导入，避免引入 apps → apps 的包依赖。 */
function renderImportSpecifier(module: DiscoveredModule, repositoryRoot: string, outputDirectory: string): string {
  if (module.location === "package") return `${module.packageName}/module`;

  const relativePath = normalizePath(relative(outputDirectory, resolve(repositoryRoot, module.manifestFile)));
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function renderRegistry(modules: readonly DiscoveredModule[], repositoryRoot: string, outputDirectory: string): string {
  const manifestImports = modules.map(
    (module, index) =>
      `import { moduleManifest as manifest${index} } from "${renderImportSpecifier(module, repositoryRoot, outputDirectory)}";`,
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

async function discoverModules(repositoryRoot: string): Promise<readonly DiscoveredModule[]> {
  const [packageManifests, appManifests] = await Promise.all([
    collectManifestFiles(repositoryRoot, PACKAGE_MANIFEST_GLOB),
    collectManifestFiles(repositoryRoot, APP_MANIFEST_GLOB),
  ]);

  const candidates = [
    ...packageManifests.map((manifestFile) => ({ location: "package" as const, manifestFile })),
    ...appManifests.map((manifestFile) => ({ location: "app" as const, manifestFile })),
  ].sort((left, right) =>
    left.manifestFile < right.manifestFile ? -1 : left.manifestFile > right.manifestFile ? 1 : 0,
  );

  return Promise.all(
    candidates.map(async ({ manifestFile, location }): Promise<DiscoveredModule> => {
      const packageDirectory = normalizePath(dirname(manifestFile));
      const packageManifest = await readPackageManifest(repositoryRoot, packageDirectory, manifestFile);

      const sourceText = await readFile(resolve(repositoryRoot, manifestFile), "utf8");
      const sourceFile = parseTypeScriptSource(manifestFile, sourceText);
      const descriptor = readManifestDescriptor(sourceFile, manifestFile);

      if (location === "app") {
        if (descriptor.kind !== "web-shell") {
          throw new Error(`apps 下的 manifest 只能是 web-shell 类别，实际为 ${descriptor.kind}: ${manifestFile}`);
        }
        assertWebShellIsPureMetadata(sourceFile, manifestFile);
      } else if (descriptor.kind === "web-shell") {
        // WebShell 是应用级组合而不是资源模块，见 ce-ee-engineering-standards §4.1。
        throw new Error(`web-shell manifest 必须位于 apps/ 而不是 packages/: ${manifestFile}`);
      }

      if (location === "package") {
        assertModuleExport(repositoryRoot, packageDirectory, packageManifest.exports, manifestFile);
      }

      return {
        dependencies: packageManifest.dependencies,
        descriptor,
        location,
        manifestFile,
        packageDirectory,
        packageName: packageManifest.name,
      };
    }),
  );
}

/** 扫描受版本控制的 workspace manifest，并生成或校验只含静态 import 的 registry。 */
export async function generateModuleRegistry(
  options: GenerateModuleRegistryOptions = {},
): Promise<GenerateModuleRegistryResult> {
  const repositoryRoot = resolve(options.repositoryRoot ?? resolve(import.meta.dir, ".."));
  const outputFile = resolve(options.outputFile ?? resolve(repositoryRoot, "apps/generated/module-registry.ts"));
  const discovered = await discoverModules(repositoryRoot);
  assertDependsOnDeclared(discovered);

  // 排序必须基于 UTF-16 代码单元：生成的 registry 会进入版本控制，不能受构建机 locale 影响。
  const modules = [...discovered].sort((left, right) =>
    left.packageName < right.packageName ? -1 : left.packageName > right.packageName ? 1 : 0,
  );
  for (let index = 1; index < modules.length; index += 1) {
    if (modules[index - 1]?.packageName === modules[index]?.packageName) {
      throw new Error(`模块 package name 重复: ${modules[index]?.packageName}`);
    }
  }

  const registrySource = renderRegistry(modules, repositoryRoot, dirname(outputFile));

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
