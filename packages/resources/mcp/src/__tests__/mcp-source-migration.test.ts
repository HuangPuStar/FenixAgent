// packages/resources/mcp/src/__tests__/mcp-source-migration.test.ts
// MCP 的**包边界契约测试**（任务 1.3 §1 静态条件）。
//
// 为什么是引用面断言而不是「文件在某个路径」：本包必须能在没有宿主解析环境（`apps/server` /
// `apps/web` 的 tsconfig 与 vite 别名）的情况下独立构建。「文件已存在」证明不了这件事，源码字符串
// 包含更不行；反过来，引用面只要出现一条宿主导入，包就已经失去独立构建能力。
//
// 扫描口径：先剥注释（注释里会举例写出宿主别名/端点，直接匹配会误报），再取 import/export 说明符；
// `import type` 也算——类型导入同样把宿主路径写进包内。本测试只读文件、不 import 被测模块，
// 因此不会把被测代码的副作用（懒加载宿主单例等）带进来。

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** 包根 `packages/resources/mcp`（本文件位于 `src/__tests__/`）。 */
const PKG_ROOT = resolve(import.meta.dir, "../..");
/** 仓库根；宿主旧路径与残留路径都以它为基准记录。 */
const REPO_ROOT = resolve(PKG_ROOT, "../../..");
/** 包内源码入口；README 等文档里的示例不属于可解析引用，不参与扫描。 */
const SOURCE_ENTRIES = ["src", "web", "fenix.module.ts"];

/**
 * 唯一允许的宿主导入。
 *
 * 表定义迁出归任务 1.7，本任务把它作为**显式残留**保留（见任务 1.3 实施记录 §5），
 * 且只允许这一条精确路径：`@server/db/schema` 之下的任何深路径都意味着重新伸手取宿主内部。
 */
const ALLOWED_HOST_IMPORT = "@server/db/schema";

/**
 * 迁移映射（宿主旧路径 → 包内新 owner 路径）。
 *
 * 记成「一对」而不是两份清单：旧路径残留（第二份实现复活）与新路径缺失是同一次迁移失败的两种
 * 表现，成对记录才能让失败信息同时指出两端。清单来自 PHY-05 资源闭包的 rename 记录
 * （`git show --name-status -M 0b4ec5858`，server 侧取 `src/**`、web 侧取 `web/src/**`）。
 *
 * `apps/web/src/routes/agent/_panel/mcp.tsx` 保留在宿主是既定分工（WebShell 薄 route adapter，归 §1.6），
 * 不在本清单里，不要当成残留删除。`apps/server/src/services/config/mcp-system-server.ts`（宿主系统初始化
 * 路径的薄包装）原先同属保留面，后经任务 1.5c 核验：它的唯一端口 `RegisterSystemMcpServer` 从未被注入、
 * 宿主侧零生产消费方，已按「删除优于兼容」删除（见 review/task-1.5-host-aggregation.md §1.5c-8），
 * 同样不属于本清单的迁移残留。
 */
const MIGRATION_PAIRS: ReadonlyArray<readonly [hostPath: string, packagePath: string]> = [
  ["apps/server/src/routes/api/mcp.ts", "src/server/routes/api/mcp.ts"],
  ["apps/server/src/routes/mcp/knowledge.ts", "src/server/routes/mcp/knowledge.ts"],
  ["apps/server/src/routes/web/config/mcp.ts", "src/server/routes/web/config/mcp.ts"],
  ["apps/server/src/schemas/mcp-knowledge.schema.ts", "src/server/schemas/mcp-knowledge.schema.ts"],
  ["apps/server/src/services/config/agent-config-mcp.ts", "src/server/services/config/agent-config-mcp.ts"],
  ["apps/server/src/services/config/mcp-server.ts", "src/server/services/config/mcp-config.ts"],
  ["apps/server/src/services/mcp-inspector.ts", "src/server/services/mcp-inspector.ts"],
  ["apps/server/src/__tests__/mcp-inspector.test.ts", "src/__tests__/mcp-inspector.test.ts"],
  ["apps/server/src/__tests__/mcp-server-info.test.ts", "src/__tests__/mcp-server-info.test.ts"],
  ["apps/server/src/__tests__/round40-mcp-config-routes.test.ts", "src/__tests__/round40-mcp-config-routes.test.ts"],
  ["apps/server/src/__tests__/round47-api-mcp-routes.test.ts", "src/__tests__/round47-api-mcp-routes.test.ts"],
  ["apps/server/src/__tests__/round66-mcp-config-routes.test.ts", "src/__tests__/round66-mcp-config-routes.test.ts"],
  ["apps/web/src/api/mcp.ts", "web/api/mcp.ts"],
  ["apps/web/src/lib/mcp-resource-access.ts", "web/lib/mcp-resource-access.ts"],
  ["apps/web/src/pages/agent-panel/pages/AgentMcpPage.tsx", "web/pages/agent-panel/pages/AgentMcpPage.tsx"],
  ["apps/web/src/pages/agent-panel/pages/agent-mcp-catalog.tsx", "web/pages/agent-panel/pages/agent-mcp-catalog.tsx"],
  ["apps/web/src/pages/agent-panel/pages/agent-mcp-dialog.tsx", "web/pages/agent-panel/pages/agent-mcp-dialog.tsx"],
  ["apps/web/src/pages/agent-panel/pages/agent-mcp-utils.ts", "web/pages/agent-panel/pages/agent-mcp-utils.ts"],
  ["apps/web/src/i18n/locales/en/mcp.json", "web/i18n/locales/en/mcp.json"],
  ["apps/web/src/i18n/locales/zh/mcp.json", "web/i18n/locales/zh/mcp.json"],
  ["apps/web/src/__tests__/config-mcp-api-client.test.ts", "web/__tests__/config-mcp-api-client.test.ts"],
  ["apps/web/src/__tests__/config-mcp-types.test.ts", "web/__tests__/config-mcp-types.test.ts"],
  ["apps/web/src/__tests__/mcp-resource-access-flow.test.ts", "web/__tests__/mcp-resource-access-flow.test.ts"],
];

