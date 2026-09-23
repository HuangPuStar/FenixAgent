// packages/resources/task/src/__tests__/task-source-migration.test.ts
// Task 的**包边界契约测试**（任务 1.3 §1 静态条件）。
//
// 为什么断言引用面而不是文本：本包必须能在没有宿主解析环境（`apps/server` / `apps/web` 的 tsconfig 与
// vite 别名）的情况下独立构建，「文件在某个路径」证明不了这件事，源码字符串包含更不行——导出面仍在
// 收敛，钉死文本会让测试在每次合法收敛后误报；反过来，引用面只要出现一条宿主导入，包就失去了独立构建能力。
//
// 扫描口径：先剥注释（注释里会举例写出宿主别名与旧路径，直接匹配会误报），再取 import/export 说明符；
// `import type` 也算——类型导入同样把宿主路径写进包内，宿主解析环境一变就断。本文件只读文件、不 import
// 被测模块，因此不会把被测代码的副作用（模块加载期取 DB 句柄等）带进来。
//
// 与黄金样本 `packages/resources/sandbox/src/__tests__/sandbox-source-migration.test.ts` 的差异及理由：
// 样本版只覆盖 6/8 条静态条件（实测）——缺「exports 键存在性」与「README 非占位」
// 两组断言，删掉 `exports["./server"]` 或把 README 换成单行占位都不会让它变红。这里补上两组，并把条件 7
// 从「不深入 `@fenix/*/src`」加强为「每条 `@fenix/*` 都能解析到对方 `exports` 声明的公开键」。

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** 包根 `packages/resources/task`（本文件位于 `src/__tests__/`）。 */
const PKG_ROOT = resolve(import.meta.dir, "../..");
/** 仓库根；宿主路径与旧路径都以它为基准记录。 */
const REPO_ROOT = resolve(PKG_ROOT, "../../..");
/** 包内源码入口；README 等文档里的示例不属于可解析引用，不参与说明符扫描。 */
const SOURCE_ENTRIES = ["src", "web", "db", "fenix.module.ts"];

/**
 * 本包 `./db` 出口（§1.7 B12 起表定义归本包）。
 *
 * 包内仓储经该出口**自我引用**取表对象与行类型（`db/` 不在本包 `tsconfig.json` 的 `include` 里，走出口
 * 与外部消费方同一条解析路径）；宿主的 `task-schema.test.ts` 也引用它。
 *
 * 它同时充当条件 1 的**正向控制**：B12 之前这里放的是「唯一允许的宿主残留」`@server/db/schema`（迁出前
 * 6 处导入，见任务 1.3 实施记录 §四），残留归零后若继续沿用它，正向控制会恒为 0——说明符提取一旦失效
 * （而不是「真的没有宿主导入」），条件 1 就会静默通过。故改钉这条必然存在的包内引用。
 */
const PKG_DB_EXPORT = "@fenix/resource-task/db";

/**
 * 迁移映射（宿主旧路径 → 包内新 owner 路径），依据迁移提交 `d7a2194fe` 的 rename 记录。
 *
 * 记成「一对」而不是两份清单：旧路径残留（第二份实现复活）与新路径缺失是同一次迁移失败的两种表现，
 * 成对记录才能让失败信息同时指出两端。
 *
 * 为什么每对只有一份「宿主内相对路径」，却要在两个根下各查一次：物理迁移分两步完成——文件先位于仓库根的
 * `src/**`（服务端）与 `web/src/**`（浏览器），随后宿主收敛到 `apps/server/src/**` 与 `apps/web/src/**`。
 * 两个落点都可能被误恢复成「宿主侧第二份实现」，只查后者会让前者的复活静默通过。
 *
 * 注意 `apps/web/src/routes/agent/_panel/tasks.tsx` 保留在宿主是既定分工（WebShell 薄 route adapter，
 * 归 §1.6），不在本清单里，不要当成残留删除。
 */
interface MigrationPair {
  /** 源码树归属：服务端查 `src/` 与 `apps/server/src/`，浏览器查 `web/src/` 与 `apps/web/src/`。 */
  readonly side: "server" | "web";
  /** 宿主内相对路径（省略上面的源码树前缀）。 */
  readonly innerPath: string;
  /** 包内新 owner 路径（相对包根）。 */
  readonly packagePath: string;
}

