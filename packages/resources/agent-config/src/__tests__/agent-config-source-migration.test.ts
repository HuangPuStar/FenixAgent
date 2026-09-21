// packages/resources/agent-config/src/__tests__/agent-config-source-migration.test.ts
// AgentConfig 的**包边界契约测试**（任务 1.3 §1 静态条件），按黄金样本
// `packages/resources/sandbox/src/__tests__/sandbox-source-migration.test.ts` 的形状复制。
//
// 为什么断言引用面而不是文件内容：资源包必须能在没有宿主解析环境（`apps/server` / `apps/web` 的
// tsconfig 与 vite 别名）的情况下独立构建。"文件在某个路径"证明不了这件事，源码字符串包含更不行。
// 引用面只要出现一条宿主导入或一条宿主别名，包就已经失去独立构建能力。
//
// 扫描口径：先剥注释（注释里会举例写出宿主别名与旧路径，直接匹配会误报），再取 import/export
// 说明符；`import type` 也算——类型导入同样把宿主路径写进包内。本文件只读文件、不 import 被测模块，
// 因此不会把被测代码的副作用（懒加载宿主单例等）带进来。
//
// 与样本的差异（两处，均为本包实际情况决定）：
//   1. 迁移映射只覆盖**宿主侧已删除**的成对路径。宿主仍残留的同源实现对（`apps/server/src/schemas/
//      sidebar-config.schema.ts`、`apps/web/src/lib/agent-{node,utils,resource-access}.ts`、
//      `apps/web/src/i18n/locales/*/agents.json`）不在清单里——它们是宿主删除项（见 README
//      「已知项」与共享补丁清单），断言它们"已删除"会在宿主侧完成后立刻误报。包内已无同源实现，
//      因此「第二份实现」这条风险由包内扫描（用例 5）而非宿主存在性承担。
//   2. 增加一条测试基建契约：包内用例不得直接调用 `mock.module`（CLAUDE.md 测试红线），必须经
//      `@fenix/platform-sdk/testing` 与包内 `./guard-stubs`。

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** 包根 `packages/resources/agent-config`（本文件位于 `src/__tests__/`）。 */
const PKG_ROOT = resolve(import.meta.dir, "../..");
/** 仓库根；宿主旧路径与新 owner 路径都以它为基准记录。 */
const REPO_ROOT = resolve(PKG_ROOT, "../../..");
/** 包内源码入口；README 等文档里的示例不属于可解析引用，不参与扫描。 */
const SOURCE_ENTRIES = ["src", "web", "fenix.module.ts"];

/**
 * 唯一允许的宿主导入。
 *
 * 表定义迁出归任务 1.7，本任务把它作为**显式残留**保留，且只允许这一条精确路径：`@server/db/schema`
 * 之下的任何深路径都意味着重新伸手取宿主内部。
 */
const ALLOWED_HOST_IMPORT = "@server/db/schema";

/**
 * 宿主旧路径 → 包内新 owner 路径（实测映射；宿主侧文件均已从工作区删除）。
 *
 * 记成「一对」而不是两份清单：旧路径残留（第二份实现复活）与新路径缺失是同一次迁移失败的两种表现，
 * 成对记录才能让失败信息同时指出两端。
 */
