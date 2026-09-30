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
  // machine 与 sandbox 是 Runtime 固定基础资源：它们被 agent-runtime 与彼此依赖，多一条指向其他资源包的
  // 边就等于把「资源包 → 基础资源」的整体方向倒过来——`machine → agent-config` 曾与 agent-config →
  // agent-runtime、agent-runtime → sandbox、sandbox → machine 三条边闭合 4 包环族（台账里 6 个
  // no-circular 指纹的共同闭合边）。跨资源取数改经本包声明、宿主注入的窄端口。
  machine: ["agent-runtime", "sandbox", "platform-impl", "resource"],
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

/**
 * schema 组装期路径：包目录下一层的 `db/`。
 *
 * §6.1 的**跨模块外键 schema 组装期例外**允许这些文件导入其他模块 `db/schema.ts` 的表对象：Drizzle 的
 * `.references()` 与 `foreignKey()` 只接受列对象，没有字符串名或延迟解析的写法，被引用表不在同一文件时
 * 只能组装期导入。判定放在检查器里而不是登记进例外台账——台账按 `(ruleId, from, to)` 匹配，粒度是
 * 「包对」，一条 schema 例外会连同该包 `src/**` 的导入一起放行，等于废掉整条 §2.3 禁则。
 *
 * 与 `isWebContribution` 同形：必须锚定包目录，否则 `packages/platform/identity/src/x/db/` 一类路径会被误放行。
 */
