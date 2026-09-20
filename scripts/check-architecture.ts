/**
 * 检查无法由 TypeScript 或 Biome 表达的项目架构边界。
 *
 * 规则分两类（见 `lib/architecture-rules.ts` 的说明）：硬红线要求零违规；边界规则把违规归一成
 * 「规则 + 来源包 + 目标包」，由 `scripts/architecture/exceptions.json` 判定——存量债务登记在
 * 台账里，只有新增才失败，且台账里已经不再违规的条目会反过来要求删除。
 *
 * 与 `scripts/check-dependency-boundaries.ts` 的分工：那一边跑 dependency-cruiser 的路径规则
 * （循环、包类别方向），这一边跑需要 AST 与 `package.json` 才能判定的规则。两边共用同一份台账。
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";
import { createBoundaryRules } from "./lib/architecture-boundary-rules";
import { exceptionFingerprint, loadArchitectureLedger } from "./lib/architecture-exceptions";
import {
  type ArchitectureDiagnostic,
  type ArchitectureRule,
  createImportRule,
  isTestFile,
  type RuleContext,
} from "./lib/architecture-rules";
import { createSpecifierPackageResolver, loadWorkspacePackages, normalizePath } from "./lib/workspace-packages";

/**
 * 扫描根。
 *
 * `apps/web` 取整个目录而不是 `src/` 与 `components/` 两个子目录：`fenix.module.ts` 与
 * `vite.config.ts` 就在应用根，漏掉前者会让 web-shell manifest 的 workspace 依赖无人校验。
 */
const SOURCE_ROOTS = ["apps/server/src", "apps/web", "packages"] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const IGNORED_DIRECTORIES = new Set([".git", "coverage", "dist", "node_modules"]);

/**
 * 跨包内部路径的目标形态：`packages/<pkg>/{src,web/src}/**`（`<pkg>` 可含一层分组目录）。
 *
 * 用非贪婪匹配取到 `/src` 或 `/web/src` 之前的完整包目录，因此 `packages/resources/machine/src/x.ts`
 * 与 `packages/chat-channel/src/x.ts` 都能得到正确边界，不需要维护分组目录白名单。
 */
const CROSS_PACKAGE_SOURCE_PATH = /^packages\/(.+?)\/(?:src|web\/src)(?:\/|$)/;
const WORKSPACE_DIRECTORY_OF_FILE = /^(packages\/.+?)\/(?:src|web)\//;

/**
 * 浏览器入口：`apps/web` 与控制台代码，以及各包的 web contribution。
 *
 * web contribution 只出现在包目录下一层的 `web/`（§2.4 的前后端物理就近）。模式必须锚定到包目录，
 * 否则 `packages/<pkg>/src/server/routes/web/**` 这类服务端路由目录会被误判成浏览器代码。
 */
function isBrowserEntry(relativePath: string): boolean {
  return (
    relativePath.startsWith("apps/web/src/") ||
    relativePath.startsWith("apps/web/components/") ||
    /^packages\/(?:[^/]+\/)?[^/]+\/web\//.test(relativePath)
  );
}

