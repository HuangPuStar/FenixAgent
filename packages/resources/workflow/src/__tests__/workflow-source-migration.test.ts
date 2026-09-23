// packages/resources/workflow/src/__tests__/workflow-source-migration.test.ts
// Workflow 的**包边界契约测试**（任务 1.3 §1 静态条件）。
//
// 为什么是「引用面断言」而不是「文件在某路径」：本包必须能在没有宿主解析环境（`apps/server` /
// `apps/web` 的 tsconfig 与 vite 别名）的情况下独立构建。文件路径证明不了这件事，源码字符串包含更
// 不行——`src/server.ts` 的导出面会随合法收敛继续变化，钉死文本会让测试在每次收敛后误报；反过来，
// 引用面只要出现一条宿主导入或一条越界相对路径，包就已经失去独立构建能力。
//
// 扫描口径：先剥注释（注释里会举例写出宿主别名与 `process.env`，直接匹配会误报），再取 import/export
// 说明符；`import type` 也算——类型导入同样把宿主路径写进包内，宿主解析环境一变就断。本测试只读文件、
// 不 import 被测模块，因此不会把被测代码的副作用（模块级单例、懒加载宿主端口等）带进来。
//
// 与沙盒黄金样本（`packages/resources/sandbox/src/__tests__/sandbox-source-migration.test.ts`）的差异：
// 沙盒有一张「宿主旧路径 → 包内新路径」的成对迁移表，而 workflow 的宿主旧实现（`routes/web/workflow*`、
// `pages/workflow/**`、`api/workflow*`）在本任务之前的切片里就已删除，HEAD 树里已不存在——把它们写成
// 「宿主路径已删除」的断言会恒真。这里改为两个有约束力的方向：宿主残留**副本**不得复活，以及
// **包内对 `@server/**` 零容忍**（表定义残留已随 §1.7 B6 归零，见下方 `SCANNER_FIXTURE` 的说明）。

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** 包根 `packages/resources/workflow`（本文件位于 `src/__tests__/`）。 */
const PKG_ROOT = resolve(import.meta.dir, "../..");
/** 仓库根；宿主侧断言都以它为基准。 */
const REPO_ROOT = resolve(PKG_ROOT, "../../..");
/** 包内源码入口；README 等文档里的示例不属于可解析引用，不参与扫描。 */
const SOURCE_ENTRIES = ["src", "web", "db", "fenix.module.ts"];

/**
 * 扫描器负例夹具（§4.7.1 ③ 的收缩形态）。
 *
 * 本包对宿主表定义的引用已随 §1.7 B6 归零（九张 workflow 表迁入本包 `db/`），原先那条「残留必然存在」
 * 的正向控制随之失效——它的作用是「扫不到就说明说明符提取失效」，而此刻扫不到才是正确结果。改用负例
 * 夹具承担同一职责：一段真实源码形状的字符串，含一条宿主导入与一条**注释里**形似导入的文本，断言语义
 * 是「前者必须被捞出、后者必须被剥掉」。
 *
 * **注释为什么必须是块注释形状**（B4 主体审计整改，2026-09-22，与沙盒黄金样本同步）：`SPECIFIER_PATTERNS`
 * 的 `from` 形式带 `^[ \t]*` 行首锚点，而行注释 `// import …` 的行首是 `/` 不是 `import`，未剥注释时
 * 本来就不在候选集里。用行注释做这条负例，`stripComments` 改成恒等也不会报红——夹具只验证了「捞出」
 * 那半条。块注释的中间行行首正是 `import`：未剥注释时会被捞出（`SCANNER_FIXTURE_COMMENTED` 钉住这一点），
 * 剥掉后才消失，两半缺一不可。
 *
 * 夹具按行以字符串字面量拼成，源码里 `import` 前面始终有引号，因此不会被本文件的真实扫描误判引用。
 */