function isSchemaAssemblyPath(relativePath: string): boolean {
  return /^packages\/[^/]+\/(?:[^/]+\/)?db\//.test(relativePath);
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
 * 某条导入边被 §2.3 禁止的依据：具体包之间的边，或类别之间的边。
 *
 * 抽出来给 `special-dependency` 与 `cross-module-db-object-import` 共用：两条规则覆盖的边有交集
 * （`resource → platform-impl` 的表对象导入），判定各写一份则任一处漂移都会让同一处导入被两条规则
 * 报出，台账里随之出现两条记录，「已不再违规即删除」的语义失效。
 */
type ForbiddenEdgeReason =
  | { readonly kind: "package" }
  | { readonly kind: "category"; readonly targetCategory: PackageCategory };

/**
 * §2.3 的 web 行对「浏览器的跨资源复用」单独开口：`packages/resources/<resource>/web` 可以依赖**其他资源**
 * `./web` 公开的 DTO / API client / hook / 组件。类别禁则因此不能一刀切——把 web 贡献也套上服务端禁则，
 * 会把矩阵明确允许的复用判成违规（machine 的文件选择面板就消费 `@fenix/resource-mcp/web`）。
 *
 * 只放行**对方 `./web` 出口**这一种说明符：web 贡献导入对方的服务端入口另有 `browser-entry-server-import`
 * 硬红线兜底，这里不重复表达。
 */
function isAllowedResourceWebReuse(context: RuleContext, targetPackageName: string, specifier: string): boolean {
  if (!isWebContribution(context.relativePath)) return false;
  const webEntry = `${targetPackageName}/web`;
  return specifier === webEntry || specifier.startsWith(`${webEntry}/`);
}

/** 判定「来源包 → 目标包」是否落在 §2.3 的禁止依赖里；`undefined` 表示这条边允许。 */
function findForbiddenEdgeReason(
  context: RuleContext,
  targetPackageName: string,
  specifier: string,
): ForbiddenEdgeReason | undefined {
  const forbiddenPackageEdge = FORBIDDEN_PACKAGE_DEPENDENCIES.some(
    ([from, to]) => from === context.packageName && to === targetPackageName,
  );
  if (forbiddenPackageEdge) return { kind: "package" };

  const category = resolvePackageCategory(context.packageDirectory);
  const targetCategory = resolvePackageCategory(context.resolvePackageDirectory(targetPackageName));
  if (!category || !targetCategory || !FORBIDDEN_CROSS_CATEGORY[category].includes(targetCategory)) return;
  if (targetCategory === "resource" && isAllowedResourceWebReuse(context, targetPackageName, specifier)) return;

  return { kind: "category", targetCategory };
}

/**
 * `special-dependency`：§2.3 中针对**具体模块**而非整个类别的跨类别禁则。
 *
 * 只有 package.json 声明与源码都指向某个禁止类别时才判定，因此必须在包粒度而非文件粒度生效。
 * `db/**` 的跨模块表对象引用是 §6.1 单独规定的组装期例外，整条规则对它不适用——调用期禁则不变。
 */
function createSpecialDependencyRule(): ArchitectureRule {
  return {
    id: "special-dependency",
    check(context) {
      if (isSchemaAssemblyPath(context.relativePath)) return [];
      const category = resolvePackageCategory(context.packageDirectory);
      if (!category || !context.packageName) return [];

      const diagnostics: ArchitectureDiagnostic[] = [];
      for (const reference of getSpecifiers(context)) {
        const target = context.resolveWorkspacePackageName(reference.specifier);
        if (!target || target === context.packageName) continue;
        if (target === "@fenix/server-app" || target === "@fenix/web-app") continue; // 由 apps-boundary 负责

        const reason = findForbiddenEdgeReason(context, target, reference.specifier);
        if (!reason) continue;

        diagnostics.push({
          ...positionOf(context, reference.position),
          boundary: { from: context.packageName, to: target },
          filePath: context.relativePath,
          message:
            reason.kind === "package"
              ? `§2.3 禁止 "${context.packageName}" 依赖 "${target}"，违规边为 "${context.packageName}" → "${target}"`
              : `§2.3 禁止 "${category}" 依赖 "${reason.targetCategory}"，违规边为 "${context.packageName}" → "${target}"`,
          ruleId: "special-dependency",
        });
      }
      return diagnostics;
    },
  };
}

/**
 * `cross-module-db-object-import`：调用期代码不得导入其他模块的 `db` 表对象。
 *
 * `@fenix/<pkg>/db` 是为**组装期**跨模块外键开的口子（Drizzle 的 `.references()` 只接受列对象，没有
 * 字符串名写法，§6.1）。调用期只需要表名、行类型或一次取数时，应经对方资源包公开的服务端入口，
 * 而不是把两张模块的表定义耦合在一起——这类耦合此前只在「类别矩阵也禁止该边」时才被 `special-dependency`
 * 拦下（如 `resource → platform-impl`），同类别之间的表对象导入（例如 agent-config 的用例取
 * model / machine / skill 的表对象）两道门都放行，缺口由此补上。
 *
 * 同包自引用不算跨模块：表定义归本包，仓储经自己的 `./db` 出口取表对象是既定形态。
 * 只认裸说明符这一条出口；相对路径伸进对方 `db/` 由 `package-no-internal-imports` 与
 * dependency-cruiser 的 `no-cross-package-db` 负责，避免同一处导入被两条规则同时报出。
 * 作用域限定 `packages/**`：宿主 `apps/server/src/db/schema.ts` 的身份表转出与
 * `apps/server/src/services/data-migrates/*` 属各自的搬迁任务，本规则不介入。
 */
function createCrossModuleDbObjectImportRule(): ArchitectureRule {
  return {
    id: "cross-module-db-object-import",
    check(context) {
      if (!context.packageName || !context.relativePath.startsWith("packages/")) return [];
      if (isSchemaAssemblyPath(context.relativePath)) return [];

      const diagnostics: ArchitectureDiagnostic[] = [];
      for (const reference of getSpecifiers(context)) {
        const target = context.resolveWorkspacePackageName(reference.specifier);
        if (!target || target === context.packageName) continue;
        // 精确匹配 `<包名>/db`：`@fenix/x/db/schema` 一类深路径不在 exports 里，解析不到，不属本规则。
        if (reference.specifier !== `${target}/db`) continue;
        // 类别矩阵已禁止的边由 `special-dependency` 报出（见 `findForbiddenEdgeReason` 的分工说明）。
        if (findForbiddenEdgeReason(context, target, reference.specifier)) continue;

        diagnostics.push({
          ...positionOf(context, reference.position),
          boundary: { from: context.packageName, to: target },
          filePath: context.relativePath,
          message: `调用期不得导入 "${target}" 的表对象（"${reference.specifier}"）：该出口只供 "db/schema.ts" 组装跨模块外键，调用期请经对方公开的服务端入口取数`,
          ruleId: "cross-module-db-object-import",
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
    createCrossModuleDbObjectImportRule(),
    createWebPackageNotToAppRule(),
  ];
}