const MIGRATION_PAIRS: readonly MigrationPair[] = [
  { side: "server", innerPath: "repositories/task-v2.ts", packagePath: "src/server/repositories/task-v2.ts" },
  { side: "server", innerPath: "repositories/task.ts", packagePath: "src/server/repositories/task.ts" },
  { side: "server", innerPath: "routes/web/tasks-v2.ts", packagePath: "src/server/routes/web/tasks-v2.ts" },
  { side: "server", innerPath: "schemas/task-v2.schema.ts", packagePath: "src/server/schemas/task-v2.schema.ts" },
  { side: "server", innerPath: "services/task-v2.ts", packagePath: "src/server/services/task-v2.ts" },
  {
    side: "server",
    innerPath: "services/scheduler/index.ts",
    packagePath: "src/server/services/scheduler/index.ts",
  },
  {
    side: "server",
    innerPath: "services/scheduler/agent-executor.ts",
    packagePath: "src/server/services/scheduler/agent-executor.ts",
  },
  {
    side: "server",
    innerPath: "services/scheduler/http-executor.ts",
    packagePath: "src/server/services/scheduler/http-executor.ts",
  },
  { side: "server", innerPath: "services/scheduler/types.ts", packagePath: "src/server/services/scheduler/types.ts" },
  { side: "server", innerPath: "services/scheduler/utils.ts", packagePath: "src/server/services/scheduler/utils.ts" },
  {
    side: "server",
    innerPath: "__tests__/agent-executor.test.ts",
    packagePath: "src/__tests__/agent-executor.test.ts",
  },
  {
    side: "server",
    innerPath: "__tests__/round17-task-v2-service.test.ts",
    packagePath: "src/__tests__/round17-task-v2-service.test.ts",
  },
  {
    side: "server",
    innerPath: "__tests__/round55-tasks-v2-routes.test.ts",
    packagePath: "src/__tests__/round55-tasks-v2-routes.test.ts",
  },
  {
    side: "server",
    innerPath: "__tests__/round60-scheduler-http-executor.test.ts",
    packagePath: "src/__tests__/round60-scheduler-http-executor.test.ts",
  },
  {
    side: "server",
    innerPath: "__tests__/scheduler-http-executor-coverage.test.ts",
    packagePath: "src/__tests__/scheduler-http-executor-coverage.test.ts",
  },
  {
    side: "server",
    innerPath: "__tests__/scheduler-invocation-date-guard.test.ts",
    packagePath: "src/__tests__/scheduler-invocation-date-guard.test.ts",
  },
  {
    side: "server",
    innerPath: "__tests__/scheduler-stale-job-cleanup.test.ts",
    packagePath: "src/__tests__/scheduler-stale-job-cleanup.test.ts",
  },
  {
    side: "server",
    innerPath: "__tests__/task-timeout-instanceof-error.test.ts",
    packagePath: "src/__tests__/task-timeout-instanceof-error.test.ts",
  },
  {
    side: "server",
    innerPath: "__tests__/task-v2-service-coverage.test.ts",
    packagePath: "src/__tests__/task-v2-service-coverage.test.ts",
  },
  {
    side: "server",
    innerPath: "__tests__/task-v2-validation.test.ts",
    packagePath: "src/__tests__/task-v2-validation.test.ts",
  },
  { side: "web", innerPath: "api/tasks-v2.ts", packagePath: "web/api/tasks-v2.ts" },
  { side: "web", innerPath: "i18n/locales/en/tasks-v2.json", packagePath: "web/i18n/locales/en/tasks-v2.json" },
  { side: "web", innerPath: "i18n/locales/zh/tasks-v2.json", packagePath: "web/i18n/locales/zh/tasks-v2.json" },
  { side: "web", innerPath: "pages/agent-panel/TasksPanel.tsx", packagePath: "web/pages/agent-panel/TasksPanel.tsx" },
  {
    side: "web",
    innerPath: "pages/agent-panel/components/CronEditor.tsx",
    packagePath: "web/pages/agent-panel/components/CronEditor.tsx",
  },
  {
    side: "web",
    innerPath: "pages/agent-panel/components/TaskForm.tsx",
    packagePath: "web/pages/agent-panel/components/TaskForm.tsx",
  },
  {
    side: "web",
    innerPath: "pages/agent-panel/components/TaskLogDialog.tsx",
    packagePath: "web/pages/agent-panel/components/TaskLogDialog.tsx",
  },
  {
    side: "web",
    innerPath: "pages/agent-panel/pages/AgentTasksPage.tsx",
    packagePath: "web/pages/agent-panel/pages/AgentTasksPage.tsx",
  },
  {
    side: "web",
    innerPath: "pages/agent-panel/pages/agent-task-runtime-board.tsx",
    packagePath: "web/pages/agent-panel/pages/agent-task-runtime-board.tsx",
  },
  {
    side: "web",
    innerPath: "pages/agent-panel/pages/agent-tasks-registry.tsx",
    packagePath: "web/pages/agent-panel/pages/agent-tasks-registry.tsx",
  },
  {
    side: "web",
    innerPath: "pages/agent-panel/pages/agent-tasks-utils.ts",
    packagePath: "web/pages/agent-panel/pages/agent-tasks-utils.ts",
  },
  {
    side: "web",
    innerPath: "pages/agent-panel/pages/agent-tasks.css",
    packagePath: "web/pages/agent-panel/pages/agent-tasks.css",
  },
  {
    side: "web",
    innerPath: "__tests__/agent-tasks-utils.test.ts",
    packagePath: "web/__tests__/agent-tasks-utils.test.ts",
  },
  {
    side: "web",
    innerPath: "__tests__/cron-editor-high-gap-pure.test.ts",
    packagePath: "web/__tests__/cron-editor-high-gap-pure.test.ts",
  },
  {
    side: "web",
    innerPath: "__tests__/cron-editor-pure.test.ts",
    packagePath: "web/__tests__/cron-editor-pure.test.ts",
  },
  {
    side: "web",
    innerPath: "__tests__/cron-editor-round38-pure.test.ts",
    packagePath: "web/__tests__/cron-editor-round38-pure.test.ts",
  },
  { side: "web", innerPath: "__tests__/cron-editor.test.tsx", packagePath: "web/__tests__/cron-editor.test.tsx" },
];

