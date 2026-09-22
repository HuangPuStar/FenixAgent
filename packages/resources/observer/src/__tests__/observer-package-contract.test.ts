// packages/resources/observer/src/__tests__/observer-package-contract.test.ts
// Observer 的**包边界契约测试**（任务 1.3 §1 的 8 条静态条件 + 宿主旧路径已删）。
//
// 为什么用引用面断言而不是「文件在不在」：包必须能在没有宿主解析环境（`apps/server` / `apps/web` 的
// tsconfig 与 vite 别名）的情况下独立构建，而「文件已迁到某路径」证明不了这件事。反过来，引用面只要
// 出现一条宿主导入或穿透包外的相对路径，包就已经失去独立构建能力——这是可判定的。
//
// 扫描口径：先剥注释（注释里会举例写出宿主路径与字面量，直接匹配会误报），再取 import/export
// 说明符；`import type` 同样计入（类型导入也把宿主路径写进包内，宿主环境一变就断）。
// 本文件只读文件、不 import 被测模块，因此不会把被测代码的副作用（懒加载宿主单例）带进来。
//
// 与 `web/__tests__/observer-browser-surface.test.ts` 的分工：那条守卫走**浏览器值导入图**
// （含跨包递归），本条守卫**包内引用面与交付物形状**（exports、README、宿主残留），不重复递归。

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** 包根 `packages/resources/observer`（本文件位于 `src/__tests__/`）。 */
const PKG_ROOT = resolve(import.meta.dir, "../..");
/** 仓库根；宿主旧路径以它为基准记录。 */
const REPO_ROOT = resolve(PKG_ROOT, "../../..");
/** 参与扫描的源码入口；README 等文档里的示例不是可解析引用，不参与扫描。 */
const SOURCE_ENTRIES = ["src", "web", "db", "fenix.module.ts"];

/**
 * 本包必然存在的跨包公开出口导入；用作「说明符提取仍然有效」的正向控制。
 *
 * 迁移期这里曾是宿主导入白名单 `@server/db/schema`（任务 1.3 计划 §5 的显式残留）：1.7 B7 把
 * `agent_config` 表定义迁到 `@fenix/agent-config/db`、人员树改经 owner 的公开取数面取数后，本包
 * 已无任何宿主导入，白名单随之取消——留一个空的允许集会让这条断言退化成空洞的恒真式。
 */
const REQUIRED_CROSS_PACKAGE_IMPORT = "@fenix/platform-sdk/server";

/**
 * 资源间引用的允许出口（§1 静态条件 7：只经对方包根入口）。
 *
 * 空串表示裸包名 `@fenix/resource-x`；`/server` 与 `/web` 是计划 §2.2 定义的公开子路径。
 * `@fenix/ui-components` / `@fenix/web-runtime` 不是 `resource-*`，不受本条约束（它们本身就是
 * 浏览器公共能力的 owner，子路径即公开面）。
 */
const ALLOWED_RESOURCE_SUBPATHS = new Set(["", "/server", "/web"]);

/**
 * 宿主侧旧路径（迁入本包后应已删除）。
 *
 * 记成清单而不是逐条散落断言：同一职责在宿主与本包各留一份时，两份实现会各自漂移，
 * 而「旧路径还在」是最容易被忽略的一种（宿主测试与构建仍能通过）。
 *
 * `apps/server/src/test-utils/observer-fixtures.ts` 曾是最后一份未收口的宿主副本（本包测试早已改用
 * `src/__tests__/observer-fixtures.ts`）：它已随 W3 的宿主死副本清理删除，路径随之纳入下方清单——
 * 此前只记在 README「边界残留」里，清单才是这条不变量真正的守卫。
 */