const HARD_RULES: readonly ArchitectureRule[] = [
  createImportRule({
    id: "browser-entry-server-import",
    appliesToFile: ({ relativePath }) => isBrowserEntry(relativePath) && !isTestFile(relativePath),
    isForbidden: ({ specifier }) =>
      specifier.startsWith("node:") ||
      specifier.startsWith("@server/") ||
      specifier === "@fenix/chat-channel/server" ||
      specifier.startsWith("@fenix/chat-channel/server/"),
    message: ({ specifier }) => `浏览器入口不得导入服务端模块 "${specifier}"`,
  }),
  createImportRule({
    id: "backend-no-route-imports",
    appliesToFile: ({ relativePath }) =>
      relativePath.startsWith("apps/server/src/services/") || relativePath.startsWith("apps/server/src/repositories/"),
    isForbidden: ({ specifier }, { absolutePath, root }) => {
      if (specifier === "@server/routes" || specifier.startsWith("@server/routes/")) return true;
      if (!specifier.startsWith(".")) return false;

      const targetPath = normalizePath(relative(root, resolve(dirname(absolutePath), specifier)));
      return targetPath === "apps/server/src/routes" || targetPath.startsWith("apps/server/src/routes/");
    },
    message: ({ specifier }) => `Service/Repository 不得反向依赖 Route "${specifier}"`,
  }),
  createImportRule({
    id: "package-no-internal-imports",
    appliesToFile: () => true,
    isForbidden: ({ specifier }, context) => {
      if (/^@fenix\/[^/]+\/(?:src|web\/src)(?:\/|$)/.test(specifier)) return true;
      if (!specifier.startsWith(".")) return false;

      const targetPath = normalizePath(relative(context.root, resolve(dirname(context.absolutePath), specifier)));
      const targetPackage = CROSS_PACKAGE_SOURCE_PATH.exec(targetPath)?.[1];
      if (!targetPackage) return false;

      // 同包内的相对导入合法。来源包优先取 workspace 声明，缺失时（行为夹具没有 package.json）
      // 退回按路径推导，两种来源对 `packages/<group>/<pkg>/{src,web}` 得到同样的边界。
      const sourcePackage = context.packageDirectory ?? WORKSPACE_DIRECTORY_OF_FILE.exec(context.relativePath)?.[1];
      return sourcePackage !== `packages/${targetPackage}`;
    },
    message: ({ specifier }) => `必须通过 workspace 包公开导出访问 "${specifier}"`,
  }),
  createImportRule({
    id: "zod-v4-entrypoint",
    appliesToFile: () => true,
    isForbidden: ({ specifier }) =>
      specifier === "zod" ||
      (specifier.startsWith("zod/") && specifier !== "zod/v4" && !specifier.startsWith("zod/v4/")),
    message: ({ specifier }) => `Zod 入口 "${specifier}" 不受支持，应从 "zod/v4" 导入`,
  }),
  createImportRule({
    id: "model-icon-boundary",
    appliesToFile: ({ relativePath }) =>
      !relativePath.startsWith("packages/resources/model-management/web/components/model-icon/"),
    isForbidden: ({ specifier }) => specifier === "@lobehub/icons" || specifier.startsWith("@lobehub/icons/"),
    message: () => "模型品牌图标只能由 model-management 的 model-icon 组件封装",
  }),
  {
    check(context) {
      if (!isBrowserEntry(context.relativePath) || isTestFile(context.relativePath)) return [];

      const diagnostics: ArchitectureDiagnostic[] = [];
      function visit(node: ts.Node): void {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "request") {
          const argument = node.arguments[0];
          const text = ts.isStringLiteralLike(argument)
            ? argument.text
            : ts.isTemplateExpression(argument)
              ? argument.head.text
              : null;
          if (text && /^\/v[12](?:\/|$)/.test(text)) {
            const { character, line } = context.sourceFile.getLineAndCharacterOfPosition(
              argument.getStart(context.sourceFile),
            );
            diagnostics.push({
              column: character + 1,
              filePath: context.relativePath,
              line: line + 1,
              message: `前端不得使用历史 API 前缀 "${text}"`,
              ruleId: "frontend-no-legacy-api-prefix",
            });
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(context.sourceFile);
      return diagnostics;
    },
  },
];

interface PackageManifestFacts {
  readonly directory: string;
  readonly name: string;
  readonly dependencies: ReadonlySet<string>;
  readonly devDependencies: ReadonlySet<string>;
}

/** 读取每个 workspace 包的 `package.json` 依赖声明，供依赖类规则复用。 */
async function loadPackageFacts(root: string): Promise<readonly PackageManifestFacts[]> {
  const packages = await loadWorkspacePackages(root);

  return Promise.all(
    packages.map(async (entry): Promise<PackageManifestFacts> => {
      const manifest = JSON.parse(await readFile(join(root, entry.directory, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      return {
        dependencies: new Set([
          ...Object.keys(manifest.dependencies ?? {}),
          ...Object.keys(manifest.peerDependencies ?? {}),
        ]),
        devDependencies: new Set(Object.keys(manifest.devDependencies ?? {})),
        directory: entry.directory,
        name: entry.name,
      };
    }),
  );
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries: Dirent[] = await readdir(directory, { withFileTypes: true });

  const files = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      if (entry.isSymbolicLink()) return [];

      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) return [];
        return collectSourceFiles(entryPath);
      }

      return entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)) ? [entryPath] : [];
    }),
  );

  return files.flat();
}

async function validateSourceRoots(root: string): Promise<void> {
  for (const sourceRoot of SOURCE_ROOTS) {
    const sourceRootPath = join(root, sourceRoot);
    try {
      const sourceRootStat = await stat(sourceRootPath);
      if (!sourceRootStat.isDirectory()) throw new Error("路径不是目录");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`配置的源码目录不可用: ${sourceRoot} (${reason})`);
    }
  }
}

function parseRoot(args: string[]): string {
  const rootIndex = args.indexOf("--root");
  if (rootIndex === -1) return process.cwd();

  const value = args[rootIndex + 1];
  if (!value || value.startsWith("--")) throw new Error("--root 需要目录参数");
  return isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value);
}

