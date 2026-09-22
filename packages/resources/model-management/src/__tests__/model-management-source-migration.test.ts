// packages/resources/model-management/src/__tests__/model-management-source-migration.test.ts
// Model Management 的**宿主边界契约测试**（任务 1.3 §1 静态条件 1 / 3 / 4）。
//
// 为什么补这一份（§1.7 收尾，review/task-1.7-db-config-migration.md §8.1 第 11 条）：machine / mcp /
// sandbox / agent-config / workflow / task 六个包各有同形的「source-migration」契约测试，本包没有——
// 于是「本包与宿主的边界」在测试层无人守护，只靠架构台账与 `check:dependencies`（两者都是编排者侧的
// 门禁，改包的人跑 `bun test` 时看不到）。本包 `src/**` 的最后一个 `@server/**` 引用已随 §1.7 B7
// 交还 owner（`subject-agent-search` 退化为薄适配层），因此断言是**零容忍**而不是「只允许某一条路径」。
//
// 与同形测试的差异：不含 `MIGRATION_PAIRS`（宿主旧路径 → 包内新路径的成对清单）。那份清单服务于
// 「第二份实现复活」的守护，本包的迁移面已在 README「边界残留」逐条记录并有宿主侧门禁；本文件只承担
// 没人管的那一段——引用面。
//
// 扫描口径：先剥注释（注释里会举例写出旧写法 `@server/db`、宿主别名，直接匹配会误报），再取
// import/export 说明符；`import type` 也算——类型导入同样把宿主路径写进包内。本测试只读文件、不
// import 被测模块，因此不会把被测代码的副作用（Elysia 实例、模块级槽位）带进来。

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** 包根 `packages/resources/model-management`（本文件位于 `src/__tests__/`）。 */
const PKG_ROOT = resolve(import.meta.dir, "../..");
/** 包内源码入口；README 等文档里的示例不属于可解析引用，不参与扫描。 */
const SOURCE_ENTRIES = ["src", "web", "db", "fenix.module.ts"];

/**
 * 本包 `./db` 出口（§1.7 B3 起三张表与三个 pgEnum 的定义归本包）。
 *
 * 它同时是**正向控制**：说明符提取一旦失效（而不是「真的没有宿主导入」），零容忍断言会静默通过，
 * 而这条包内引用必然存在，会让提取失效先变红。
 */
const PKG_DB_EXPORT = "@fenix/model-management/db";
/** 已迁出的表定义出口形态；本包只允许引用自己的那一个（`db/**` 的组装期导入见下条用例）。 */
const CROSS_PACKAGE_DB_EXPORT = /^@fenix\/[^/]+\/db$/;
/** web 面的宿主别名（由 apps/web 的 tsconfig/vite 提供），包离开宿主后解析不了。 */
const HOST_ALIAS_PREFIX = "@/";

/** README 的五个小节：本包交付物的一部分，缺节或占位会让读者以为能力不存在。 */
const README_SECTIONS = ["## 定位与 owner", "## 服务端交付物", "## web 面与 i18n", "## 边界残留", "## 已知项"];

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