const HOST_PATHS_REMOVED: readonly string[] = [
  "apps/server/src/routes/api/system-logs.ts",
  "apps/server/src/routes/api/system-observer.ts",
  "apps/server/src/routes/api/system-people-tree.ts",
  "apps/server/src/services/observer-service.ts",
  "apps/server/src/services/system-log-service.ts",
  "apps/server/src/services/system-people-tree-service.ts",
  "apps/server/src/schemas/api-system-logs.schema.ts",
  "apps/server/src/schemas/api-system-observer.schema.ts",
  "apps/server/src/schemas/api-system-people-tree.schema.ts",
  "apps/server/src/test-utils/observer-fixtures.ts",
  "apps/web/src/api/observer.ts",
  "apps/web/src/api/system-logs.ts",
  "apps/web/src/api/system-people-tree.ts",
  "apps/web/src/pages/admin/AdminLogsPage.tsx",
  "apps/web/src/pages/admin/AdminObserverPage.tsx",
  "apps/web/src/pages/admin/AdminPeoplePage.tsx",
  "apps/web/src/pages/admin/components/ObserverFlatTable.tsx",
  "apps/web/src/pages/admin/components/ObserverIntegrityAlert.tsx",
  "apps/web/src/pages/admin/components/ObserverMachineTree.tsx",
  "apps/web/src/pages/admin/components/ObserverOrgTree.tsx",
];

/**
 * 本包允许出现 DB 句柄与表对象的文件：**空集**。
 *
 * 迁移期这里是 `src/server/db.ts`（句柄）与 `src/server/repositories/**`（表对象）：人员树是本包唯一的
 * 数据访问点。1.7 B7 把 `agent_config` 的读取收敛回 owner（agent-config）后，本包的句柄模块与仓储层
 * 已无消费方并随之删除，本包**零**数据访问——因此任何 `getDatabase` / `@server/db` 的重新出现都意味着
 * 第二套取数路径，必须拦下（而不是「落在允许目录里就放行」）。
 *
 * 断言只在生产代码上生效（`__tests__` 不参与）：测试要注入替身（`stubDb()`）、要断言取数被调用，
 * 允许出现这些符号；本文件自身也在 `__tests__` 内，因此不需要转义技巧。
 */
const DATA_ACCESS_DIRS: readonly string[] = [];

/** 去掉行注释与块注释；字符串字面量原样保留（说明符就在引号里）。 */
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
 * 说明符抓取：`from` 形式（含多行命名导入）、副作用导入、动态 `import()`。
 * `from` 形式锚在行首并止步于 `;`，避免把函数体或正则字面量里的 `from "…"` 文本当成语句。
 */
