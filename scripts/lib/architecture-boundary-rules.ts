/**
 * 依赖边界类架构规则的实现。
 *
 * 判定依据是 `ce-ee-engineering-standards.md` §2.1-§2.3 的依赖矩阵，不是当前的实现现状。
 * 与 dependency-cruiser 的分工：`.dependency-cruiser.cjs` 用路径正则表达「包类别之间」的方向
 * 性禁则，这里表达它表达不了的三类——`package.json` 声明与导入是否一致、矩阵中依赖
 * **具体模块**而非类别的禁则、以及浏览器入口的边界。两者不重叠，避免同一违规被登记两次。
 */

import { dirname, relative, resolve } from "node:path";
import type { ArchitectureDiagnostic, ArchitectureRule, RuleContext } from "./architecture-rules";
import { getSpecifiers, positionOf } from "./architecture-rules";
import { normalizePath } from "./workspace-packages";

/** 包类别。由目录布局推导，而不是硬编码包名，新增包放进对应目录即自动归位。 */
type PackageCategory =
  | "platform-sdk"
  | "platform-impl"
  | "agent-runtime"
  | "machine"
  | "sandbox"
  | "resource"
  | "standalone"
  | "apps-server"
  | "apps-web";

/**
 * §2.3「禁止依赖」列中，dependency-cruiser 未覆盖的方向。
 *
 * 刻意留空的方向是已有规则已覆盖的：`platform/*`、`agent-runtime` 对 `resources`/`apps` 的
 * 反向依赖由 `.dependency-cruiser.cjs` 的 `platform-not-to-agent-runtime-resources-apps` 与
 * `agent-runtime-not-to-resources` 表达，`packages/**` 对 `apps/**` 的依赖由本文件的
 * `apps-boundary` 表达。重复表达会让同一违规出现两条台账记录，必须避免。
 */
const FORBIDDEN_CROSS_CATEGORY: Readonly<Record<PackageCategory, readonly PackageCategory[]>> = {
  "platform-sdk": ["platform-impl"],
  "platform-impl": [],
  "agent-runtime": ["platform-impl"],
  machine: ["agent-runtime", "sandbox", "platform-impl"],
  sandbox: ["agent-runtime", "platform-impl"],
  resource: ["platform-impl"],
  standalone: [],
  "apps-server": [],
  "apps-web": [],
};

/** `access-control` 与 `identity` 都是 platform 下的可替换实现，调用方必须经 `AccessControlModule` 契约。 */
const PLATFORM_IMPL_DIRECTORIES = ["packages/platform/access-control", "packages/platform/identity"];

/**
 * §2.3 中「具体包 → 具体包」的禁则，用于表达**同一类别内部**的方向。
 *
 * 类别级禁则表达不了这一类：`identity` 与 `access-control` 都属于 `platform-impl`，而矩阵只允许
 * 其中一条边——`access-control` 可以使用同版本的 identity 公开入口（授权实现需要把成员关系翻译成
 * 归属事实），反向的 `identity → access-control` 被禁止（身份层不得读取授权策略，否则两个可替换
 * 实现会重新耦合成一体）。标准 §158 要求这类方向"必须能被门禁判定，不依赖人工约定"。
 */
const FORBIDDEN_PACKAGE_DEPENDENCIES: readonly (readonly [from: string, to: string])[] = [
  ["@fenix/identity", "@fenix/access-control"],
];

/** 由包目录推导类别；返回 `undefined` 表示该文件不属于任何 workspace 包。 */
export function resolvePackageCategory(packageDirectory: string | undefined): PackageCategory | undefined {
  if (!packageDirectory) return;
  if (packageDirectory === "apps/server") return "apps-server";
  if (packageDirectory === "apps/web") return "apps-web";
  if (packageDirectory === "packages/platform/platform-sdk") return "platform-sdk";
  if (PLATFORM_IMPL_DIRECTORIES.includes(packageDirectory)) return "platform-impl";
  if (packageDirectory === "packages/agent-runtime") return "agent-runtime";
  if (packageDirectory === "packages/resources/machine") return "machine";
  if (packageDirectory === "packages/resources/sandbox") return "sandbox";
  if (packageDirectory.startsWith("packages/resources/")) return "resource";
  return "standalone";
}

