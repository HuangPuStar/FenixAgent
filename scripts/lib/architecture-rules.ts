/**
 * 架构门禁规则的公共类型与工厂。
 *
 * 规则分两类，判定与失败方式不同：
 *
 * - **硬红线**（`boundary` 缺省）：当前仓库必须零违规，出现即失败。例如 zod 入口、模型图标边界。
 * - **边界规则**（返回 `boundary` 指纹）：把违规归一成「规则 + 来源包 + 目标包」，由
 *   `scripts/architecture/exceptions.json` 判定放行与否。存量债务登记在台账里，只有新增才失败。
 *
 * 区分两类是必要的：硬红线的存量早已清零，任何复发都说明真的写错了；边界规则的存量规模
 * 以百处计（`packages/**` 尚有 656 处导入 `@server/*`），一次性修复不现实，只能冻结基线。
 */

import type ts from "typescript";
import { getImportReferences, type ImportReference } from "./import-references";

export interface ArchitectureDiagnostic {
  column: number;
  filePath: string;
  line: number;
  message: string;
  ruleId: string;
  /** 边界规则的「来源包 → 目标包」指纹；有值时交由台账判定。 */
  boundary?: { readonly from: string; readonly to: string };
}

export interface RuleContext {
  absolutePath: string;
  relativePath: string;
  root: string;
  sourceFile: ts.SourceFile;
  /** 文件所属 workspace 包的仓库相对目录；不属于任何包时为 `undefined`。 */
  packageDirectory: string | undefined;
  /** 文件所属 workspace 包名；不属于任何包时为 `undefined`。 */
  packageName: string | undefined;
  /** 所属包的 `dependencies` + `peerDependencies`。 */
  dependencies: ReadonlySet<string>;
  /** 所属包的 `devDependencies`；测试文件允许只声明在这里。 */
  devDependencies: ReadonlySet<string>;
  /** 由 workspace 包名反查仓库相对目录，用于按目录判定包类别。 */
  resolvePackageDirectory: (packageName: string) => string | undefined;
  /** 由导入说明符反查 workspace 包名；非 workspace 包的说明符返回 `undefined`。 */
  resolveWorkspacePackageName: (specifier: string) => string | undefined;
  isTest: boolean;
}

/** 导入语句在源码中的行列位置。 */
export function positionOf(context: RuleContext, position: number): { column: number; line: number } {
  const { character, line } = context.sourceFile.getLineAndCharacterOfPosition(position);
  return { column: character + 1, line: line + 1 };
}

/** 文件内全部导入说明符（含类型导入与动态导入）。 */
export function getSpecifiers(context: RuleContext): readonly ImportReference[] {
  return getImportReferences(context.sourceFile);
}

export interface ArchitectureRule {
  /** 与台账及失败输出对应的稳定规则名。 */
  id: string;
  check(context: RuleContext): ArchitectureDiagnostic[];
}

export function isTestFile(filePath: string): boolean {
  return filePath.includes("/__tests__/") || /\.(?:test|spec)\.[cm]?tsx?$/.test(filePath);
}

/** 单文件内命中条件的导入语句。 */
export function collectReferenceDiagnostics(
  context: RuleContext,
  ruleId: string,
  options: {
    readonly isForbidden: (reference: ImportReference) => boolean;
    readonly message: (reference: ImportReference) => string;
    readonly boundary?: (reference: ImportReference) => { from: string; to: string } | undefined;
  },
): ArchitectureDiagnostic[] {
  const diagnostics: ArchitectureDiagnostic[] = [];
  for (const reference of getImportReferences(context.sourceFile)) {
    if (!options.isForbidden(reference)) continue;

    const { character, line } = context.sourceFile.getLineAndCharacterOfPosition(reference.position);
    const boundary = options.boundary?.(reference);
    diagnostics.push({
      column: character + 1,
      filePath: context.relativePath,
      line: line + 1,
      message: options.message(reference),
      ruleId,
      ...(boundary ? { boundary } : {}),
    });
  }
  return diagnostics;
}

/**
 * 由「是否命中」谓词生成一条导入规则。
 *
 * `boundary` 回调返回指纹时该规则降级为边界规则，由台账判定存量。
 */
export function createImportRule(options: {
  appliesToFile: (context: RuleContext) => boolean;
  id: string;
  isForbidden: (reference: ImportReference, context: RuleContext) => boolean;
  message: (reference: ImportReference) => string;
  boundary?: (reference: ImportReference, context: RuleContext) => { from: string; to: string } | undefined;
}): ArchitectureRule {
  return {
    id: options.id,
    check(context) {
      if (!options.appliesToFile(context)) return [];

      return collectReferenceDiagnostics(context, options.id, {
        isForbidden: (reference) => options.isForbidden(reference, context),
        message: options.message,
        boundary: options.boundary ? (reference) => options.boundary?.(reference, context) : undefined,
      });
    },
  };
}
