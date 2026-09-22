// packages/resources/prod-view/src/__tests__/prod-view-package-contract.test.ts
// ProdView 的**包边界契约测试**（任务 1.3 §1 的八条静态条件逐条对应）。
//
// 为什么不用「文件存在 + 源码字符串包含」：那种断言在合法收敛后会误报（导出面与目录都会收缩），而
// 在真正越界时又常常恒真。本包要能脱离宿主解析环境（`apps/server` / `apps/web` 的 tsconfig 与 vite
// 别名）独立构建，因此断言的是**引用面**与**声明面**：只要出现一条宿主导入、宿主别名或包外相对路径，
// 包就已经失去独立构建能力。
//
// 扫描口径：先剥注释再取 import/export 说明符（注释里会举例写出宿主别名与 `@fenix/...` 子路径，直接
// 匹配必然误报）；`import type` 也算——类型导入同样把宿主路径写进包内。本文件只读文件，不 import 被
// 测模块，因此不会把被测代码的副作用（懒加载宿主单例等）带进来。
//
// harness（stripComments / extractSpecifiers / listPackageFiles）与 `@fenix/resource-sandbox` 的同名
// 实现刻意各自保留一份：它依赖正则与目录遍历的细节，两个包对「边界」的断言集合也在分别演进；抽到公共
// 测试包会让任一侧的调整都牵动另一侧。

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** 包根 `packages/resources/prod-view`（本文件位于 `src/__tests__/`）。 */
const PKG_ROOT = resolve(import.meta.dir, "../..");
/** 仓库根：`node_modules/@fenix/*` 软链与宿主路径都以它为基准解析。 */
const REPO_ROOT = resolve(PKG_ROOT, "../../..");

/** 包内源码入口；README 等文档里的示例不属于可解析引用，不参与扫描。 */
const SOURCE_ENTRIES = ["src", "web", "db", "fenix.module.ts"];

/**
 * 本包自己 `db/` 出口的说明符。
 *
 * `prod_view` 的表定义自任务 1.7 B11 起由本包 `db/schema.ts` 持有，宿主导入的**白名单随残留迁出而
 * 删除**：条件 1 从此是零例外——任何 `@server/**` 说明符（含深路径与动态 `import()`）都是违规。
 * 这个常量剩下的用途是把「表对象的取用面」钉在本包出口上（条件 8 的其六 / 其一）。
 */
const PKG_DB_EXPORT = "@fenix/resource-prod-view/db";

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

/**
 * 经 `node_modules/@fenix/*` 软链读取目标包声明的 exports 键。
 *
 * 用软链而不是硬编码 `packages/**` 目录：包位置会随分层调整（`platform/*` 与 `resources/*` 深度不同），
 * 软链是 Bun workspace 安装后的真相。目标包若改用通配键（`"./web/*"`），本函数会返回 `undefined` 使断言
 * 失败——这是刻意的：通配键需要显式匹配逻辑，届时按真实用例扩展，而不是现在预置一段没有触发者的分支。
 */
function declaredExportKeys(packageName: string): string[] | undefined {
  const packageJsonPath = join(REPO_ROOT, "node_modules", packageName, "package.json");
  if (!existsSync(packageJsonPath)) return;
  const target = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { exports?: Record<string, unknown> };
  return Object.keys(target.exports ?? {});
}

/** 正则字面量化：说明符里的 `.` `-` `/` 等字符不得被当成模式语法。 */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 取出某文件里 `specifier` 具名导入的本地名字（`type X` 前缀与 `a as b` 均归一为本地名）。
 *
 * 只认具名导入：命名空间导入（`import * as schema`）会让「读了哪张表」不可静态判定，一旦出现应当被
 * 用例拦下——此时返回空列表，断言自然失败。
 */
function importNames(file: string, specifier: string): string[] {
  const code = stripComments(readFileSync(file, "utf8"));
  const names: string[] = [];
  const pattern = new RegExp(`import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${escapeRegExp(specifier)}["']`, "g");
  for (const match of code.matchAll(pattern)) {
    for (const raw of match[1].split(",")) {
      const name =
        raw
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)
          .pop()
          ?.trim() ?? "";
      if (name) names.push(name);
    }
  }
  return names;
}

const EIGHT_CONDITIONS = [
  "1 包内零宿主导入",
  "2 web 面零宿主别名",
  "3 无包外相对路径",
  "4 包内不直读宿主环境变量",
  "5 exports 锚点齐备且目标存在",
  "6 README 五段式非占位",
  "7 跨包只经对方公开子路径",
  "8 无 route 调 route / 无绕开 repository 的取表 / 无重复路由",
] as const;