function isInside(directory: string, relativePath: string): boolean {
  return relativePath === directory || relativePath.startsWith(`${directory}/`);
}

/**
 * 浏览器入口形态：包目录下一层的 `web/`。
 *
 * 与 `check-architecture.ts` 的 `isBrowserEntry` 对 `packages/**` 的判定保持一致；两处都必须锚定
 * 包目录，否则 `packages/<pkg>/src/server/routes/web/**` 会被当成浏览器代码。
 */
function isWebContribution(relativePath: string): boolean {
  return /^packages\/[^/]+\/(?:[^/]+\/)?web\//.test(relativePath);
}

/** 说明符相对当前文件是否越界进入 `apps/` 下的某个应用。 */
function resolveEscapeTarget(context: RuleContext, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return;

  const targetPath = normalizePath(relative(context.root, resolve(dirname(context.absolutePath), specifier)));
  if (isInside("apps/server", targetPath)) return "@fenix/server-app";
  if (isInside("apps/web", targetPath)) return "@fenix/web-app";
  return;
}

/**
 * `undeclared-workspace-dependency`：导入 workspace 包必须在本包 `package.json` 显式声明。
 *
 * §2.1 要求每个 package 显式声明 workspace dependency，避免依赖被根 workspace 的偶然提升掩盖。
 * 「是不是 workspace 包」由根 workspaces 声明解析，不看 `@fenix/` 前缀——`acp-link` 这类无 scope
 * 的包曾因此整包逃过本规则。自引用（从 `packages/x` 内部导入 `x` 自身入口）不在此规则范围：
 * 它是同包入口自环问题，不是声明缺失。
 */
function createUndeclaredWorkspaceDependencyRule(): ArchitectureRule {
  return {
    id: "undeclared-workspace-dependency",
    check(context) {
      if (!context.packageName) return [];

      const diagnostics: ArchitectureDiagnostic[] = [];
      for (const reference of getSpecifiers(context)) {
        const target = context.resolveWorkspacePackageName(reference.specifier);
        if (!target || target === context.packageName) continue;
        if (context.dependencies.has(target)) continue;
        if (context.isTest && context.devDependencies.has(target)) continue;

        diagnostics.push({
          ...positionOf(context, reference.position),
          boundary: { from: context.packageName, to: target },
          filePath: context.relativePath,
          message: `包 "${context.packageName}" 导入了 "${reference.specifier}"，但 package.json 未声明依赖 "${target}"`,
          ruleId: "undeclared-workspace-dependency",
        });
      }
      return diagnostics;
    },
  };
}

/**
 * `apps-boundary`：`packages/**` 不得依赖 `apps/**`。
 *
 * 直接由「应用是唯一的 composition root」推出：资源与运行包只能暴露能力，由宿主决定如何组合。
 * 这是当前仓库规模最大的边界倒置（16 个包、688 处导入 `@server`），以台账冻结存量。
 *
 * web contribution 对 `apps/web` 的相对越界**不在这里报**：那属于 `web-package-not-to-app` 的
 * 职责，两边都报会让同一处导入产生两条台账记录，「已不再违规即删除」的语义随之失效。
 */
function createAppsBoundaryRule(): ArchitectureRule {
  return {
    id: "apps-boundary",
    check(context) {
      if (!context.packageName || !context.relativePath.startsWith("packages/")) return [];

      const diagnostics: ArchitectureDiagnostic[] = [];
      for (const reference of getSpecifiers(context)) {
        const target =
          reference.specifier === "@server" || reference.specifier.startsWith("@server/")
            ? "@fenix/server-app"
            : resolveEscapeTarget(context, reference.specifier);
        if (!target) continue;
        if (target === "@fenix/web-app" && isWebContribution(context.relativePath)) continue;

        diagnostics.push({
          ...positionOf(context, reference.position),
          boundary: { from: context.packageName, to: target },
          filePath: context.relativePath,
          message: `包 "${context.packageName}" 不得依赖应用 "${target}"，应改由宿主注入或经 platform-sdk 的稳定契约`,
          ruleId: "apps-boundary",
        });
      }
      return diagnostics;
    },
  };
}