const MIGRATION_PAIRS: ReadonlyArray<readonly [hostPath: string, packagePath: string]> = [
  ["apps/server/src/routes/web/config/agents.ts", "src/server/routes/web/config/agents.ts"],
  ["apps/server/src/routes/web/agent-sites.ts", "src/server/routes/web/agent-sites.ts"],
  ["apps/server/src/routes/web/sidebar-config.ts", "src/server/routes/web/sidebar-config.ts"],
  ["apps/server/src/routes/web/agent-generation.ts", "src/server/routes/web/agent-generation.ts"],
  ["apps/server/src/routes/api/agents.ts", "src/server/routes/api/agents.ts"],
  ["apps/server/src/routes/agent-sites-proxy.ts", "src/server/routes/agent-sites-proxy.ts"],
  ["apps/server/src/routes/dependencies.ts", "src/server/routes/dependencies.ts"],
  ["apps/server/src/services/meta-agent.ts", "src/server/services/meta-agent.ts"],
  ["apps/server/src/services/sidebar-config.ts", "src/server/services/sidebar-config.ts"],
  ["apps/server/src/services/agent-sites.ts", "src/server/services/agent-sites.ts"],
  ["apps/server/src/services/agent-generation.ts", "src/server/services/agent-generation.ts"],
  ["apps/server/src/services/agent-config-service.ts", "src/server/services/agent-config-service.ts"],
  ["apps/server/src/services/agent-associations.ts", "src/server/services/agent-associations.ts"],
  ["apps/server/src/services/agent-related-resources.ts", "src/server/services/agent-related-resources.ts"],
  ["apps/server/src/services/config/agent-config.ts", "src/server/services/config/agent-config.ts"],
  ["apps/server/src/services/config/agent-config-site-app.ts", "src/server/services/config/agent-config-site-app.ts"],
  ["apps/server/src/schemas/agent-site.schema.ts", "src/server/schemas/agent-site.schema.ts"],
  ["apps/server/src/schemas/agent-generation.schema.ts", "src/server/schemas/agent-generation.schema.ts"],
  ["apps/server/src/schemas/api-agent.schema.ts", "src/server/schemas/api-agent.schema.ts"],
  ["apps/server/src/schemas/meta-agent.schema.ts", "src/server/schemas/meta-agent.schema.ts"],
  ["apps/server/src/repositories/agent-site-app.ts", "src/server/repositories/agent-site-app.ts"],
  ["apps/server/src/repositories/agent-config.ts", "src/server/repositories/agent-config.ts"],
  ["apps/web/src/api/agents.ts", "web/api/agents.ts"],
  ["apps/web/src/api/sites.ts", "web/api/sites.ts"],
  ["apps/web/src/api/meta-agent.ts", "web/src/api/meta-agent.ts"],
  ["apps/web/src/api/sidebar-config.ts", "web/src/api/sidebar-config.ts"],
  ["apps/web/src/hooks/use-meta-agent.ts", "web/hooks/use-meta-agent.ts"],
  ["apps/web/components/agent-panel/AgentSitesCard.tsx", "web/components/agent-panel/AgentSitesCard.tsx"],
  ["apps/web/src/pages/agent-panel/pages/AgentSitesPage.tsx", "web/pages/agent-panel/pages/AgentSitesPage.tsx"],
  ["apps/server/src/__tests__/round43-agent-sites-routes.test.ts", "src/__tests__/round43-agent-sites-routes.test.ts"],
  [
    "apps/server/src/__tests__/round44-agent-config-routes.test.ts",
    "src/__tests__/round44-agent-config-routes.test.ts",
  ],
  [
    "apps/server/src/__tests__/round45-agent-config-routes-coverage.test.ts",
    "src/__tests__/round45-agent-config-routes-coverage.test.ts",
  ],
  [
    "apps/server/src/__tests__/round45-agent-config-routes-fallback-coverage.test.ts",
    "src/__tests__/round45-agent-config-routes-fallback-coverage.test.ts",
  ],
  [
    "apps/server/src/__tests__/round24-agent-sites-isolation.test.ts",
    "src/__tests__/round24-agent-sites-isolation.test.ts",
  ],
  [
    "apps/server/src/__tests__/round27-agent-templates-isolation.test.ts",
    "src/__tests__/round27-agent-templates-isolation.test.ts",
  ],
  ["apps/server/src/__tests__/api-agents-routes.test.ts", "src/__tests__/api-agents-routes.test.ts"],
  ["apps/server/src/__tests__/agent-sites-routes.test.ts", "src/__tests__/agent-sites-routes.test.ts"],
  ["apps/server/src/__tests__/agent-sites-repo.test.ts", "src/__tests__/agent-sites-repo.test.ts"],
  ["apps/server/src/__tests__/meta-agent.test.ts", "src/__tests__/meta-agent.test.ts"],
  ["apps/server/src/__tests__/sidebar-config-service.test.ts", "src/__tests__/sidebar-config-service.test.ts"],
  ["apps/server/src/__tests__/web-sidebar-config-routes.test.ts", "src/__tests__/web-sidebar-config-routes.test.ts"],
  ["apps/server/src/__tests__/agent-config-repository.test.ts", "src/__tests__/agent-config-repository.test.ts"],
  ["apps/server/src/__tests__/agent-config-site-app.test.ts", "src/__tests__/agent-config-site-app.test.ts"],
  ["apps/web/src/__tests__/agent-i18n.test.ts", "web/__tests__/agent-i18n.test.ts"],
  ["apps/web/src/__tests__/config-agents-page.test.ts", "web/__tests__/config-agents-page.test.ts"],
  ["apps/web/src/__tests__/agent-resource-access-flow.test.ts", "web/__tests__/agent-resource-access-flow.test.ts"],
  // 曾经有过一对 `apps/web/src/__tests__/agent-sidebar-config.test.ts` →
  // `web/src/__tests__/agent-sidebar-config.test.ts`。§1.6 T11d 撤销了这次迁移：侧栏导航的真相源改成
  // 各包的 `web/contribution.ts` + WebShell 的分组表，`AgentSidebarConfig` 的宿主副本与包内死副本
  // 一并删除，`filterNavGroups` 的纯逻辑与其 50 条断言改由宿主 WebShell 持有
  // （`apps/web/src/shell/shell-navigation.ts` / `apps/web/src/__tests__/shell-navigation-filter.test.ts`）。
  // 该能力不再属于本包，因此不再是「宿主 → 包」的迁移对。
];

