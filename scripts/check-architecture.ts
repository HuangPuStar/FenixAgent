/**
 * 检查无法由 TypeScript 或 Biome 表达的项目架构边界。
 *
 * 规则只覆盖可通过静态语法可靠判定的红线。新的规则必须先确认当前仓库无历史违规，
 * 并通过 CLI 行为测试证明违规会被阻断、合法边界不会误报。
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";

const SOURCE_ROOTS = ["src", "web/src", "web/components", "packages"] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const IGNORED_DIRECTORIES = new Set([".git", "coverage", "dist", "node_modules"]);

interface ArchitectureDiagnostic {
  column: number;
  filePath: string;
  line: number;
  message: string;
  ruleId: string;
}

interface ImportReference {
  position: number;
  specifier: string;
}

interface RuleContext {
  absolutePath: string;
  relativePath: string;
  root: string;
  sourceFile: ts.SourceFile;
}

interface ArchitectureRule {
  check(context: RuleContext): ArchitectureDiagnostic[];
}

function normalizePath(filePath: string): string {
  return filePath.split(sep).join("/");
}

function isTestFile(filePath: string): boolean {
  return filePath.includes("/__tests__/") || /\.(?:test|spec)\.[cm]?tsx?$/.test(filePath);
}

function getImportReferences(sourceFile: ts.SourceFile): ImportReference[] {
  const references: ImportReference[] = [];

  function addReference(node: ts.Expression | undefined): void {
    if (node && ts.isStringLiteralLike(node)) {
      references.push({ position: node.getStart(sourceFile), specifier: node.text });
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addReference(node.moduleSpecifier);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) addReference(node.arguments[0]);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return references;
}

function createImportRule(options: {
  appliesToFile: (context: RuleContext) => boolean;
  id: string;
  isForbidden: (reference: ImportReference, context: RuleContext) => boolean;
  message: (reference: ImportReference) => string;
}): ArchitectureRule {
  return {
    check(context) {
      if (!options.appliesToFile(context)) return [];

      return getImportReferences(context.sourceFile)
        .filter((reference) => options.isForbidden(reference, context))
        .map((reference) => {
          const { character, line } = context.sourceFile.getLineAndCharacterOfPosition(reference.position);
          return {
            column: character + 1,
            filePath: context.relativePath,
            line: line + 1,
            message: options.message(reference),
            ruleId: options.id,
          };
        });
    },
  };
}

const RULES: readonly ArchitectureRule[] = [
  createImportRule({
    id: "browser-no-server-imports",
    appliesToFile: ({ relativePath }) =>
      (relativePath.startsWith("web/src/") || relativePath.startsWith("web/components/")) && !isTestFile(relativePath),
    isForbidden: ({ specifier }) =>
      specifier.startsWith("node:") ||
      specifier.startsWith("@server/") ||
      specifier === "@fenix/chat-channel/server" ||
      specifier.startsWith("@fenix/chat-channel/server/"),
    message: ({ specifier }) => `浏览器生产代码不得导入服务端模块 "${specifier}"`,
  }),
  createImportRule({
    id: "backend-no-route-imports",
    appliesToFile: ({ relativePath }) =>
      relativePath.startsWith("src/services/") || relativePath.startsWith("src/repositories/"),
    isForbidden: ({ specifier }, { absolutePath, root }) => {
      if (specifier === "@server/routes" || specifier.startsWith("@server/routes/")) return true;
      if (!specifier.startsWith(".")) return false;

      const targetPath = normalizePath(relative(root, resolve(dirname(absolutePath), specifier)));
      return targetPath === "src/routes" || targetPath.startsWith("src/routes/");
    },
    message: ({ specifier }) => `Service/Repository 不得反向依赖 Route "${specifier}"`,
  }),
  createImportRule({
    id: "package-no-internal-imports",
    appliesToFile: () => true,
    isForbidden: ({ specifier }, { absolutePath, relativePath, root }) => {
      if (/^@fenix\/[^/]+\/src(?:\/|$)/.test(specifier)) return true;
      if (!specifier.startsWith(".")) return false;

      const targetPath = normalizePath(relative(root, resolve(dirname(absolutePath), specifier)));
      const targetPackage = /^packages\/([^/]+)\/src(?:\/|$)/.exec(targetPath)?.[1];
      if (!targetPackage) return false;

      const sourcePackage = /^packages\/([^/]+)\//.exec(relativePath)?.[1];
      return sourcePackage !== targetPackage;
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
    appliesToFile: ({ relativePath }) => !relativePath.startsWith("web/components/model-icon/"),
    isForbidden: ({ specifier }) => specifier === "@lobehub/icons" || specifier.startsWith("@lobehub/icons/"),
    message: () => "模型品牌图标只能由 web/components/model-icon/ 封装",
  }),
  {
    check(context) {
      if (
        (!context.relativePath.startsWith("web/src/") && !context.relativePath.startsWith("web/components/")) ||
        isTestFile(context.relativePath)
      ) {
        return [];
      }

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

async function checkFile(root: string, absolutePath: string): Promise<ArchitectureDiagnostic[]> {
  const sourceText = await readFile(absolutePath, "utf8");
  const relativePath = normalizePath(relative(root, absolutePath));
  const scriptKind = absolutePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(absolutePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
  const context = { absolutePath, relativePath, root, sourceFile };

  return RULES.flatMap((rule) => rule.check(context));
}

async function main(): Promise<void> {
  const root = parseRoot(process.argv.slice(2));
  await validateSourceRoots(root);
  const sourceFiles = (
    await Promise.all(SOURCE_ROOTS.map((sourceRoot) => collectSourceFiles(join(root, sourceRoot))))
  ).flat();
  const diagnostics = (await Promise.all(sourceFiles.map((filePath) => checkFile(root, filePath))))
    .flat()
    .sort(
      (left, right) =>
        left.filePath.localeCompare(right.filePath) || left.line - right.line || left.column - right.column,
    );

  if (diagnostics.length === 0) {
    console.log(`✓ architecture-check (${sourceFiles.length} files, ${RULES.length} rules)`);
    return;
  }

  console.log(`✗ architecture-check found ${diagnostics.length} violation(s)`);
  for (const diagnostic of diagnostics) {
    console.log(
      `  ${diagnostic.filePath}:${diagnostic.line}:${diagnostic.column} [${diagnostic.ruleId}] ${diagnostic.message}`,
    );
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