/** 历史源码树前缀：迁移前宿主把服务端放仓库根 `src/`、浏览器放仓库根 `web/src/`。 */
const LEGACY_SOURCE_ROOT: Record<MigrationPair["side"], string> = { server: "src", web: "web/src" };
/** 当前源码树前缀：宿主已收敛到 `apps/<app>/src`。 */
const CURRENT_SOURCE_ROOT: Record<MigrationPair["side"], string> = { server: "apps/server/src", web: "apps/web/src" };

/** 某个迁移对在宿主侧的全部候选落点（历史与当前两处，任一存在都算第二份实现复活）。 */
function hostCandidates(pair: MigrationPair): string[] {
  return [
    resolve(REPO_ROOT, LEGACY_SOURCE_ROOT[pair.side], pair.innerPath),
    resolve(REPO_ROOT, CURRENT_SOURCE_ROOT[pair.side], pair.innerPath),
  ];
}

/**
 * README 五段式（§1 静态条件 6）。
 *
 * 标题逐字固定：W1 十二包共用同一套骨架，改标题会让「五段式」在各包之间失去可比性；非占位由正文长度与
 * 占位词断言共同保证——单行占位文本过不了 120 字的下限。
 */
const REQUIRED_README_SECTIONS = ["## 职责", "## 依赖边界", "## 守卫由宿主注入", "## 配置与 DB", "## 边界外的已知项"];
const PLACEHOLDER_PATTERN = /^\s*(?:TODO|TBD|待补|待写|占位)/i;
/** 单段正文的最短长度（去掉标题后的字符数）：低于此值说明段落只是标题下的占位行。 */
const MIN_SECTION_LENGTH = 120;

/**
 * 条件 3 的越界字面量（三段上跳 + 宿主 web 目录）。
 *
 * 刻意由片段拼出而不是整体写出：本文件自身也在扫描范围内，整体写出会让断言扫到自己的字面量而恒红；
 * 同时保证包内 `git grep` 口径下条件 3 的命中数保持 0（命中的应是宿主残留，不是守卫自身）。
 */
const ESCAPE_LITERAL = "../".repeat(3);
const HOST_WEB_LITERAL = ["apps", "web"].join("/");

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

/**
 * `mock.module()` 的实参说明符。
 *
 * 它是函数调用而不是 import/export 语句，`SPECIFIER_PATTERNS` 提取不到，但解析语义与 import 相同，
 * 因此单独抽取（用途见「包内 mock.module 的说明符不含宿主别名 @/」用例）。
 */