describe("ProdView 包边界契约（任务 1.3 §1 静态条件）", () => {
  // 遍历有效性自检：walker 若只返回入口文件，后续「不存在违规引用」的断言会全部退化为恒真；
  // 同时用正向控制证明说明符提取真的在工作。
  test("扫描有效性自检：源码集合覆盖全包，且已知的取表出口能被扫到", () => {
    for (const expected of [
      "fenix.module.ts",
      "src/module.ts",
      "src/server.ts",
      "src/server/db.ts",
      "src/server/repositories/prod-view.ts",
      "src/server/routes/web/prod-views.ts",
      "src/server/routes/web/config/prod-views.ts",
      "src/__tests__/guard-stubs.ts",
      "web/index.ts",
      "web/i18n/index.ts",
      "web/pages/prod-view/ProdViewPage.tsx",
    ]) {
      expect(sourceFiles).toContain(resolve(PKG_ROOT, expected));
    }
    expect(sourceFiles.length).toBeGreaterThanOrEqual(25);
    // 正向控制：必须有一条已知存在的说明符能被扫到，否则下面「零宿主导入」的断言会退化成恒真。
    // 载体随残留迁出而更换：表定义残留（`@server/db/schema`）已随 §1.7 B11 迁入本包 `db/`，于是改钉本次
    // 收口的实际落点——仓储是唯一的数据访问点，它取表必须经本包出口，而不是回头直读宿主 schema。
    expect(refs).toContainEqual(
      expect.objectContaining({
        file: resolve(PKG_ROOT, "src/server/repositories/prod-view.ts"),
        specifier: PKG_DB_EXPORT,
      }),
    );
    expect(EIGHT_CONDITIONS).toHaveLength(8);
  });

  // 条件 1：§1.7 B11 收口前这里放行唯一残留 `@server/db/schema`（表定义）；表迁入本包 `db/` 后白名单随之
  // 删除——从此是**零例外**：任何 `@server` 说明符（含深路径与动态 `import()`）都是违规。宿主实现只能经
  // 平台契约（`@fenix/platform-sdk`）或宿主注入进入本包。
  test("包内不存在宿主 @server 导入", () => {
    const offenders = refs.filter((ref) => ref.specifier.startsWith("@server"));

    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 条件 2：宿主别名 `@/src`、`@/components` 由 apps/web 的 tsconfig/vite 提供，包离开宿主就解析不了。
  test("包内 web 不引用宿主别名 @/", () => {
    const offenders = refs.filter((ref) => ref.specifier.startsWith("@/") && webFiles.has(ref.file));
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 条件 3：相对路径是最隐蔽的越界方式，`../../../apps/web/...` 在宿主内能跑通，包单独构建时目录不存在。
  test("包内不存在穿透到包外的相对路径引用", () => {
    const offenders = refs.filter((ref) => ref.specifier.startsWith(".") && escapesPackage(ref.file, ref.specifier));
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 条件 4：环境变量读取与校验统一在宿主（§1.5），包内直读会把部署知识复制进资源模块且默认值会分歧。
  // 标题里不写该字面量，避免本文件被自己扫成违规（注释已剥离，但保持这条纪律更稳）。
  test("包内 src 不直读宿主环境变量", () => {
    const offenders = filesUnder("src").flatMap((file) => {
      if (file.startsWith(`${resolve(PKG_ROOT, "src/__tests__")}/`)) return [];
      const code = stripComments(readFileSync(file, "utf8"));
      return code
        .split("\n")
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => /\bprocess\.env\b/.test(line))
        .map(({ number }) => `${relative(PKG_ROOT, file)}:${number}`);
    });
    expect(offenders).toEqual([]);
  });

  // 条件 5：exports 是本包对宿主的唯一解析入口，目标写错只在宿主构建/装配时才暴露。
  test("package.json 的每条 exports 目标都真实存在", () => {
    expect(exportEntries.length).toBeGreaterThan(0);
    const missing = exportEntries.filter(([, target]) => !existsSync(resolve(PKG_ROOT, target)));
    expect(missing.map(([key, target]) => `${key} → ${target}`)).toEqual([]);
  });

  // 条件 5：`./module`、`./server`、`./web` 三个锚点分别服务模块注册、服务端装配与浏览器装配。
  test("package.json 的 ./module、./server、./web 指向约定文件", () => {
    expect(manifest.exports?.["./module"]).toBe("./fenix.module.ts");
    expect(manifest.exports?.["./server"]).toBe("./src/server.ts");
    expect(manifest.exports?.["./web"]).toBe("./web/index.ts");
  });

  // 条件 6：README 的五个小节是「本包的交付物自查表」，缺段或占位会让读者以为某项已具备。
  test("README 为五段式且各段非占位", () => {
    const readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
    const sections = readme.split(/^## /m).slice(1);
    expect(sections.map((section) => section.split("\n")[0].trim())).toEqual([
      "定位与 owner",
      "服务端交付物",
      "web 面与 i18n",
      "边界残留",
      "已知项",
    ]);
    for (const section of sections) {
      const body = section.split("\n").slice(1).join("\n").trim();
      expect(body.length).toBeGreaterThanOrEqual(80);
      expect(body).not.toMatch(/TODO|待补|<必填>/);
    }
  });

  // 条件 7：跨包只能走对方 package.json 声明的公开子路径；深入 `@fenix/*/src` 或写错子路径都会在宿主
  // 解析时才炸（软链存在、文件看起来也在），因此这里按目标包声明的 exports 逐条核对。
  test("跨包引用都命中对方 package.json 声明的 exports 子路径", () => {
    const crossRefs = refs.filter((ref) => ref.specifier.startsWith("@fenix/"));
    expect(crossRefs.length).toBeGreaterThan(0);

    const unresolved: string[] = [];
    const deepImports = crossRefs.filter((ref) => /^@fenix\/[^/]+\/src(\/|$)/.test(ref.specifier));
    for (const ref of crossRefs) {
      const [scope, name, ...rest] = ref.specifier.split("/");
      const packageName = `${scope}/${name}`;
      const keys = declaredExportKeys(packageName);
      if (!keys) {
        unresolved.push(`${describeRef(ref)}（目标包 package.json 未找到）`);
        continue;
      }
      const wanted = rest.length === 0 ? "." : `./${rest.join("/")}`;
      if (!keys.includes(wanted)) unresolved.push(`${describeRef(ref)}（${packageName} 未声明 ${wanted}）`);
    }
    expect(deepImports.map(describeRef)).toEqual([]);
    expect(unresolved).toEqual([]);
  });

  // 条件 8（其六，放在这里与其余数据访问断言相邻）：本包 `db/` 出口只允许取用 `prodView` 一族符号。
  // 表对象的取用面就是「谁能读这张表」；读到别的包的表的列，就是跨包直读表——表 owner 与规则 owner 分离，
  // 且本包的 repository 不再是该数据的唯一访问点（§6.4「无跨包直读表」）。
  test("本包 db 出口只被取用 prodView 一族符号", () => {
    const dbRefs = refs.filter((ref) => ref.specifier === PKG_DB_EXPORT);
    expect(dbRefs.length).toBeGreaterThan(0);
    const importedNames = dbRefs.flatMap((ref) => importNames(ref.file, PKG_DB_EXPORT));
    expect([...new Set(importedNames)].sort()).toEqual(["ProdViewRow", "prodView"]);
  });

  // 条件 8（其一）：路由只做协议接入，取表必须经 repository——路由直读 `db/schema.ts`（经本包出口或任何
  // 深路径）会把持久化形状泄漏进协议层，也让「repository 是唯一数据访问点」失效。
  test("路由层不直接引用表定义", () => {
    const offenders = refs.filter(
      (ref) =>
        (ref.specifier === PKG_DB_EXPORT || ref.specifier.startsWith(`${PKG_DB_EXPORT}/`)) &&
        ref.file.startsWith(`${resolve(PKG_ROOT, "src/server/routes")}/`),
    );
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 条件 8（其二）：一个 route 导入另一个 route 的业务逻辑会让协议层互相耦合、审计路径断裂。
  // `routes/dependencies.ts` 豁免：它只声明「工厂需要宿主注入什么」（一个 interface），不含任何处理器，
  // 共享它是刻意的——两个工厂的签名一致正靠它。
  test("路由文件之间没有互相导入", () => {
    const routeRoot = resolve(PKG_ROOT, "src/server/routes");
    const dependenciesStem = resolve(routeRoot, "dependencies");
    const offenders = refs.filter((ref) => {
      if (!ref.file.startsWith(`${routeRoot}/`) || !ref.specifier.startsWith(".")) return false;
      const target = resolve(dirname(ref.file), ref.specifier).replace(/\.tsx?$/, "");
      return target.startsWith(`${routeRoot}/`) && target !== dependenciesStem;
    });
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 条件 8（其三）：同一「方法 + 路径」不得在两个路由文件里各写一份，否则宿主装配时后注册的一方
  // 会静默覆盖或触发 Elysia 去重，表现为「改了代码没生效」。
  test("包内路由声明的方法与路径组合唯一", () => {
    const declared: string[] = [];
    for (const file of filesUnder("src/server/routes")) {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const match of code.matchAll(/\.(get|post|put|delete|patch)\(\s*\n?\s*"([^"]+)"/g)) {
        declared.push(`${match[1].toUpperCase()} ${match[2]}@${relative(PKG_ROOT, file)}`);
      }
    }
    expect(declared.length).toBeGreaterThanOrEqual(6);
    const paths = declared.map((entry) => entry.split("@")[0]);
    expect(paths.length).toBe(new Set(paths).size);
  });

  // 条件 8（其四）：组合根必须存在且被 manifest 惰性引用（生成器静态解析 `create` 字面量，写错路径在
  // 宿主注册时才暴露）。这里断言字面量形状——manifest 本身就是给生成器静态解析的描述符。
  test("fenix.module.ts 的 create 惰性指向 src/module.ts 的组合根", () => {
    const manifestSource = readFileSync(join(PKG_ROOT, "fenix.module.ts"), "utf8");
    expect(manifestSource).toContain('import("./src/module")');
    expect(manifestSource).toContain("createProdViewModule");
    expect(existsSync(resolve(PKG_ROOT, "src/module.ts"))).toBe(true);
  });
});
