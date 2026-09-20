// Channel 的**包边界契约测试**（任务 1.3 §1 静态条件）。
//
// 为什么断言引用面而不是文件内容：本包必须能在没有宿主解析环境（`apps/server` / `apps/web` 的
// tsconfig 与 vite 别名）的情况下独立构建。「某个文件存在」证明不了这件事，源码字符串包含更不行——
// 导出面仍在收敛，钉死文本会让测试在每次合法收敛后误报；反过来，引用面只要出现一条宿主导入，
// 包就已经失去独立构建能力。
//
// 扫描口径：先剥注释（注释里会举例写出宿主别名与 `@server` 路径，直接匹配会误报），再取
// import/export 说明符；`import type` 也算——类型导入同样把宿主路径写进包内。本测试只读文件、
// 不 import 被测模块，因此不会把被测代码的副作用（Elysia 实例、Hermes 单例）带进来。

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** 包根 `packages/resources/channel`（本文件位于 `src/__tests__/`）。 */
const PKG_ROOT = resolve(import.meta.dir, "../..");
/** 包内源码入口；README 等文档里的示例不属于可解析引用，不参与扫描。 */
const SOURCE_ENTRIES = ["src", "web", "fenix.module.ts"];

/**
 * 唯一允许的宿主导入。
 *
 * 表定义迁出归任务 1.7，本任务把它作为**显式残留**保留（见 README「边界残留」），且只允许这一条
 * 精确路径：`@server/db/schema` 之下的任何深路径都意味着重新伸手取宿主内部。
 */
const ALLOWED_HOST_IMPORT = "@server/db/schema";

/**
 * 允许从宿主 schema 读取的表符号白名单。
 *
 * 本包 owner 的表目前只有 `channel_binding`（`im_channel` / `im_channel_route` 已在宿主 schema
 * 声明但尚无实现，见 README）。白名单把「读到别的包的表」变成显式失败：跨表读取会让表 owner 与
 * 规则 owner 分离，正是 §1 静态条件 8 要拦的情况。
 */
const ALLOWED_HOST_TABLES = new Set(["channelBinding"]);

/** web 面的宿主别名（由 apps/web 的 tsconfig/vite 提供），包离开宿主后解析不了。 */
const HOST_ALIAS_PREFIX = "@/";

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
  code: string;
}

const sourceFiles = SOURCE_ENTRIES.flatMap((entry) => {
  const abs = resolve(PKG_ROOT, entry);
  if (!existsSync(abs)) return [];
  return statSync(abs).isDirectory() ? listPackageFiles(abs) : [abs];
});

const refs: ImportRef[] = sourceFiles.flatMap((file) => {
  const code = stripComments(readFileSync(file, "utf8"));
  return extractSpecifiers(code).map((specifier) => ({ file, specifier, code }));
});

const describeRef = (ref: ImportRef) => `${relative(PKG_ROOT, ref.file)} → ${ref.specifier}`;

/** 某个入口（目录或单文件）下的已扫描文件。 */
function filesUnder(entry: string): string[] {
  const abs = resolve(PKG_ROOT, entry);
  return sourceFiles.filter((file) => file === abs || file.startsWith(`${abs}/`));
}

/** web 贡献的已扫描文件；宿主别名只可能在 web 面出现，作用域断言按这个集合收敛。 */
const webFiles = new Set(filesUnder("web"));
/** `src/**` 下的测试文件：§1 静态条件 4 把测试排除在外（替身需要读写环境变量以覆盖分支）。 */
const isTestFile = (file: string) => file.includes("/__tests__/");

/** 相对说明符是否落在包外：`resolve` 折叠 `..` 段，宿主与兄弟资源包都会在这里现形。 */
function escapesPackage(file: string, specifier: string): boolean {
  return !resolve(dirname(file), specifier).startsWith(`${PKG_ROOT}/`);
}

const manifest = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
  exports?: Record<string, string>;
};
const exportEntries = Object.entries(manifest.exports ?? {});

/** 从 `@server/db/schema` 的命名导入里取符号名（去掉 `type` 前缀与 `as` 别名）。 */
function hostTableSymbols(code: string): string[] {
  const symbols: string[] = [];
  for (const match of code.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@server\/db\/schema["']/g)) {
    for (const raw of match[1].split(",")) {
      const name = raw
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name) symbols.push(name);
    }
  }
  return symbols;
}