const MOCK_MODULE_PATTERN = /\bmock\.module\(\s*["']([^"']+)["']/g;

function mockSpecifiers(code: string): string[] {
  return [...code.matchAll(MOCK_MODULE_PATTERN)].map((match) => match[1]);
}

/** 自检样例里的宿主别名由片段拼出：本文件也在说明符扫描范围内，整体写出会让条件 2 的口径命中守卫自身。 */
const HOST_ALIAS_LITERAL = ["@", "src/i18n"].join("/");

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

const readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");

/** 按 `## ` 切段；返回「段落标题 → 正文」。 */
function readmeSections(): Map<string, string> {
  const sections = new Map<string, string>();
  const chunks = readme.split(/^## /m).slice(1);
  for (const chunk of chunks) {
    const [firstLine = "", ...rest] = chunk.split("\n");
    sections.set(`## ${firstLine.trim()}`, rest.join("\n").trim());
  }
  return sections;
}

/**
 * 工作区内已发布的包名 → 其 `package.json` 路径。
 *
 * 只扫 `packages/` 下三层目录并跳过 `node_modules`：本仓库的包深度固定在 `packages/<层>/<包名>`，够用且
 * 不必递归全仓（深层 node_modules 会让扫描耗时不可控）。
 */
function collectWorkspaceManifests(): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (absDir: string, depth: number): void => {
    if (depth > 2 || !existsSync(absDir)) return;
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const child = join(absDir, entry.name);
      if (!entry.isDirectory()) continue;
      const manifestPath = join(child, "package.json");
      if (existsSync(manifestPath)) {
        const name = (JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string }).name;
        if (name && !found.has(name)) found.set(name, manifestPath);
      }
      walk(child, depth + 1);
    }
  };
  walk(join(REPO_ROOT, "packages"), 0);
  return found;
}

const workspaceManifests = collectWorkspaceManifests();

/** `@fenix/<包名>[/<子路径>]` 对应的 exports 键：根入口是 `.`，子路径是 `./<子路径>`。 */
function exportKeyFor(specifier: string): { packageName: string; key: string } {
  const segments = specifier.split("/");
  const packageName = segments.slice(0, 2).join("/");
  const subPath = segments.slice(2).join("/");
  return { packageName, key: subPath ? `./${subPath}` : "." };
}

/** 声明键是否覆盖目标键：支持 `./ui/*` 这类通配声明（Node 的 exports 通配语义）。 */
function matchesExportKey(declared: string, wanted: string): boolean {
  const star = declared.indexOf("*");
  if (star === -1) return declared === wanted;
  return wanted.startsWith(declared.slice(0, star)) && wanted.endsWith(declared.slice(star + 1));
}