const SCANNER_FIXTURE = [
  'import { x } from "@server/db/schema";',
  "/*",
  'import { y } from "@server/db/in-block-comment";',
  "*/",
  "const z = 1;",
].join("\n");

/** 夹具里那条藏在块注释中的形似导入：未剥注释时会被 `extractSpecifiers` 一并捞出。 */
const SCANNER_FIXTURE_COMMENTED = "@server/db/in-block-comment";

/**
 * 宿主侧不得再出现的 workflow 实现副本（相对仓库根）。
 *
 * 这些路径在本任务之前的切片里已删除；清单的作用是**防复活**——重建第二份实现会让宿主与包各自漂移，
 * 而两边都「能跑」时最难发现。
 */
const HOST_DUPLICATE_PATHS = [
  "apps/server/src/routes/web/workflow.ts",
  "apps/server/src/routes/web/workflow-defs.ts",
  "apps/server/src/routes/web/workflow-runs.ts",
  "apps/server/src/routes/web/workflow-engine.ts",
  "apps/server/src/routes/web/workflow-sse.ts",
  "apps/web/src/api/workflows.ts",
  "apps/web/src/api/workflow-defs.ts",
  "apps/web/src/api/workflow-engine.ts",
  "apps/web/src/api/workflow-sse.ts",
  "apps/web/src/pages/WorkflowPage.tsx",
  "apps/web/src/pages/workflow",
  "apps/web/src/__tests__/workflow-runs-page.test.tsx",
  "apps/web/src/__tests__/use-workflow-events.test.ts",
];

/**
 * 宿主里已知的**未引用残留**副本。
 *
 * `apps/web/src/lib/use-workflow-events.ts` 与包内 `web/lib/use-workflow-events.ts` **曾是同一份实现**
 * （`diff` 实测只差 1 行 import 说明符：宿主指向 `./context-queue`，包内指向
 * `@fenix/web-runtime/chat/context-queue`），差别不在逻辑而在依赖来源。宿主副本已随 W3 的宿主死副本
 * 清理删除；删除前它没有任何导入方，这里只断言「不得再被引用」——一旦谁把它接回去，宿主就重新拥有了
 * 一份 workflow 实现。文件不存在时断言由下方的 `existsSync` 守卫自然结束，路径常量保留正是为了让
 * 「接回」重新触发这条断言。
 */
const HOST_LEFTOVER_PATH = "apps/web/src/lib/use-workflow-events.ts";

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