/**
 * `special-dependency`：§2.3 中针对**具体模块**而非整个类别的跨类别禁则。
 *
 * 只有 package.json 声明与源码都指向某个禁止类别时才判定，因此必须在包粒度而非文件粒度生效。
 */
function createSpecialDependencyRule(): ArchitectureRule {
  return {
    id: "special-dependency",
    check(context) {
      const category = resolvePackageCategory(context.packageDirectory);
      if (!category || !context.packageName) return [];
      const forbidden = FORBIDDEN_CROSS_CATEGORY[category];

      const diagnostics: ArchitectureDiagnostic[] = [];
      for (const reference of getSpecifiers(context)) {
        const target = context.resolveWorkspacePackageName(reference.specifier);
        if (!target || target === context.packageName) continue;
        if (target === "@fenix/server-app" || target === "@fenix/web-app") continue; // 由 apps-boundary 负责

        const targetCategory = resolvePackageCategory(context.resolvePackageDirectory(target));
        const forbiddenPackageEdge = FORBIDDEN_PACKAGE_DEPENDENCIES.some(
          ([from, to]) => from === context.packageName && to === target,
        );
        if (!forbiddenPackageEdge && (!targetCategory || !forbidden.includes(targetCategory))) continue;

        diagnostics.push({
          ...positionOf(context, reference.position),
          boundary: { from: context.packageName, to: target },
          filePath: context.relativePath,
          message: forbiddenPackageEdge
            ? `§2.3 禁止 "${context.packageName}" 依赖 "${target}"，违规边为 "${context.packageName}" → "${target}"`
            : `§2.3 禁止 "${category}" 依赖 "${targetCategory}"，违规边为 "${context.packageName}" → "${target}"`,
          ruleId: "special-dependency",
        });
      }
      return diagnostics;
    },
  };
}

/**
 * `web-package-not-to-app`：资源包的浏览器入口不得进入 `apps/web` 内部。
 *
 * §2.3 的 web 行明确禁止依赖 `apps/web` 内部：web contribution 只在浏览器 bundle 里被 Shell
 * 消费，反向读取宿主实现会让模块无法独立演进。允许 `@/src` 别名与相对路径两种越界形式。
 */
function createWebPackageNotToAppRule(): ArchitectureRule {
  return {
    id: "web-package-not-to-app",
    check(context) {
      if (!context.packageName || !isWebContribution(context.relativePath)) return [];

      const diagnostics: ArchitectureDiagnostic[] = [];
      for (const reference of getSpecifiers(context)) {
        const isAliasEscape = /^@\/(?:src|components)(?:\/|$)/.test(reference.specifier);
        const target = isAliasEscape ? "@fenix/web-app" : resolveEscapeTarget(context, reference.specifier);
        if (target !== "@fenix/web-app") continue;

        diagnostics.push({
          ...positionOf(context, reference.position),
          boundary: { from: context.packageName, to: target },
          filePath: context.relativePath,
          message: `web contribution 不得依赖宿主 "${target}" 内部实现（"${reference.specifier}"）`,
          ruleId: "web-package-not-to-app",
        });
      }
      return diagnostics;
    },
  };
}

/**
 * 边界规则集。
 *
 * 这里曾有第五条 `no-new-handwritten-registry`：在 `main.ts` 尚未切到 registry 装配的过渡期，冻结
 * `handwrittenRegistryBaseline` 并阻断宿主入口新增手写模块挂载。1.5f 完成切换后规则的适用对象消失
 * （入口不再持有任何包实现依赖），规则与基线字段一并删除——**留下它会变成「入口允许出现哪些包名」的
 * 第二份清单**，恰好是要根除的那种手写映射。此后约束由装配 profile 与模块 manifest 承担：新增模块
 * 不改宿主代码，因此没有需要特判的入口文件。
 */
export function createBoundaryRules(): readonly ArchitectureRule[] {
  return [
    createUndeclaredWorkspaceDependencyRule(),
    createAppsBoundaryRule(),
    createSpecialDependencyRule(),
    createWebPackageNotToAppRule(),
  ];
}
