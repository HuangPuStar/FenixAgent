// 受版本控制模块 manifest 的**静态**读取原语：不执行 manifest，只按 AST 读字面量。
//
// 抽出的原因：`generate-module-registry.ts`（server 装配 registry）与
// `generate-web-contributions.ts`（浏览器 web contribution 产物）必须对同一批 `fenix.module.ts`
// 得出同一套结论——同一个 `id`、同一个 `kind`、同一个 `web` 载荷。两处各写一份 AST 读取会让
// 「字面量才可信」这条判定在两边漂移。
//
// 「不执行 manifest」是硬约束而不是实现细节：manifest 的初始值可能是 `import("./src/module")`
// 这类惰性构造，执行它等于在生成期就把 Drizzle、Elysia 与 agent-runtime 拖进脚本进程；
// 同时任何计算值都会让校验结论不可靠（生成物进了版本控制，结论必须可复现）。
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

import ts from "typescript";

import { parseTypeScriptSource } from "./import-references";

export const MANIFEST_EXPORT_NAME = "moduleManifest";

/** 与 `@fenix/platform-sdk` 的 `moduleIdSchema` 保持一致。 */
export const MODULE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** 与 `@fenix/platform-sdk` 的 `moduleIdSchema` 一致，用于 `@scope/name` 形态的包名。 */
export const PACKAGE_NAME_PATTERN = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;

/**
 * 生成器认可的模块类别，必须与 `ModuleKind` 完全一致。
 *
 * 之所以在构建脚本里重复一份：生成器运行时不依赖 `@fenix/platform-sdk`。两者的漂移由
 * `scripts/__tests__/module-registry-generator.test.ts` 的类型穷尽断言守护。
 */
export const MODULE_KINDS = ["access-control", "agent-runtime", "identity", "resource", "web-shell"] as const;

/** 声明这些字段即意味着 manifest 携带运行期代码，与「纯元数据描述符」互斥。 */
export const RUNTIME_MANIFEST_FIELDS = ["create", "contributions", "web", "envDefinitions"] as const;

/** 从 manifest 源码静态读出的描述符字段。 */
export interface ManifestDescriptor {
  readonly id: string;
  readonly kind: string;
  readonly dependsOn: readonly string[];
}

/** manifest 所在位置：`packages/**` 走公开 `exports["./module"]`；`apps/*` 由生成物相对导入。 */
export type ManifestLocation = "package" | "app";

/** 一个待读取的 manifest 候选。 */
export interface ManifestCandidate {
  /** 仓库相对 POSIX 路径，用于稳定排序与错误信息。 */
  readonly manifestFile: string;
  readonly location: ManifestLocation;
}

/** manifest 及其所在包的静态事实；读取过程不执行任何模块。 */
export interface ManifestSource {
  readonly candidate: ManifestCandidate;
  /** manifest 所在包目录，仓库相对 POSIX 路径。 */
  readonly packageDirectory: string;
  readonly packageName: string;
  readonly dependencies: Readonly<Record<string, string>>;
  /** package.json 的 `exports` 字段原值，由调用方按自己的契约解读。 */
  readonly exportsField: unknown;
  readonly descriptor: ManifestDescriptor;
  /** 声明的浏览器载荷；未声明为 undefined。 */
  readonly web: WebContributionDeclaration | undefined;
  readonly sourceFile: ts.SourceFile;
}

export function normalizePath(filePath: string): string {
  return filePath.split(sep).join("/");
}

/** 按 glob 收集仓库内文件，返回仓库相对 POSIX 路径；不做排序，调用方按自己的稳定性要求处理。 */
export async function collectRepositoryFiles(repositoryRoot: string, pattern: string): Promise<string[]> {
  const files = await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: repositoryRoot, onlyFiles: true }));
  return files.map(normalizePath);
}

/**
 * 收集受版本控制的 manifest 候选，按路径字典序（UTF-16 代码单元）稳定排序。
 *
 * 排序必须基于代码单元而不是 `localeCompare`：生成物会进入版本控制，不能受构建机 locale 影响。
 */
export async function collectManifestCandidates(
  repositoryRoot: string,
  patterns: { readonly packages: string; readonly apps: string },
): Promise<readonly ManifestCandidate[]> {
  const [packageManifests, appManifests] = await Promise.all([
    collectRepositoryFiles(repositoryRoot, patterns.packages),
    collectRepositoryFiles(repositoryRoot, patterns.apps),
  ]);

  return [
    ...packageManifests.map((manifestFile) => ({ location: "package" as const, manifestFile })),
    ...appManifests.map((manifestFile) => ({ location: "app" as const, manifestFile })),
  ].sort((left, right) =>
    left.manifestFile < right.manifestFile ? -1 : left.manifestFile > right.manifestFile ? 1 : 0,
  );
}

async function readPackageManifest(
  repositoryRoot: string,
  packageDirectory: string,
  manifestFile: string,
): Promise<{ name: string; dependencies: Record<string, string>; exportsField: unknown }> {
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

  return { dependencies, exportsField: parsed.exports, name: parsed.name };
}

