// manifest 的**部署面事实**：模块索引、profile 部署视图与模块 overlay 都由这几个字段派生。
//
// 与 `module-manifest-source.ts` 分工：那边读「模块是谁」（`id` / `kind` / `dependsOn` / `web`），这里读
// 「模块要什么」（`capabilities` / `envDefinitions` 键 / `dependencyServices`）。两者共用同一套 AST 读取
// 原语，都不执行 manifest——`deploy/manifests/` 与 `deploy/compose/overlays/` 会进版本控制，计算值会让
// 「生成物 == 声明」这条结论不可复现。
//
// 本文件只做类型导入，不 import 运行期值：`module-manifest-source.ts` 不需要反向认识它，避免生成器内部
// 出现环形依赖。
import ts from "typescript";

import type { ManifestSource } from "./module-manifest-source";
import {
  findManifestObject,
  findProperty,
  MODULE_ID_PATTERN,
  readStringProperty,
  unwrapObjectLiteral,
} from "./module-manifest-source";

/**
 * 依赖服务的编排归属，必须与 `@fenix/platform-sdk` 的 `DependencyService["orchestration"]` 一致。
 *
 * 与 `MODULE_KINDS` 同因在生成器里重复一份：生成器运行时不依赖 `@fenix/platform-sdk`，
 * `scripts/__tests__/release-generator.test.ts` 的类型穷尽断言守着这条一致性。
 */
export const DEPENDENCY_ORCHESTRATIONS = ["compose-overlay", "separate"] as const;

/** 依赖服务的探活声明；`http` 带 `path`，`tcp` 只断言地址可达。 */
export interface DependencyServiceHealthCheckDeclaration {
  readonly kind: string;
  readonly addressKey: string;
  readonly path?: string;
}

/** 从 manifest 源码静态读出的依赖服务声明（对应 `@fenix/platform-sdk` 的 `DependencyService`）。 */
export interface DependencyServiceDeclaration {
  readonly id: string;
  readonly required: boolean;
  readonly orchestration: string;
  readonly envKeys: readonly string[];
  readonly image?: string;
  readonly ports: readonly string[];
  readonly composeFile?: string;
  readonly healthCheck: DependencyServiceHealthCheckDeclaration;
  readonly description: string;
}

/** manifest 声明的部署面事实。 */
export interface ModuleDeployFacts {
  readonly capabilities: readonly string[];
  readonly dependencyServices: readonly DependencyServiceDeclaration[];
  /** 本模块 `envDefinitions` 的键集合；探针与 `envKeys` 只能引用这里出现过的键。 */
  readonly envKeys: readonly string[];
}

/** 带部署面事实的 manifest 源码；`release.ts` 只把这一种形状交给渲染层。 */
export interface ModuleDeploySource extends ManifestSource, ModuleDeployFacts {}

/**
 * 读取字符串字面量，允许相邻字面量用 `+` 拼接（只做常量折叠）。
 *
 * 折叠是必要的：既有 manifest 的 `description` 就是多行拼接。但**只**折叠字面量——变量、模板插值与函数
 * 调用一律拒绝，否则生成物会依赖运行期求值。
 */
function readFoldedString(expression: ts.Expression | undefined, label: string, manifestFile: string): string {
  if (expression === undefined) throw new Error(`manifest 必须声明 ${label}: ${manifestFile}`);
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return (
      readFoldedString(expression.left, label, manifestFile) + readFoldedString(expression.right, label, manifestFile)
    );
  }
  throw new Error(`manifest 的 ${label} 必须是字符串字面量（可用 + 拼接字面量）: ${manifestFile}`);
}

/** 读取必填字符串字面量字段。 */
function requireStringProperty(
  objectLiteral: ts.ObjectLiteralExpression,
  propertyName: string,
  manifestFile: string,
): string {
  const value = readStringProperty(objectLiteral, propertyName, manifestFile);
  if (value === undefined) throw new Error(`manifest 必须声明 ${propertyName}: ${manifestFile}`);
  return value;
}

/** 读取字面量字符串数组字段；`required` 为 true 时缺字段即抛错，否则缺字段得到空数组。 */
function readStringArrayProperty(
  objectLiteral: ts.ObjectLiteralExpression,
  propertyName: string,
  manifestFile: string,
  required: boolean,
): readonly string[] {
  const property = findProperty(objectLiteral, propertyName);
  if (!property) {
    if (required) throw new Error(`manifest 必须声明字符串数组 ${propertyName}: ${manifestFile}`);
    return [];
  }
  if (!ts.isArrayLiteralExpression(property.initializer)) {
    throw new Error(`manifest 的 ${propertyName} 必须是数组字面量: ${manifestFile}`);
  }
  return property.initializer.elements.map((element) => {
    if (!ts.isStringLiteralLike(element)) {
      throw new Error(`manifest 的 ${propertyName} 只能包含字符串字面量: ${manifestFile}`);
    }
    return element.text;
  });
}