describe("Workflow 包边界契约（任务 1.3 §1 静态条件）", () => {
  // 遍历有效性自检：walker 若只返回入口文件，后续「不存在违规引用」的断言会全部退化为恒真。
  test("扫描有效性自检：源码集合覆盖全包，且已知残留宿主导入能被扫到", () => {
    // `db/**` 也必须被钉住：它是本包九张表的落点，一旦从 `SOURCE_ENTRIES` 掉出去，往 `db/schema.ts`
    // 插一条真宿主导入不会有任何断言报红——「本包确实扫不到」与「db/ 根本没进扫描集」就分不开了
    // （B4 主体审计发现，2026-09-22；`sourceFiles.length` 的阈值比实际文件数低 20 余，兜不住单目录缺失）。
    for (const expected of [
      "fenix.module.ts",
      "db/schema.ts",
      "src/index.ts",
      "src/module.ts",
      "src/server.ts",
      "src/server/routes/api/workflows.ts",
      "src/server/routes/web/workflow-defs.ts",
      "src/server/routes/dependencies.ts",
      "src/server/repositories/workflow-def.ts",
      "src/server/testing.ts",
      "src/__tests__/guard-stubs.ts",
      "web/index.ts",
      "web/lib/use-workflow-events.ts",
      // `web/pages/WorkflowPage.tsx` 曾钉在这里；该页是宿主改文件路由后遗留的零消费死页，
      // 2026-09-22 随 tsconfig 门禁修复批删除（连带 `pages/workflow/workflow-path.ts` 与其用例），
      // 这里换上同目录的编辑器，继续钉住 `web/pages/**` 不掉出扫描集。
      "web/pages/workflow/WorkflowEditor.tsx",
    ]) {
      expect(sourceFiles).toContain(resolve(PKG_ROOT, expected));
    }
    expect(sourceFiles.length).toBeGreaterThanOrEqual(60);
    // 扫描器自检（负例夹具）分两半，缺一不可：
    //   1) 未剥注释时，块注释里的形似导入**必须**被捞出——证明夹具本身有区分力，而不是「恰好扫不到」；
    //   2) 剥掉注释后只剩真实导入——证明 `stripComments` 真的在起作用。
    expect(extractSpecifiers(SCANNER_FIXTURE)).toEqual(["@server/db/schema", SCANNER_FIXTURE_COMMENTED]);
    expect(extractSpecifiers(stripComments(SCANNER_FIXTURE))).toEqual(["@server/db/schema"]);
  });

  // 宿主实现只能经平台契约（`@fenix/platform-sdk`）或注入进入本包；§1.7 B6 之后**零容忍**。
  test("包内不存在任何宿主 @server 导入", () => {
    const offenders = refs.filter((ref) => ref.specifier.startsWith("@server/"));
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

  // 迁移会留下「指向包内不存在的文件」的相对路径：`import type` 在运行期被擦除，测试照旧全绿，
  // 但包已经不能独立类型检查（实测 round57 / round68 的 `../types/store` 就是这样漏进来的）。
  test("包内相对引用都能解析到真实文件", () => {
    const RESOLUTIONS = ["", ".ts", ".tsx", ".json", "/index.ts", "/index.tsx"];
    const unresolved = refs
      .filter((ref) => ref.specifier.startsWith("."))
      .filter((ref) => {
        // Bun 的 `?<flag>` 后缀（绕过模块缓存用的？round71 / ?round72）不参与文件解析，比较前先剥掉。
        const specifier = ref.specifier.replace(/\?.*$/, "");
        const base = resolve(dirname(ref.file), specifier);
        return !RESOLUTIONS.some((suffix) => existsSync(`${base}${suffix}`));
      });
    expect(unresolved.map(describeRef)).toEqual([]);
  });

  // 环境变量读取与校验统一在宿主（§1.5）：包内直读 `process.env` 会把部署知识复制进资源模块，
  // 两处默认值会分歧。标题刻意不写该字面量——本文件也在扫描范围内，标题会被自己扫成违规。
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

  // exports 是本包对宿主的唯一解析入口，目标写错只在宿主构建/装配时才暴露，这里提前钉住。
  test("package.json 的每条 exports 目标都真实存在", () => {
    expect(exportEntries.length).toBeGreaterThan(0);
    const missing = exportEntries.filter(([, target]) => !existsSync(resolve(PKG_ROOT, target)));
    expect(missing.map(([key, target]) => `${key} → ${target}`)).toEqual([]);
  });

  // `./module` 与 `./web` 是模块注册与浏览器装配的锚点：指错文件会让宿主取到错误的贡献形状。
  test("package.json 的 ./module 与 ./web 指向约定文件", () => {
    expect(manifest.exports?.["./module"]).toBe("./fenix.module.ts");
    expect(manifest.exports?.["./web"]).toBe("./web/index.ts");
    expect(manifest.exports?.["./server"]).toBe("./src/server.ts");
  });

  // 跨包只能走对方根入口的公开导出；深入 `@fenix/*/src` 会把别的包的内部实现拖进本包依赖面。
  test("跨包引用不深入其他包的 src 内部路径", () => {
    const offenders = refs.filter((ref) => /^@fenix\/[^/]+\/src(\/|$)/.test(ref.specifier));
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 路由目录按**协议前缀**分层，未在册的前缀意味着还留着旧布局的第二套入口。
  // 1.5c 新增 `hooks/`：Webhook 是无认证的独立协议面（既非控制台 `/web/*` 也非对外 `/api/*`），
  // 与 ACP、MCP 同类；加前缀必须在此登记，等同于一次布局评审。
  test("路由文件只出现在 routes/{web,api,hooks} 下", () => {
    const routeFiles = sourceFiles.filter((file) => file.includes("/server/routes/"));
    const strays = routeFiles.filter((file) => {
      const rel = relative(resolve(PKG_ROOT, "src/server/routes"), file);
      return !/^(web|api|hooks)\/[^/]+\.ts$/.test(rel) && rel !== "dependencies.ts";
    });
    expect(strays.map((file) => relative(PKG_ROOT, file))).toEqual([]);
    expect(routeFiles.length).toBeGreaterThanOrEqual(8);
  });

  // 一条 route 不得调用另一条 route 的业务逻辑（否则协议层与领域层粘连）；共享依赖只允许走 dependencies.ts。
  test("路由之间不互相引用（依赖面收敛在 routes/dependencies.ts）", () => {
    const routesDir = resolve(PKG_ROOT, "src/server/routes");
    const offenders: string[] = [];
    for (const file of sourceFiles.filter((candidate) => candidate.startsWith(`${routesDir}/`))) {
      if (file === join(routesDir, "dependencies.ts")) continue;
      for (const specifier of extractSpecifiers(stripComments(readFileSync(file, "utf8")))) {
        if (!specifier.startsWith(".")) continue;
        const target = resolve(dirname(file), specifier);
        if (target.startsWith(`${routesDir}/`) && target !== resolve(routesDir, "dependencies")) {
          offenders.push(`${relative(PKG_ROOT, file)} → ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // route 只做协议接入：直连 DB（drizzle / 表定义 / 包内 db 句柄）会绕过仓储层与多租户条件。
  test("路由不直接访问数据库", () => {
    const routesDir = resolve(PKG_ROOT, "src/server/routes");
    const offenders: string[] = [];
    for (const file of sourceFiles.filter((candidate) => candidate.startsWith(`${routesDir}/`))) {
      for (const specifier of extractSpecifiers(stripComments(readFileSync(file, "utf8")))) {
        if (
          specifier === "drizzle-orm" ||
          specifier.startsWith("drizzle-orm/") ||
          specifier === "@fenix/resource-workflow/db"
        ) {
          offenders.push(`${relative(PKG_ROOT, file)} → ${specifier}`);
          continue;
        }
        if (specifier.startsWith(".") && /\/server\/db$/.test(resolve(dirname(file), specifier))) {
          offenders.push(`${relative(PKG_ROOT, file)} → ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // 宿主不得复活 workflow 的第二份实现：两边各有一套时，改动会静默只落一边。
  test("宿主侧不存在 workflow 实现副本", () => {
    const survivors = HOST_DUPLICATE_PATHS.filter((hostPath) => existsSync(resolve(REPO_ROOT, hostPath)));
    expect(survivors).toEqual([]);
  });

  // 已知残留副本必须保持「未引用」：被接回宿主就等于宿主重新拥有了一份 workflow 实现。
  test("宿主残留副本不得被任何宿主文件引用", () => {
    const leftover = resolve(REPO_ROOT, HOST_LEFTOVER_PATH);
    if (!existsSync(leftover)) return; // 宿主 owner 删除后本断言自然结束
    const appsRoot = resolve(REPO_ROOT, "apps");
    const importers: string[] = [];
    for (const file of listPackageFiles(appsRoot)) {
      if (file === leftover) continue;
      for (const specifier of extractSpecifiers(stripComments(readFileSync(file, "utf8")))) {
        if (!specifier.startsWith(".")) continue;
        if (resolve(dirname(file), specifier) === leftover) importers.push(relative(REPO_ROOT, file));
      }
    }
    expect(importers).toEqual([]);
  });
});