describe("Channel 包边界契约（任务 1.3 §1 静态条件）", () => {
  // 遍历有效性自检：walker 若只返回入口文件，后续「不存在违规引用」的断言会全部退化为恒真。
  test("扫描有效性自检：源码集合覆盖全包，且已知残留宿主导入能被扫到", () => {
    for (const expected of [
      "fenix.module.ts",
      "src/index.ts",
      "src/module.ts",
      "src/server.ts",
      "src/server/db.ts",
      "src/server/routes/dependencies.ts",
      "src/server/routes/web/channels.ts",
      "src/server/repositories/channel-binding.ts",
      "src/__tests__/guard-stubs.ts",
      "web/index.ts",
      "web/i18n/index.ts",
      "web/api/channels.ts",
      "web/pages/agent-panel/pages/AgentChannelsPage.tsx",
    ]) {
      expect(sourceFiles).toContain(resolve(PKG_ROOT, expected));
    }
    expect(sourceFiles.length).toBeGreaterThanOrEqual(20);
    // 正向控制：表定义残留必然存在，扫不到就说明说明符提取失效（而不是「没有宿主导入」）。
    expect(refs.filter((ref) => ref.specifier === ALLOWED_HOST_IMPORT).length).toBeGreaterThan(0);
  });

  // 宿主实现只能经平台契约（`@fenix/platform-sdk`）或注入进入本包；除表定义残留外一律违规。
  test("包内不存在表定义以外的宿主 @server 导入", () => {
    const offenders = refs.filter(
      (ref) => ref.specifier.startsWith("@server/") && ref.specifier !== ALLOWED_HOST_IMPORT,
    );
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 表定义残留只允许读本包 owner 的表：读到别包的表会让表 owner 与规则 owner 分离。
  test("表定义残留只读本包 owner 的表", () => {
    const offenders = refs
      .filter((ref) => ref.specifier === ALLOWED_HOST_IMPORT)
      .flatMap((ref) =>
        hostTableSymbols(ref.code)
          .filter((symbol) => !ALLOWED_HOST_TABLES.has(symbol))
          .map((symbol) => `${relative(PKG_ROOT, ref.file)} → ${symbol}`),
      );
    expect(offenders).toEqual([]);
    // 反向控制：白名单若与真实导入完全脱节，上面的断言同样会恒真。
    expect(
      refs.filter((ref) => ref.specifier === ALLOWED_HOST_IMPORT).flatMap((ref) => hostTableSymbols(ref.code)).length,
    ).toBeGreaterThan(0);
  });

  // 宿主别名（`@/src`、`@/components`）由 apps/web 的 tsconfig/vite 提供，包离开宿主就解析不了。
  test("包内 web 不引用宿主别名 @/", () => {
    const offenders = refs.filter((ref) => ref.specifier.startsWith(HOST_ALIAS_PREFIX) && webFiles.has(ref.file));
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 相对路径是最隐蔽的越界方式：用多级 `..` 折返到宿主 `apps/web` 的写法在宿主内能跑通，包单独构建时目录不存在。
  // （本注释刻意不写出该字面量：§1 静态条件 3 是全仓 grep，说明文字同样会被计入命中。）
  test("包内不存在穿透到包外的相对路径引用", () => {
    const offenders = refs.filter((ref) => ref.specifier.startsWith(".") && escapesPackage(ref.file, ref.specifier));
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // 环境变量读取与校验统一在宿主（§1.5）：包内直读会把部署知识复制进资源模块，两处默认值会分歧。
  // 标题刻意不写该字面量——本文件也在扫描范围内，标题会被自己扫成违规。
  test("包内 src 生产代码不直读宿主环境变量", () => {
    const offenders = filesUnder("src")
      .filter((file) => !isTestFile(file))
      .flatMap((file) => {
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

  // `./module` / `./web` / `./server` 是模块注册、浏览器装配与服务端装配的锚点，指错文件会取到错误的形状。
  test("package.json 的面入口指向约定文件", () => {
    expect(manifest.exports?.["./module"]).toBe("./fenix.module.ts");
    expect(manifest.exports?.["./web"]).toBe("./web/index.ts");
    expect(manifest.exports?.["./server"]).toBe("./src/server.ts");
    expect(manifest.exports?.["./web/i18n"]).toBe("./web/i18n/index.ts");
  });

  // 跨包只能走对方根入口的公开导出；深入 `@fenix/*/src` 会把别的包的内部实现拖进本包依赖面。
  test("跨包引用不深入其他包的 src 内部路径", () => {
    const offenders = refs.filter((ref) => /^@fenix\/[^/]+\/src(\/|$)/.test(ref.specifier));
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // route 之间不得互相调用业务逻辑（§1 静态条件 8）：路由只在 app 根上组合，跨 route 复用会把
  // 「一个文件同时是协议入口与别人的依赖」写进装配图；共享逻辑必须下沉到 services。
  // 唯一允许的路由内部引用是 `routes/dependencies.*`（注入契约），它只声明依赖形状、不含处理逻辑。
  test("路由文件之间不互相导入处理逻辑", () => {
    const routeFiles = filesUnder("src/server/routes");
    const routesDir = resolve(PKG_ROOT, "src/server/routes");
    const offenders: string[] = [];
    for (const ref of refs) {
      if (!routeFiles.includes(ref.file) || !ref.specifier.startsWith(".")) continue;
      const target = resolve(dirname(ref.file), ref.specifier);
      if (!target.startsWith(`${routesDir}/`) || target === dirname(ref.file)) continue;
      if (!target.endsWith("/dependencies")) {
        offenders.push(`${relative(PKG_ROOT, ref.file)} → ${ref.specifier}`);
      }
    }
    expect(offenders).toEqual([]);
    // 正向控制：本包确实存在一条「路由 → dependencies」的合法引用，扫不到说明断言失效。
    expect(
      refs.filter((ref) => routeFiles.includes(ref.file) && ref.specifier === "../dependencies").length,
    ).toBeGreaterThan(0);
  });

  // README 是包 owner 的交接面：五段式缺段或仍是占位符，等于「唯一 owner」没有可核对的边界说明。
  test("README 为五段式且非占位", () => {
    const readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
    for (const section of ["## 定位与 owner", "## 服务端交付物", "## web 面与 i18n", "## 边界残留", "## 已知项"]) {
      expect(readme).toContain(section);
    }
    expect(readme.length).toBeGreaterThan(1500);
    expect(readme).not.toContain("TODO");
  });
});
