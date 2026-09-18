/**
 * 从 TypeScript 源文件提取模块说明符引用，供架构门禁与 registry 生成器共用。
 *
 * 这里区分引用是否会在运行期求值：registry 生成器要求 `web-shell` manifest 保持零值导入，
 * 因为生成的 registry 由 `apps/server` 静态导入，任何运行时引用都会把浏览器代码拖进服务端
 * 装配图。门禁只关心「导入了什么」，忽略 `kind` 即可。
 */

import ts from "typescript";

/** 引用的求值时机。 */
export type ImportReferenceKind =
  /** 运行期求值的普通导入、再导出、副作用导入。 */
  | "value"
  /** `import type` 或全 type 具名导入，编译期擦除。 */
  | "type"
  /** `import()` / `require()`，运行期动态求值。 */
  | "dynamic";

/** 单条导入/再导出引用。 */
export interface ImportReference {
  /** 说明符字符串字面量在源码中的起始偏移，用于定位回行列。 */
  readonly position: number;
  readonly specifier: string;
  readonly kind: ImportReferenceKind;
}

/** `import { type A } from "x"` 只在所有具名绑定都标了 `type` 时才可整体擦除。 */
function isTypeOnlyImportClause(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return false; // `import "x"` 是副作用导入，必须执行
  if (clause.isTypeOnly) return true;

  const bindings = clause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
}

/** `export * from "x"` 与 `export * as ns from "x"` 都是值再导出。 */
function isTypeOnlyExportClause(clause: ts.ExportDeclaration["exportClause"]): boolean {
  if (!clause) return false;
  if (ts.isNamespaceExport(clause)) return false;
  return clause.elements.length > 0 && clause.elements.every((element) => element.isTypeOnly);
}

/** 提取文件中全部导入与再导出引用，按源码出现顺序返回。 */
export function getImportReferences(sourceFile: ts.SourceFile): readonly ImportReference[] {
  const references: ImportReference[] = [];

  function addReference(node: ts.Expression | undefined, kind: ImportReferenceKind): void {
    if (node && ts.isStringLiteralLike(node)) {
      references.push({ position: node.getStart(sourceFile), specifier: node.text, kind });
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      addReference(node.moduleSpecifier, isTypeOnlyImportClause(node.importClause) ? "type" : "value");
    } else if (ts.isExportDeclaration(node)) {
      addReference(
        node.moduleSpecifier,
        node.isTypeOnly || isTypeOnlyExportClause(node.exportClause) ? "type" : "value",
      );
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) addReference(node.arguments[0], "dynamic");
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return references;
}

/** 解析 TypeScript 源码；`scriptKind` 由调用方按扩展名给出。 */
export function parseTypeScriptSource(filePath: string, sourceText: string): ts.SourceFile {
  const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, scriptKind);
}