/** README 的五个小节：本包交付物的一部分，缺节或占位会让读者以为能力不存在。 */
const README_SECTIONS = ["## 职责", "## 依赖边界", "## 守卫由宿主注入", "## 配置与 DB", "## 边界外的已知项"];

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
const manifestSource = readFileSync(join(PKG_ROOT, "fenix.module.ts"), "utf8");

describe("MCP 包边界契约（任务 1.3 §1 静态条件）", () => {
  // 遍历有效性自检：walker 若只返回入口文件，后续「不存在违规引用」的断言会全部退化为恒真。
  test("扫描有效性自检：源码集合覆盖全包，且表定义残留能被扫到", () => {
    for (const expected of [
      "fenix.module.ts",
      "src/module.ts",
      "src/server.ts",
      "src/server/db.ts",
      "src/server/routes/dependencies.ts",
      "src/server/routes/api/mcp.ts",
      "src/server/routes/mcp/knowledge.ts",
      "src/server/routes/web/config/mcp.ts",
      "src/__tests__/guard-stubs.ts",
      "web/index.ts",
      "web/i18n/index.ts",
      "web/api/mcp.ts",
      "web/pages/agent-panel/pages/AgentMcpPage.tsx",
    ]) {
      expect(sourceFiles).toContain(resolve(PKG_ROOT, expected));
    }
    expect(sourceFiles.length).toBeGreaterThanOrEqual(40);
    // 正向控制：表定义残留必然存在，扫不到就说明说明符提取失效（而不是「没有宿主导入」）。
    expect(refs.filter((ref) => ref.specifier === ALLOWED_HOST_IMPORT).length).toBeGreaterThan(0);
  });

  // 宿主侧不得保留第二份实现，否则新旧两套会各自漂移（“删除优于兼容”，不留兼容层）。
  test("MCP 宿主旧路径已全部删除", () => {
    const survivors = MIGRATION_PAIRS.map(([hostPath]) => hostPath).filter((hostPath) =>
      existsSync(resolve(REPO_ROOT, hostPath)),
    );
    expect(survivors).toEqual([]);
  });

  // 迁移必须落到包内约定目录：宿主旧文件删了但新实现没落地，等于能力直接消失。
  test("MCP 文件均落在包内新 owner 路径", () => {
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

  // 环境变量读取与校验统一在宿主（§1.5）：包内直读会把部署知识复制进资源模块，两处默认值会分歧。
  // 标题与正则刻意不写出该字面量——本文件也在扫描范围内，写了会被自己扫成违规。
  test("包内 src 不直读宿主环境变量", () => {
    const offenders = filesUnder("src").flatMap((file) => {
      const code = stripComments(readFileSync(file, "utf8"));
      return code
        .split("\n")
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => /\bprocess\.env\b/.test(line))
        .map(({ number }) => `${relative(PKG_ROOT, file)}:${number}`);
    });
    expect(offenders).toEqual([]);
  });

  // exports 是本包对宿主与其他包的唯一解析入口，目标写错只在宿主构建/装配时才暴露，这里提前钉住。
  test("package.json 的每条 exports 目标都真实存在", () => {
    expect(exportEntries.length).toBeGreaterThan(0);
    const missing = exportEntries.filter(([, target]) => !existsSync(resolve(PKG_ROOT, target)));
    expect(missing.map(([key, target]) => `${key} → ${target}`)).toEqual([]);
  });

  // `./module`、`./web`、`./web/i18n` 分别是模块注册、浏览器装配与 i18n 资源注册的锚点：
  // 指错文件会让宿主取到错误的贡献形状（i18n 尤其静默——少注册一个 namespace 只表现为文案回显 key）。
  test("package.json 的 ./module 与 ./web 指向约定文件", () => {
    expect(manifest.exports?.["./module"]).toBe("./fenix.module.ts");
    expect(manifest.exports?.["./web"]).toBe("./web/index.ts");
    expect(manifest.exports?.["./web/i18n"]).toBe("./web/i18n/index.ts");
  });

  // 跨包只能走对方根入口的公开导出；深入 `@fenix/*/src` 会把别的包的内部实现拖进本包依赖面。
  test("跨包引用不深入其他包的 src 内部路径", () => {
    const offenders = refs.filter((ref) => /^@fenix\/[^/]+\/src(\/|$)/.test(ref.specifier));
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 跨包直读表是授权与 schema 双份真相的来源：本包只允许读自己的表（`@server/db/schema` 残留）。
  test("不引用其他包的 schema 出口", () => {
    const offenders = refs.filter((ref) => /^@fenix\/[^/]+\/(server\/)?schema(\/|$)/.test(ref.specifier));
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // route 调 route 会把鉴权与协议映射变成两条入口（第二个 route 决定不了第一个的守卫），
  // 因此路由之间只允许共享 `routes/dependencies.ts` 这类纯类型文件（它由下一个用例单独约束）。
  test("路由之间不存在相互导入", () => {
    const routesDir = resolve(PKG_ROOT, "src/server/routes");
    const sharedTypesFile = join(routesDir, "dependencies.ts");
    /** 说明符不带扩展名，逐个候选解析出真实文件；命中共享类型文件即视为合法。 */
    const resolveTarget = (from: string, specifier: string): string[] => {
      const base = resolve(dirname(from), specifier);
      return [base, `${base}.ts`, `${base}.tsx`];
    };
    const offenders = refs
      .filter((ref) => ref.file.startsWith(`${routesDir}/`) && ref.specifier.startsWith("."))
      .filter((ref) => {
        const targets = resolveTarget(ref.file, ref.specifier);
        if (targets.includes(ref.file)) return false;
        if (targets.includes(sharedTypesFile)) return false;
        return targets.some((target) => target.startsWith(`${routesDir}/`));
      });
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 守卫必须可注入：会话鉴权路由导出工厂（无 default export），否则宿主接不回自己的认证实例。
  // 例外是 `/mcp/knowledge` 的模块级单例（Bearer 自鉴权，无注入点），此处只断言两个会话路由。
  test("会话鉴权路由以工厂形式导出，不保留已构造的 default 实例", () => {
    for (const routePath of ["src/server/routes/api/mcp.ts", "src/server/routes/web/config/mcp.ts"]) {
      const code = stripComments(readFileSync(resolve(PKG_ROOT, routePath), "utf8"));
      expect(code).toMatch(/export function create\w+Routes\(deps: McpRouteDependencies\)/);
      expect(code).not.toMatch(/export default/);
      expect(code).toContain(".use(deps.authGuardPlugin)");
    }
  });

  // 依赖文件只放类型：一旦它引入运行时代码，工厂与包入口之间就会出现循环导入。
  test("routes/dependencies.ts 只有类型导入", () => {
    const code = stripComments(readFileSync(resolve(PKG_ROOT, "src/server/routes/dependencies.ts"), "utf8"));
    const importLines = code.split("\n").filter((line) => /^[ \t]*import\b/.test(line));
    expect(importLines.length).toBeGreaterThan(0);
    expect(importLines.filter((line) => !line.includes("import type"))).toEqual([]);
  });

  // 模块 id 是 registry 的索引键：清单与组合根不一致会让装配取到别的模块（或取不到）。
  test("fenix.module.ts 声明 id 且 create 指向包内组合根", () => {
    expect(manifestSource).toContain('id: "mcp"');
    const moduleSource = readFileSync(resolve(PKG_ROOT, "src/module.ts"), "utf8");
    // 组合根产出真实模块实例（返回 `McpServerServerModule`），不再是装配结果的命名空间包装。
    expect(moduleSource).toContain(
      "export function createMcpModule(context: ModuleFactoryContext): McpServerServerModule",
    );
    // create 指向组合根且保持惰性（registry 会被大量位置导入，不能在索引层拉起 Drizzle/Elysia）。
    expect(manifestSource).toContain(
      'create: (context) => import("./src/module").then((module) => module.createMcpModule(context))',
    );
  });

  // README 是交付物的一部分：缺节或占位会让读者以为能力不存在（本包 README 曾写「没有 web 出口」）。
  test("README 五节齐备且非占位", () => {
    const readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
    const missing = README_SECTIONS.filter((section) => !readme.includes(section));
    expect(missing).toEqual([]);
    expect(readme.length).toBeGreaterThanOrEqual(1500);
    for (const placeholder of ["TODO", "待补", "占位", "Lorem", "<待"]) {
      expect(readme).not.toContain(placeholder);
    }
  });
});