function createFileChecker(
  root: string,
  packages: readonly PackageManifestFacts[],
  rules: readonly ArchitectureRule[],
): (absolutePath: string) => Promise<ArchitectureDiagnostic[]> {
  const byDirectory = [...packages].sort((left, right) => right.directory.length - left.directory.length);
  const byName = new Map(packages.map((entry) => [entry.name, entry]));
  const resolveWorkspacePackageName = createSpecifierPackageResolver(packages);

  return async (absolutePath: string): Promise<ArchitectureDiagnostic[]> => {
    const relativePath = normalizePath(relative(root, absolutePath));
    const ownPackage = byDirectory.find((entry) => relativePath.startsWith(`${entry.directory}/`));
    const sourceText = await readFile(absolutePath, "utf8");
    const scriptKind = absolutePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sourceFile = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind);

    const context: RuleContext = {
      absolutePath,
      dependencies: ownPackage?.dependencies ?? new Set(),
      devDependencies: ownPackage?.devDependencies ?? new Set(),
      isTest: isTestFile(relativePath),
      packageDirectory: ownPackage?.directory,
      packageName: ownPackage?.name,
      relativePath,
      resolvePackageDirectory: (packageName) => byName.get(packageName)?.directory,
      resolveWorkspacePackageName,
      root,
      sourceFile,
    };

    return rules.flatMap((rule) => rule.check(context));
  };
}

/**
 * 台账里「本门禁负责、但已经不再违规」的条目。
 *
 * 必须按规则名过滤：台账由本脚本与 `check-dependency-boundaries.ts` 共用，各自只看得到自己那部分
 * 规则的违规，不过滤就会把对方仍在生效的条目误判成「已失效」。
 */
function collectStaleExceptions(
  registered: ReadonlyMap<string, unknown>,
  matched: ReadonlySet<string>,
  ownRuleIds: readonly string[],
): string[] {
  const owned = new Set(ownRuleIds);
  return [...registered.keys()].filter(
    (fingerprint) => owned.has(fingerprint.split(" ")[0]) && !matched.has(fingerprint),
  );
}

/** 边界诊断按台账分流；返回本次运行里实际被台账放行的指纹。 */
function classifyDiagnostics(
  diagnostics: readonly ArchitectureDiagnostic[],
  registered: ReadonlyMap<string, unknown>,
): { readonly blocked: ArchitectureDiagnostic[]; readonly matched: Set<string> } {
  const blocked: ArchitectureDiagnostic[] = [];
  const matched = new Set<string>();

  for (const diagnostic of diagnostics) {
    if (!diagnostic.boundary) {
      blocked.push(diagnostic);
      continue;
    }

    const fingerprint = exceptionFingerprint(diagnostic.ruleId, diagnostic.boundary.from, diagnostic.boundary.to);
    if (registered.has(fingerprint)) {
      matched.add(fingerprint);
      continue;
    }
    blocked.push(diagnostic);
  }

  return { blocked, matched };
}

async function main(): Promise<void> {
  const root = parseRoot(process.argv.slice(2));
  await validateSourceRoots(root);

  const [packages, ledger] = await Promise.all([loadPackageFacts(root), loadArchitectureLedger(root)]);
  const rules = [
    ...HARD_RULES,
    ...createBoundaryRules({ handwrittenRegistryBaseline: ledger.handwrittenRegistryBaseline }),
  ];
  const checkFile = createFileChecker(root, packages, rules);

  const sourceFiles = (
    await Promise.all(SOURCE_ROOTS.map((sourceRoot) => collectSourceFiles(join(root, sourceRoot))))
  ).flat();
  const diagnostics = (await Promise.all(sourceFiles.map((filePath) => checkFile(filePath)))).flat();

  const { blocked, matched } = classifyDiagnostics(diagnostics, ledger.exceptions);
  const stale = collectStaleExceptions(
    ledger.exceptions,
    matched,
    rules.map((rule) => rule.id),
  );

  if (blocked.length === 0 && stale.length === 0) {
    console.log(
      `✓ architecture-check (${sourceFiles.length} files, ${rules.length} rules, ${matched.size} 条已登记例外)`,
    );
    return;
  }

  const print = (entry: ArchitectureDiagnostic): string =>
    `  ${entry.filePath}:${entry.line}:${entry.column} [${entry.ruleId}] ${entry.message}`;

  if (blocked.length > 0) {
    console.log(`✗ architecture-check found ${blocked.length} violation(s)`);
    for (const entry of [...blocked].sort(
      (left, right) =>
        left.filePath.localeCompare(right.filePath) || left.line - right.line || left.column - right.column,
    )) {
      console.log(print(entry));
    }
    console.log("  依赖边界类违规可在 scripts/architecture/exceptions.json 登记精确的包对与移除条件");
  }

  if (stale.length > 0) {
    console.log(`✗ 架构例外台账有 ${stale.length} 条已不再违规，必须删除`);
    for (const fingerprint of stale) console.log(`  ${fingerprint}`);
  }

  process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`✗ architecture-check failed: ${message}`);
  process.exitCode = 1;
}