/** 去掉行注释与块注释；字符串字面量内的内容原样保留（说明符本身就在引号里）。 */
function stripComments(source: string): string {
  let out = "";
  let index = 0;
  let quote: '"' | "'" | "`" | null = null;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") out += "\n";
        index += 1;
      }
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * 说明符抓取模式：`from` 形式（含多行命名导入）、副作用导入、动态 `import()`。
 *
 * `from` 形式锚在行首并止步于 `;`，避免把函数体或正则字面量里的 `from "…"` 文本当成语句。
 */
const SPECIFIER_PATTERNS = [
  /^[ \t]*(?:import|export)\b[^;]*?\bfrom[ \t]*["']([^"']+)["']/gm,
  /^[ \t]*import[ \t]*["']([^"']+)["']/gm,
  /\bimport[ \t]*\([ \t]*["']([^"']+)["']/g,
];

/** 说明符的首字符形态：正则字面量里的 `from "…"` 会被上述模式捞出，不属于模块说明符的一律丢弃。 */
const SPECIFIER_LEAD = /^[A-Za-z0-9@._/-]/;

function extractSpecifiers(code: string): string[] {
  const specifiers: string[] = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      if (SPECIFIER_LEAD.test(match[1])) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

/** 递归收集 `.ts` / `.tsx`；跳过 `node_modules`（包内软链指向别的包的实现，不是本包源码）。 */
function listPackageFiles(absDir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "node_modules") continue;
    const child = join(absDir, entry.name);
    if (entry.isDirectory()) files.push(...listPackageFiles(child));
    else if (/\.tsx?$/.test(entry.name)) files.push(child);
  }
  return files;
}

interface ImportRef {
  file: string;
  specifier: string;
}

const sourceFiles = SOURCE_ENTRIES.flatMap((entry) => {
  const abs = resolve(PKG_ROOT, entry);
  if (!existsSync(abs)) return [];
  return statSync(abs).isDirectory() ? listPackageFiles(abs) : [abs];
});

const refs: ImportRef[] = sourceFiles.flatMap((file) =>
  extractSpecifiers(stripComments(readFileSync(file, "utf8"))).map((specifier) => ({ file, specifier })),
);

const describeRef = (ref: ImportRef) => `${relative(PKG_ROOT, ref.file)} → ${ref.specifier}`;

/** 某个入口（目录或单文件）下的已扫描文件。 */
function filesUnder(entry: string): string[] {
  const abs = resolve(PKG_ROOT, entry);
  return sourceFiles.filter((file) => file === abs || file.startsWith(`${abs}/`));
}

/** web 贡献的已扫描文件；宿主别名只可能在 web 面出现，作用域断言按这个集合收敛。 */
const webFiles = new Set(filesUnder("web"));

/** 相对说明符是否落在包外：`resolve` 折叠 `..` 段，宿主与兄弟资源包都会在这里现形。 */
function escapesPackage(file: string, specifier: string): boolean {
  return !resolve(dirname(file), specifier).startsWith(`${PKG_ROOT}/`);
}