/** 剥离 `satisfies` / `as` / 括号包装，取出对象字面量。 */
export function unwrapObjectLiteral(expression: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined {
  let node = expression;
  while (node && (ts.isSatisfiesExpression(node) || ts.isAsExpression(node) || ts.isParenthesizedExpression(node))) {
    node = node.expression;
  }
  return node && ts.isObjectLiteralExpression(node) ? node : undefined;
}

export function findManifestObject(sourceFile: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== MANIFEST_EXPORT_NAME) continue;
      return unwrapObjectLiteral(declaration.initializer);
    }
  }
  return;
}

/** 取描述符对象字面量；缺失即抛错。读取 `id` / `kind` / `web` 等多处共用同一次定位。 */
function requireManifestObject(sourceFile: ts.SourceFile, manifestFile: string): ts.ObjectLiteralExpression {
  const objectLiteral = findManifestObject(sourceFile);
  if (!objectLiteral) {
    throw new Error(`manifest 必须导出字面量描述符 "export const moduleManifest = { ... }": ${manifestFile}`);
  }
  return objectLiteral;
}

export function findProperty(
  objectLiteral: ts.ObjectLiteralExpression,
  propertyName: string,
): ts.PropertyAssignment | undefined {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    if ((ts.isIdentifier(name) || ts.isStringLiteralLike(name)) && name.text === propertyName) return property;
  }
  return;
}

export function readStringProperty(
  objectLiteral: ts.ObjectLiteralExpression,
  propertyName: string,
  manifestFile: string,
): string | undefined {
  const property = findProperty(objectLiteral, propertyName);
  if (!property) return;
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
export function readManifestDescriptor(sourceFile: ts.SourceFile, manifestFile: string): ManifestDescriptor {
  const objectLiteral = requireManifestObject(sourceFile, manifestFile);

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
export function findRuntimeFields(objectLiteral: ts.ObjectLiteralExpression): string[] {
  return RUNTIME_MANIFEST_FIELDS.filter((field) => findProperty(objectLiteral, field) !== undefined);
}

/**
 * 从 `exports` 字段解析某个子路径的入口目标，兼容字符串与条件对象两种写法。
 *
 * 条件的优先级顺序即 package.json 的解析顺序（`types` → `import` → `require` → `node` → `default`），
 * 生成器只需要一个可用的入口，不区分条件类型。
 */
export function readExportTarget(exportsField: unknown, exportKey: string): string | undefined {
  if (typeof exportsField !== "object" || exportsField === null || Array.isArray(exportsField)) return;

  const entry = (exportsField as Record<string, unknown>)[exportKey];
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || entry === null) return;

  for (const condition of ["types", "import", "require", "node", "default"]) {
    const target = (entry as Record<string, unknown>)[condition];
    if (typeof target === "string") return target;
  }
  return;
}

/**
 * manifest 声明的浏览器载荷：`web.id` 与**惰性入口说明符字符串**。
 *
 * `contribution` 是说明符而不是被求值的载荷：生成期不能 import 浏览器入口，否则 `lucide-react` 与
 * React 会被拖进脚本进程，服务端装配图也会顺带拿到浏览器依赖。因此它必须是字面量——非字面量无法
 * 在「不执行 manifest」的前提下定位入口，这条限制与 `readManifestDescriptor` 同因。
 */
export interface WebContributionDeclaration {
  readonly id: string;
  /** 浏览器入口说明符，形如 `@fenix/<pkg>/web/contribution`。 */
  readonly contribution: string;
}

/** 静态读取 `web` 声明；未声明返回 undefined，声明了但形状不合法则抛错。 */
export function readWebContribution(
  objectLiteral: ts.ObjectLiteralExpression,
  manifestFile: string,
): WebContributionDeclaration | undefined {
  const property = findProperty(objectLiteral, "web");
  if (!property) return;

  const webLiteral = unwrapObjectLiteral(property.initializer);
  if (!webLiteral) throw new Error(`manifest 的 web 必须是对象字面量: ${manifestFile}`);

  const id = readStringProperty(webLiteral, "id", manifestFile);
  if (id === undefined || !MODULE_ID_PATTERN.test(id)) {
    throw new Error(`manifest 的 web.id 必须是合法模块 ID 字面量: ${manifestFile}`);
  }

  const contribution = readStringProperty(webLiteral, "contribution", manifestFile);
  if (contribution === undefined) {
    throw new Error(`manifest 的 web.contribution 必须是入口说明符字符串字面量: ${manifestFile}`);
  }

  return { contribution, id };
}

/** 读取一个 manifest 候选的全部静态事实。 */
export async function loadManifestSource(
  repositoryRoot: string,
  candidate: ManifestCandidate,
): Promise<ManifestSource> {
  const packageDirectory = normalizePath(candidate.manifestFile).split("/").slice(0, -1).join("/");
  const packageManifest = await readPackageManifest(repositoryRoot, packageDirectory, candidate.manifestFile);

  const sourceText = await readFile(resolve(repositoryRoot, candidate.manifestFile), "utf8");
  const sourceFile = parseTypeScriptSource(candidate.manifestFile, sourceText);

  return {
    candidate,
    dependencies: packageManifest.dependencies,
    descriptor: readManifestDescriptor(sourceFile, candidate.manifestFile),
    exportsField: packageManifest.exportsField,
    packageDirectory,
    packageName: packageManifest.name,
    sourceFile,
    web: readWebContribution(requireManifestObject(sourceFile, candidate.manifestFile), candidate.manifestFile),
  };
}