const SPECIFIER_PATTERNS = [
  /^[ \t]*(?:import|export)\b[^;]*?\bfrom[ \t]*["']([^"']+)["']/gm,
  /^[ \t]*import[ \t]*["']([^"']+)["']/gm,
  /\bimport[ \t]*\([ \t]*["']([^"']+)["']/g,
];

/** 说明符首字符形态：正则字面量里的 `from "…"` 会被上面的模式捞出，不属于模块说明符的一律丢弃。 */
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

const describeRef = (ref: ImportRef): string => `${relative(PKG_ROOT, ref.file)} → ${ref.specifier}`;

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

describe("Observer 包边界契约（任务 1.3 §1 静态条件）", () => {
  // 遍历有效性自检：walker 若只返回入口文件，「不存在违规引用」的断言会全部退化为恒真。
  test("扫描有效性自检：源码集合覆盖全包，且已知跨包导入能被扫到", () => {
    for (const expected of [
      "fenix.module.ts",
      "src/server.ts",
      "src/module.ts",
      "src/server/routes/api/system-logs.ts",
      "src/server/routes/api/system-observer.ts",
      "src/server/routes/api/system-people-tree.ts",
      "src/__tests__/guard-stubs.ts",
      "web/index.ts",
      "web/i18n/locales/en/observer.json",
      "web/api/system-people-tree.ts",
      "web/pages/admin/AdminLogsPage.tsx",
    ]) {
      const abs = resolve(PKG_ROOT, expected);
      expect(existsSync(abs), `缺少 ${expected}`).toBe(true);
      if (/\.tsx?$/.test(expected)) expect(sourceFiles).toContain(abs);
    }
    expect(sourceFiles.length).toBeGreaterThanOrEqual(30);
    // 正向控制：本包必然有跨包公开出口导入（平台契约），扫不到就说明说明符提取失效（而不是「没有宿主导入」）。
    expect(refs.filter((ref) => ref.specifier === REQUIRED_CROSS_PACKAGE_IMPORT).length).toBeGreaterThan(0);
  });

  // §1 条件 1：宿主实现只能经平台契约（`@fenix/platform-sdk`）或注入进入本包。B7 迁出表定义后，
  // 「表定义残留」这条唯一例外已消失，因此这里是不带白名单的全量禁则。
  test("包内不存在宿主 @server 导入", () => {
    const offenders = refs.filter((ref) => ref.specifier.startsWith("@server/"));
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // §1 条件 2：宿主别名（`@/src`、`@/components`）由 apps/web 的 tsconfig/vite 提供，包离开宿主就解析不了。
  test("包内 web 不引用宿主别名 @/", () => {
    const offenders = refs.filter((ref) => ref.specifier.startsWith("@/") && webFiles.has(ref.file));
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // §1 条件 3：相对路径是最隐蔽的越界方式——三段 `..` 后接宿主 `apps/web` 的写法在宿主内能跑通，
  // 包单独构建时那个目录不存在。（注释里写出完整字面量会被同类的 grep 式门禁当成违规，故不抄原样。）
  test("包内不存在穿透到包外的相对路径引用", () => {
    const offenders = refs.filter((ref) => ref.specifier.startsWith(".") && escapesPackage(ref.file, ref.specifier));
    expect(offenders.map(describeRef)).toEqual([]);
  });

  // §1 条件 4：环境变量的声明与校验统一在宿主 `apps/server/src/env.ts`，包内直读会把部署知识
  // 复制进资源模块（两处默认值一旦分歧便无法在启动期暴露）。标题与断言里刻意不写出该标识符的
  // 可匹配形态：本文件也在扫描范围内，写实了会把自己扫成违规。
  test("包内 src 不直读宿主环境变量", () => {
    const offenders = filesUnder("src").flatMap((file) => {
      const code = stripComments(readFileSync(file, "utf8"));
      return code
        .split("\n")
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => /\bprocess\.[e]nv\b/.test(line))
        .map(({ number }) => `${relative(PKG_ROOT, file)}:${number}`);
    });
    expect(offenders).toEqual([]);
  });

  // §1 条件 5：exports 是本包对宿主的唯一解析入口，目标写错只在宿主构建/装配时才暴露。
  // 逐键断言存在 + 目标路径（只断言「目标存在」会漏掉键被删掉这一半，W1 变异测试实测）：
  //   `.` 包根（服务端与装配层）、`./module` 生成器静态解析的 manifest、`./server` 宿主装配、
  //   `./web` 浏览器入口、`./web/i18n` 宿主 i18n 启动期注册（子路径，见 web/i18n/index.ts）。
  test("package.json 的 exports 键齐备且指向约定文件", () => {
    const expected: ReadonlyArray<readonly [string, string]> = [
      [".", "./src/index.ts"],
      ["./module", "./fenix.module.ts"],
      ["./server", "./src/server.ts"],
      ["./web", "./web/index.ts"],
      ["./web/i18n", "./web/i18n/index.ts"],
    ];
    for (const [key, target] of expected) {
      expect(manifest.exports?.[key], `exports 缺少 ${key}`).toBe(target);
    }
    expect(exportEntries.length).toBe(expected.length);
    // 包根被服务端与装配层导入，指向 `web/**` 会把整张浏览器图（React、Radix、页面）拖进装配路径。
    expect(manifest.exports?.["."]?.startsWith("./web/")).toBe(false);
    const missing = exportEntries.filter(([, target]) => !existsSync(resolve(PKG_ROOT, target)));
    expect(missing.map(([key, target]) => `${key} → ${target}`)).toEqual([]);
  });

  // §1 条件 6：README 是交付物，但「文件存在」不等于「五段式非占位」——W1 变异测试实测：
  // 换成单行占位后契约测试仍全绿。这里把结构与体量钉住，缺段或退化成占位会在包内直接失败。
  test("README 为五段式且非占位", () => {
    const readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
    expect(readme.startsWith("# @fenix/resource-observer")).toBe(true);
    const headings = readme.split("\n").filter((line) => line.startsWith("## "));
    expect(headings).toEqual(["## 定位与 owner", "## 服务端交付物", "## web 面与 i18n", "## 边界残留", "## 已知项"]);
    const bodyLines = readme.split("\n").filter((line) => line.trim().length > 0);
    expect(bodyLines.length).toBeGreaterThanOrEqual(40);
    expect(readme).not.toMatch(/TODO|待补|占位/);
  });

  // §1 条件 7：资源间引用只经对方包根入口，深入 `@fenix/*/src` 会把别的包的内部实现拖进依赖面。
  test("跨包引用经对方公开出口，不深入 src 内部路径", () => {
    const deepSrc = refs.filter((ref) => /^@fenix\/[^/]+\/src(\/|$)/.test(ref.specifier));
    expect(deepSrc.map(describeRef)).toEqual([]);

    const offenders = refs.flatMap((ref) => {
      const match = /^(@fenix\/resource-[^/]+)(\/.*)?$/.exec(ref.specifier);
      if (!match) return [];
      const subpath = match[2] ?? "";
      return ALLOWED_RESOURCE_SUBPATHS.has(subpath) ? [] : [describeRef(ref)];
    });
    expect(offenders).toEqual([]);
  });

  // §1 条件 8（本包可判定的一半）：路由不互相导入（route 调 route 会让协议装配变成隐式依赖），
  // 且包内不出现任何 DB 句柄或表对象（B7 后本包零数据访问，见 `DATA_ACCESS_DIRS` 的说明）。
  test("路由不互相导入，包内不出现 DB 访问", () => {
    const routeFiles = filesUnder("src/server/routes");
    const crossRoute = refs.filter(
      (ref) =>
        routeFiles.includes(ref.file) &&
        /(^\.{1,2}\/)|routes\//.test(ref.specifier) &&
        ref.specifier.includes("routes/"),
    );
    expect(crossRoute.map(describeRef)).toEqual([]);

    const allowed = DATA_ACCESS_DIRS.map((entry) => resolve(PKG_ROOT, entry));
    const isAllowed = (file: string) => allowed.some((entry) => file === entry || file.startsWith(`${entry}/`));
    const dataAccess = filesUnder("src").flatMap((file) => {
      if (isAllowed(file) || file.includes("/__tests__/")) return [];
      const code = stripComments(readFileSync(file, "utf8"));
      return /\bgetObserverDatabase\b|\bgetDatabase\b|\b@server\/db\b/.test(code) ? [relative(PKG_ROOT, file)] : [];
    });
    expect(dataAccess).toEqual([]);
  });

  // §1 条件 8（无重复实现）：同一职责在宿主与本包各留一份会各自漂移，而宿主旧路径残留最难被发现
  // （宿主测试与构建仍能通过）。宿主侧的删除属共享文件改动，清单里只登记已确认删除的路径。
  test("宿主旧路径已删除（能力不在两处各留一份）", () => {
    const survivors = HOST_PATHS_REMOVED.filter((hostPath) => existsSync(resolve(REPO_ROOT, hostPath)));
    expect(survivors).toEqual([]);
  });

  // i18n 字典落在 `web/i18n/locales/{en,zh}/`（与 sandbox 等包同形），宿主经 `./web/i18n` 子路径注册。
  // 旧布局 `web/i18n/{en,zh}/` 必须删除：宿主 `apps/web/src/i18n/index.ts` 的深层相对导入就是指向它的，
  // 留着旧文件会让「字典搬了、宿主仍读旧位置」的中间态继续可用，两边各持一份后静默漂移。
  test("i18n 字典在 locales 布局上且旧路径已删除", () => {
    for (const locale of ["en", "zh"]) {
      const file = join(PKG_ROOT, "web", "i18n", "locales", locale, "observer.json");
      expect(existsSync(file), `缺少 ${locale} 字典`).toBe(true);
      const dict = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      expect(Object.keys(dict).length).toBeGreaterThan(0);
      expect(existsSync(join(PKG_ROOT, "web", "i18n", locale, "observer.json"))).toBe(false);
    }
  });
});