const manifest = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
  exports?: Record<string, string>;
};
const exportEntries = Object.entries(manifest.exports ?? {});

describe("AgentConfig 包边界契约（任务 1.3 §1 静态条件）", () => {
  // 遍历有效性自检：walker 若只返回入口文件，后续「不存在违规引用」的断言会全部退化为恒真。
  test("扫描有效性自检：源码集合覆盖全包，且已知残留宿主导入能被扫到", () => {
    for (const expected of [
      "fenix.module.ts",
      "src/server.ts",
      "src/server/routes/dependencies.ts",
      "src/server/routes/web/agent-sites.ts",
      "src/server/routes/api/agents.ts",
      "src/server/routes/web/config/agents.ts",
      "src/__tests__/guard-stubs.ts",
      "src/__tests__/agent-config-delete-stops-instances.test.ts",
      "web/index.ts",
      "web/i18n/index.ts",
      "web/pages/agent-panel/pages/AgentSitesPage.tsx",
    ]) {
      expect(sourceFiles).toContain(resolve(PKG_ROOT, expected));
    }
    expect(sourceFiles.length).toBeGreaterThanOrEqual(100);
    // 正向控制：表定义残留必然存在，扫不到就说明说明符提取失效（而不是「没有宿主导入」）。
    expect(refs.filter((ref) => ref.specifier === ALLOWED_HOST_IMPORT).length).toBeGreaterThan(0);
  });

  // 宿主旧路径不得复活：新旧两套实现并存时，改一侧不会让另一侧失败，两边会各自漂移。
  test("宿主侧已迁移路径保持删除状态", () => {
    const survivors = MIGRATION_PAIRS.map(([hostPath]) => hostPath).filter((hostPath) =>
      existsSync(resolve(REPO_ROOT, hostPath)),
    );
    expect(survivors).toEqual([]);
  });

  // 迁移必须落到包内约定目录：宿主旧文件删了但新实现没落地，等于能力直接消失。
  test("迁移文件均落在包内新 owner 路径", () => {
    const missing = MIGRATION_PAIRS.map(([, packagePath]) => packagePath).filter(
      (packagePath) => !existsSync(resolve(PKG_ROOT, packagePath)),
    );
    expect(missing).toEqual([]);
  });

  // 宿主实现只能经平台契约（`@fenix/platform-sdk`）或注入进入本包；除表定义残留外一律违规。
  test("包内不存在表定义以外的宿主 @server 导入", () => {
    const offenders = refs.filter(
      (ref) => ref.specifier.startsWith("@server/") && ref.specifier !== ALLOWED_HOST_IMPORT,
    );
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 宿主别名（`@/src`、`@/components`）由 apps/web 的 tsconfig/vite 提供，包离开宿主就解析不了。
  test("包内 web 不引用宿主别名 @/", () => {
    const offenders = refs.filter((ref) => ref.specifier.startsWith("@/") && webFiles.has(ref.file));
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 相对路径是最隐蔽的越界方式：`../../../apps/web/...` 在宿主内能跑通，包单独构建时目录不存在。
  test("包内不存在穿透到包外的相对路径引用", () => {
    const offenders = refs.filter((ref) => ref.specifier.startsWith(".") && escapesPackage(ref.file, ref.specifier));
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 环境变量读取与校验统一在宿主：包内直读会把部署知识复制进资源模块，两处默认值会分歧。
  // 标题刻意不写该字面量——本文件也在扫描范围内，标题会被自己扫成违规。
  test("包内 src 不直读宿主环境变量", () => {
    const needle = new RegExp(`\\bprocess\\.${"env"}\\b`);
    const offenders = filesUnder("src").flatMap((file) => {
      const code = stripComments(readFileSync(file, "utf8"));
      return code
        .split("\n")
        .map((line, number) => ({ line, number }))
        .filter(({ line }) => needle.test(line))
        .map(({ number }) => `${relative(PKG_ROOT, file)}:${number}`);
    });
    expect(offenders).toEqual([]);
  });

  // CLAUDE.md 测试红线：测试文件不得直接 mock 模块，替身统一经平台 `/testing` 与包内 `./guard-stubs`。
  // 字面量同样刻意拼接——否则本文件会把自己扫成违规。
  test("包内测试不直接 mock 模块", () => {
    const needle = `${"mock"}.${"module"}(`;
    const offenders = sourceFiles
      .filter((file) => /\.(test|spec)\.tsx?$/.test(file))
      .filter((file) => stripComments(readFileSync(file, "utf8")).includes(needle))
      .map((file) => relative(PKG_ROOT, file));
    expect(offenders).toEqual([]);
  });

  // 会话守卫替身是本包用例唯一的认证接缝（宿主 `setTestAuth` 的包内等价物），它必须存在且被登记复位。
  test("包内守卫替身存在且登记了复位", () => {
    const guardStubs = readFileSync(resolve(PKG_ROOT, "src/__tests__/guard-stubs.ts"), "utf8");
    expect(guardStubs).toContain("createStubSessionAuthGuardPlugin");
    expect(guardStubs).toContain("registerStubResetter");
  });

  // exports 是本包对消费方的唯一解析入口，目标写错只在装配时才暴露，这里提前钉住。
  test("package.json 的每条 exports 目标都真实存在", () => {
    expect(exportEntries.length).toBeGreaterThan(0);
    const missing = exportEntries.filter(([, target]) => !existsSync(resolve(PKG_ROOT, target)));
    expect(missing.map(([key, target]) => `${key} → ${target}`)).toEqual([]);
  });

  // 只断言「目标存在」会漏掉**键被删掉**这一半，因此逐个键断言存在 + 目标路径。每条都对应一个真实
  // 消费方：`./module` 是模块清单入口，`./server` 是服务端装配面，`./server/testing` 由宿主
  // `test-utils/setup-mocks.ts` 与其它资源包消费，`./web` 是浏览器面（task / model-management /
  // workflow / 宿主控制台），`./web/i18n` 由宿主 i18n 在启动期注册 agents 命名空间。
  // 另有 4 条过渡子路径（`./server/runtime`、`./server/system-prompt`、`./server/api-agent-schema`、
  // `./server/config`）仍有宿主与 agent-runtime 的消费方，收敛到包根归宿主侧改动（见 README「已知项」），
  // 因此这里不断言它们的存续，否则收敛动作会让本用例误报。
  test("package.json 的 exports 键齐备且指向约定文件", () => {
    const expected: ReadonlyArray<readonly [string, string]> = [
      ["./module", "./fenix.module.ts"],
      ["./server", "./src/server.ts"],
      ["./server/testing", "./src/server/testing.ts"],
      ["./web", "./web/index.ts"],
      ["./web/i18n", "./web/i18n/index.ts"],
    ];
    for (const [key, target] of expected) {
      expect(manifest.exports?.[key], `exports 缺少 ${key}`).toBe(target);
    }
    // 根入口必须存在，且不得是浏览器入口：包根被服务端与装配层导入，指向 `web/**` 会把整张浏览器图
    // （React、Radix、编辑器页面）拖进模块注册与装配路径。
    expect(typeof manifest.exports?.["."]).toBe("string");
    expect(manifest.exports?.["."]?.startsWith("./web/")).toBe(false);
  });

  // README 是 §1 静态条件 6 的交付物，但「文件存在」不等于「五段式非占位」——把结构与体量钉住，
  // 缺段或退化成占位会在包内直接失败。
  test("README 为五段式且非占位", () => {
    const readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
    expect(readme.startsWith("# @fenix/agent-config")).toBe(true);
    const headings = readme.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual(["## 定位与 owner", "## 服务端交付物", "## web 面与 i18n", "## 边界残留", "## 已知项"]);
    const bodyLines = readme.split("\n").filter((line) => line.trim().length > 0);
    expect(bodyLines.length).toBeGreaterThanOrEqual(40);
    expect(readme).not.toMatch(/TODO|待补|占位/);
  });

  // 跨包只能走对方根入口的公开导出；深入 `@fenix/*/src` 会把别的包的内部实现拖进本包依赖面。
  test("跨包引用不深入其他包的 src 内部路径", () => {
    const offenders = refs.filter((ref) => /^@fenix\/[^/]+\/src(\/|$)/.test(ref.specifier));
    expect(offenders.map(describeRef)).toEqual([]);
  });
});