/** 读取依赖服务的探活声明：`http` 必须带 `path`，`tcp` 只断言地址可达。 */
function readDependencyHealthCheck(
  initializer: ts.Expression | undefined,
  serviceId: string,
  manifestFile: string,
): DependencyServiceHealthCheckDeclaration {
  const literal = unwrapObjectLiteral(initializer);
  if (!literal) throw new Error(`依赖服务 ${serviceId} 的 healthCheck 必须是对象字面量: ${manifestFile}`);

  const kind = requireStringProperty(literal, "kind", manifestFile);
  if (kind !== "http" && kind !== "tcp") {
    throw new Error(`依赖服务 ${serviceId} 的 healthCheck.kind 必须是 http 或 tcp: ${manifestFile}`);
  }

  const addressKey = requireStringProperty(literal, "addressKey", manifestFile);
  if (kind === "tcp") return { addressKey, kind };
  return { addressKey, kind, path: requireStringProperty(literal, "path", manifestFile) };
}

/** 静态读取 `dependencyServices` 声明；未声明返回空数组。 */
export function readDependencyServices(
  objectLiteral: ts.ObjectLiteralExpression,
  manifestFile: string,
): readonly DependencyServiceDeclaration[] {
  const property = findProperty(objectLiteral, "dependencyServices");
  if (!property) return [];
  if (!ts.isArrayLiteralExpression(property.initializer)) {
    throw new Error(`manifest 的 dependencyServices 必须是数组字面量: ${manifestFile}`);
  }

  return property.initializer.elements.map((element) => {
    const serviceLiteral = unwrapObjectLiteral(element);
    if (!serviceLiteral) throw new Error(`manifest 的 dependencyServices 只能包含对象字面量: ${manifestFile}`);

    const id = readStringProperty(serviceLiteral, "id", manifestFile);
    if (id === undefined || !MODULE_ID_PATTERN.test(id)) {
      throw new Error(`依赖服务必须声明合法 ID 字面量 id: ${manifestFile}`);
    }

    // 只认字面量 `true` / `false`：`required` 决定部署前自检是否阻断，任何计算值都不可信。
    const requiredInitializer = findProperty(serviceLiteral, "required")?.initializer;
    if (
      requiredInitializer?.kind !== ts.SyntaxKind.TrueKeyword &&
      requiredInitializer?.kind !== ts.SyntaxKind.FalseKeyword
    ) {
      throw new Error(`依赖服务 ${id} 必须声明布尔字面量 required: ${manifestFile}`);
    }

    const orchestration = requireStringProperty(serviceLiteral, "orchestration", manifestFile);
    if (!(DEPENDENCY_ORCHESTRATIONS as readonly string[]).includes(orchestration)) {
      throw new Error(
        `依赖服务 ${id} 的 orchestration 必须是 ${DEPENDENCY_ORCHESTRATIONS.join(" | ")}: ${manifestFile}`,
      );
    }

    return {
      composeFile: readStringProperty(serviceLiteral, "composeFile", manifestFile),
      description: readFoldedString(
        findProperty(serviceLiteral, "description")?.initializer,
        `依赖服务 ${id} 的 description`,
        manifestFile,
      ),
      envKeys: readStringArrayProperty(serviceLiteral, "envKeys", manifestFile, false),
      healthCheck: readDependencyHealthCheck(
        findProperty(serviceLiteral, "healthCheck")?.initializer,
        id,
        manifestFile,
      ),
      id,
      image: readStringProperty(serviceLiteral, "image", manifestFile),
      orchestration,
      ports: readStringArrayProperty(serviceLiteral, "ports", manifestFile, false),
      required: requiredInitializer.kind === ts.SyntaxKind.TrueKeyword,
    };
  });
}

/** 静态读取 `envDefinitions` 的键集合；探针与 `envKeys` 只能引用这里的键。 */
export function readEnvDefinitionKeys(
  objectLiteral: ts.ObjectLiteralExpression,
  manifestFile: string,
): readonly string[] {
  const property = findProperty(objectLiteral, "envDefinitions");
  if (!property) return [];
  if (!ts.isArrayLiteralExpression(property.initializer)) {
    throw new Error(`manifest 的 envDefinitions 必须是数组字面量: ${manifestFile}`);
  }
  return property.initializer.elements.map((element) => {
    const definitionLiteral = unwrapObjectLiteral(element);
    if (!definitionLiteral) throw new Error(`manifest 的 envDefinitions 只能包含对象字面量: ${manifestFile}`);
    return requireStringProperty(definitionLiteral, "key", manifestFile);
  });
}

/** 读取 manifest 声明的部署面事实（capabilities、env 键、依赖服务）。 */
export function readModuleDeployFacts(sourceFile: ts.SourceFile, manifestFile: string): ModuleDeployFacts {
  const objectLiteral = findManifestObject(sourceFile);
  if (!objectLiteral) throw new Error(`manifest 必须导出字面量描述符: ${manifestFile}`);
  return {
    capabilities: readStringArrayProperty(objectLiteral, "capabilities", manifestFile, false),
    dependencyServices: readDependencyServices(objectLiteral, manifestFile),
    envKeys: readEnvDefinitionKeys(objectLiteral, manifestFile),
  };
}