describe("Task 包边界契约（任务 1.3 §1 静态条件）", () => {
  // 遍历有效性自检：walker 若只返回入口文件，后续「不存在违规引用」的断言会全部退化为恒真。
  test("扫描有效性自检：源码集合覆盖全包，且已知残留宿主导入能被扫到", () => {
    for (const expected of [
      "fenix.module.ts",
      "src/index.ts",
      "src/module.ts",
      "src/server.ts",
      "src/server/db.ts",
      "src/server/routes/dependencies.ts",
      "src/server/routes/web/tasks-v2.ts",
      "src/server/repositories/task-v2.ts",
      "src/server/services/scheduler/index.ts",
      "src/__tests__/guard-stubs.ts",
      "src/__tests__/db-stub.ts",
      "db/schema.ts",
      "web/index.ts",
      "web/i18n/index.ts",
      "web/api/tasks-v2.ts",
      "web/pages/agent-panel/TasksPanel.tsx",
      "web/__tests__/task-browser-surface.test.ts",
    ]) {
      expect(sourceFiles).toContain(resolve(PKG_ROOT, expected));
    }
    expect(sourceFiles.length).toBeGreaterThanOrEqual(40);
    // 正向控制：条件 1 的目标（`@server/**`）自 B12 起恒为空，故改钉一条必然存在的包内值导入——说明符
    // 提取失效时它会先变红，而不是让「不存在违规引用」退化成恒真。
    expect(refs).toContainEqual(
      expect.objectContaining({
        file: resolve(PKG_ROOT, "src/server/repositories/task-v2.ts"),
        specifier: PKG_DB_EXPORT,
      }),
    );
  });

  // 迁移完成后宿主侧不得保留 Task 的第二份实现，否则新旧两套会各自漂移（§1 静态条件 8）。
  test("Task 宿主旧路径已全部删除（历史仓库根与当前 apps/* 两个落点）", () => {
    const survivors = MIGRATION_PAIRS.flatMap((pair) =>
      hostCandidates(pair).filter((candidate) => existsSync(candidate)),
    );
    expect(survivors).toEqual([]);
  });

  // 迁移必须落到包内约定目录：宿主旧文件删了但新实现没落地，等于能力直接消失。
  test("Task 文件均落在包内新 owner 路径", () => {
    const missing = MIGRATION_PAIRS.map((pair) => pair.packagePath).filter(
      (packagePath) => !existsSync(resolve(PKG_ROOT, packagePath)),
    );
    expect(missing).toEqual([]);
  });

  // 宿主实现只能经平台契约（`@fenix/platform-sdk`）或注入进入本包（§1 静态条件 1）。表定义自 §1.7 B12
  // 起归本包 `db/`，原先「表定义残留」这条唯一例外随之消失，断言改为零容忍：任何 `@server/**` 都违规。
  test("包内不存在宿主 @server 导入", () => {
    const offenders = refs.filter((ref) => ref.specifier.startsWith("@server/"));
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 宿主别名（`@/src`、`@/components`）由 apps/web 的 tsconfig/vite 提供，包离开宿主就解析不了（§1 静态条件 2）。
  test("包内 web 不引用宿主别名 @/", () => {
    const offenders = refs.filter((ref) => ref.specifier.startsWith("@/") && webFiles.has(ref.file));
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 条件 2 的盲区：`mock.module()` 的实参是普通函数调用的参数，不在 import/export 说明符扫描范围内，
  // 但它的解析语义与 import 相同——写成宿主别名时包在宿主内跑得通、单独跑就解析不到。W2 收尾时
  // `web/__tests__/cron-editor.test.tsx` 就残留过这样一条死 mock（无任何 import 方消费该说明符），
  // 说明符扫描与浏览器面守卫都没报。这里按包内全量扫（mock 的解析发生在测试运行期，与文件位置无关）。
  test("包内 mock.module 的说明符不含宿主别名 @/", () => {
    // 正例自检：抽取器若因写法变化而失配，下面的断言会退化成恒真的空列表。
    expect(mockSpecifiers(`mock.module(${JSON.stringify(HOST_ALIAS_LITERAL)}, () => ({}))`)).toEqual([
      HOST_ALIAS_LITERAL,
    ]);
    const offenders = sourceFiles.flatMap((file) =>
      mockSpecifiers(stripComments(readFileSync(file, "utf8")))
        .filter((specifier) => specifier.startsWith("@/"))
        .map((specifier) => `${relative(PKG_ROOT, file)} → ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  // 相对路径是最隐蔽的越界方式：上跳三级指向宿主 web 源码树在宿主内能跑通，包单独构建时目录不存在
  // （§1 静态条件 3）。标题不写出该字面量（本文件也在扫描范围内），断言用片段拼接的常量。
  test("包内不存在穿透到包外的相对路径引用", () => {
    const escaping = refs.filter((ref) => ref.specifier.startsWith(".") && escapesPackage(ref.file, ref.specifier));
    expect(escaping.map(describeRef)).toEqual([]);
    // 非说明符位置（如动态拼接的路径）也要挡住：条件 3 的 grep 按字面量判定，这里在同口径上补一次匹配，
    // 只按行匹配且先剥注释——正文里正常提及宿主目录名（例如说明「宿主 apps/web 消费」）不该被当成违规。
    const literalOffenders = sourceFiles.flatMap((file) => {
      const code = stripComments(readFileSync(file, "utf8"));
      return code
        .split("\n")
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => line.includes(ESCAPE_LITERAL) && line.includes(HOST_WEB_LITERAL))
        .map(({ number }) => `${relative(PKG_ROOT, file)}:${number}`);
    });
    expect(literalOffenders).toEqual([]);
  });

  // 环境变量读取与校验统一在宿主（§1 静态条件 4）：包内直读 process.env 会把部署知识复制进资源模块。
  // 标题刻意不写该字面量——本文件也在扫描范围内，标题会被自己扫成违规。
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

  // exports 是本包对宿主的唯一解析入口（§1 静态条件 5）：键缺失会让 `@fenix/resource-task/web` 这类导入
  // 直接解析失败，而目标写错只在宿主构建/装配时才暴露，两组断言都在这里提前钉住。
  test("package.json 的 exports 键齐全、目标真实存在", () => {
    for (const key of [".", "./module", "./server", "./web", "./web/i18n"]) {
      expect(manifest.exports?.[key]).toBeString();
    }
    const missing = exportEntries.filter(([, target]) => !existsSync(resolve(PKG_ROOT, target)));
    expect(missing.map(([key, target]) => `${key} → ${target}`)).toEqual([]);
  });

  // `./module` 与 `./web` 是模块注册与浏览器装配的锚点：指错文件会让宿主取到错误的贡献形状。
  test("package.json 的 ./module 与 ./web 指向约定文件", () => {
    expect(manifest.exports?.["./module"]).toBe("./fenix.module.ts");
    expect(manifest.exports?.["./web"]).toBe("./web/index.ts");
  });

  // README 是包对外唯一说明（§1 静态条件 6）：五段式骨架缺段或退化成占位行，后续 W5 收口就无法据此核对。
  test("README 为五段式且非占位", () => {
    expect(readme.startsWith("# @fenix/resource-task")).toBe(true);
    const sections = readmeSections();
    const problems: string[] = [];
    for (const heading of REQUIRED_README_SECTIONS) {
      const body = sections.get(heading);
      if (body === undefined) problems.push(`${heading} 缺段`);
      else if (body.length < MIN_SECTION_LENGTH) problems.push(`${heading} 正文仅 ${body.length} 字`);
      else if (PLACEHOLDER_PATTERN.test(body)) problems.push(`${heading} 为占位文本`);
    }
    expect(problems).toEqual([]);
  });

  // 跨包只能走对方 `exports` 声明的公开出口（§1 静态条件 7）：深入 `@fenix/*/src` 会把别的包的内部实现
  // 拖进本包依赖面，而写错子路径（对方没声明）要到宿主构建才暴露。
  test("跨包引用均落在对方 package.json 声明的公开出口内", () => {
    const deepImports = refs.filter((ref) => /^@fenix\/[^/]+\/src(\/|$)/.test(ref.specifier));
    expect(deepImports.map(describeRef)).toEqual([]);

    const unresolved: string[] = [];
    for (const ref of refs.filter((item) => item.specifier.startsWith("@fenix/"))) {
      const { packageName, key } = exportKeyFor(ref.specifier);
      const manifestPath = workspaceManifests.get(packageName);
      if (!manifestPath) {
        unresolved.push(`${describeRef(ref)} → 工作区未找到包 ${packageName}`);
        continue;
      }
      const declared = Object.keys(
        (JSON.parse(readFileSync(manifestPath, "utf8")) as { exports?: Record<string, unknown> }).exports ?? {},
      );
      if (!declared.some((entry) => matchesExportKey(entry, key))) {
        unresolved.push(`${describeRef(ref)} → ${packageName} 未声明 ${key}`);
      }
    }
    expect(unresolved).toEqual([]);
  });

  // route 只做协议适配，不得互相复用业务逻辑（§1 静态条件 8 的「无 route 调 route」）：路由模块之间
  // 一旦互相引用，协议层就会长成第二个业务入口。`src/server/routes/dependencies.ts` 只声明工厂的注入
  // 类型，不属于路由模块，因此不在检查集合内。
  test("包内路由模块之间不互相导入", () => {
    const routeDirs = ["src/server/routes/api", "src/server/routes/web"].map((dir) => resolve(PKG_ROOT, dir));
    const routeFiles = new Set(routeDirs.flatMap((dir) => filesUnder(relative(PKG_ROOT, dir))));
    const offenders = refs.filter((ref) => {
      if (!routeFiles.has(ref.file) || !ref.specifier.startsWith(".")) return false;
      const target = resolve(dirname(ref.file), ref.specifier);
      return routeFiles.has(target) || routeFiles.has(`${target}.ts`) || routeFiles.has(`${target}.tsx`);
    });
    expect(offenders.map(describeRef)).toEqual([]);
  });
});