describe("Model Management 宿主边界契约（任务 1.3 §1 静态条件）", () => {
  // 遍历有效性自检：walker 若只返回入口文件，后续「不存在违规引用」的断言会全部退化为恒真。
  test("扫描有效性自检：源码集合覆盖全包，且必然存在的说明符能被扫到", () => {
    for (const expected of [
      "fenix.module.ts",
      "src/module.ts",
      "src/server.ts",
      "src/server/db.ts",
      "src/server/repositories/model-resource.ts",
      "src/__tests__/guard-stubs.ts",
      "db/schema.ts",
      "web/index.ts",
      "web/i18n/index.ts",
      "web/api/models.ts",
    ]) {
      expect(sourceFiles).toContain(resolve(PKG_ROOT, expected));
    }
    expect(sourceFiles.length).toBeGreaterThanOrEqual(60);
    // 正向控制：本包对宿主的引用已归零，故改用两条必然存在的说明符钉住扫描器——跨包依赖
    // （`@fenix/platform-sdk`）、包内相对导入，以及本包 `db` 出口的自我引用（三条都不依赖宿主）。
    expect(refs.some((ref) => ref.specifier === "@fenix/platform-sdk")).toBe(true);
    expect(refs.some((ref) => ref.specifier.startsWith("."))).toBe(true);
    expect(refs.some((ref) => ref.specifier === PKG_DB_EXPORT)).toBe(true);
  });

  // 宿主实现只能经平台契约（`@fenix/platform-sdk`）或注入进入本包（§1 静态条件 1）。B7 把
  // `agent_config` 的只读投影交还 owner 后，本包 `src/**` / `web/**` / `db/**` 再无任何宿主导入，
  // 因此这条从「只允许一条精确路径」收紧为零容忍。
  test("包内不存在宿主 @server 导入", () => {
    const offenders = refs.filter((ref) => ref.specifier.startsWith("@server/"));
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 宿主别名（`@/src`、`@/components`）由 apps/web 的 tsconfig/vite 提供，包离开宿主就解析不了。
  test("包内 web 不引用宿主别名 @/", () => {
    const offenders = refs.filter((ref) => ref.specifier.startsWith(HOST_ALIAS_PREFIX) && webFiles.has(ref.file));
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 相对路径是最隐蔽的越界方式：多级 `..` 折返到宿主的写法在宿主内能跑通，包单独构建时目录不存在。
  test("包内不存在穿透到包外的相对路径引用", () => {
    const offenders = refs.filter((ref) => ref.specifier.startsWith(".") && escapesPackage(ref.file, ref.specifier));
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 跨包直读表是授权与 schema 双份真相的来源：本包只允许引用自己的 `db` 出口。`db/**` 自身的跨包导入
  // （外键列对象，§6.1 组装期例外）按路径排除，并由下一条用例单独钉住。
  test("包内调用期只引用本包自己的 db 出口", () => {
    const dbFiles = new Set(filesUnder("db"));
    const offenders = refs.filter(
      (ref) => CROSS_PACKAGE_DB_EXPORT.test(ref.specifier) && ref.specifier !== PKG_DB_EXPORT && !dbFiles.has(ref.file),
    );
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 上一条把 `db/**` 排除在外，因此这里钉住该豁免的对象：本包 schema 的跨包导入只允许身份包的
  // `user`（`provider.user_id` 外键的列对象来源）。
  test("db/schema.ts 的跨包导入只用于外键列对象", () => {
    const dbRefs = refs.filter((ref) => filesUnder("db").includes(ref.file));
    expect(
      dbRefs
        .filter((ref) => CROSS_PACKAGE_DB_EXPORT.test(ref.specifier))
        .map((ref) => ref.specifier)
        .sort(),
    ).toEqual(["@fenix/identity/db"]);
    const code = stripComments(readFileSync(resolve(PKG_ROOT, "db/schema.ts"), "utf8"));
    expect(code).toMatch(/references\(\(\) => user\./);
  });

  // exports 是本包对宿主与其他包的唯一解析入口，目标写错只在宿主构建/装配时才暴露，这里提前钉住。
  test("package.json 的每条 exports 目标都真实存在", () => {
    expect(exportEntries.length).toBeGreaterThan(0);
    const missing = exportEntries.filter(([, target]) => !existsSync(resolve(PKG_ROOT, target)));
    expect(missing.map(([key, target]) => `${key} → ${target}`)).toEqual([]);
  });

  // 面入口指错文件会静默取到错误的形状：`./db` 是表定义、`./web/i18n` 少注册一个 namespace 只表现为
  // 文案回显 key。`./web/contribution` 是 1.5e 起的 web 贡献锚点，由清单字段直接引用。
  test("package.json 的面入口指向约定文件", () => {
    expect(manifest.exports?.["./module"]).toBe("./fenix.module.ts");
    expect(manifest.exports?.["./server"]).toBe("./src/server.ts");
    expect(manifest.exports?.["./db"]).toBe("./db/schema.ts");
    expect(manifest.exports?.["./web"]).toBe("./web/index.ts");
    expect(manifest.exports?.["./web/i18n"]).toBe("./web/i18n/index.ts");
    expect(manifest.exports?.["./web/contribution"]).toBe("./web/contribution.ts");
  });

  // 模块 id 是 registry 的索引键；create 必须保持惰性——registry 会被大量位置导入，不能在索引层就把
  // Elysia / drizzle 拖进模块图。
  test("fenix.module.ts 声明 id 且 create 惰性指向包内组合根", () => {
    expect(manifestSource).toContain('id: "model-management"');
    expect(manifestSource).toContain(
      'create: (context) => import("./src/module").then((module) => module.createModelManagementModule(context))',
    );
  });

  // README 是包 owner 的交接面：五段式缺段或仍是占位符，等于「唯一 owner」没有可核对的边界说明。
  test("README 为五段式且非占位", () => {
    const readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
    const missing = README_SECTIONS.filter((section) => !readme.includes(section));
    expect(missing).toEqual([]);
    expect(readme.length).toBeGreaterThanOrEqual(1500);
    for (const placeholder of ["TODO", "待补", "占位", "Lorem", "<待"]) {
      expect(readme).not.toContain(placeholder);
    }
  });
});
