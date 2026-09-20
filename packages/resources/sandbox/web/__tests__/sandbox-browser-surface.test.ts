// web/__tests__/sandbox-browser-surface.test.ts
// 守护 `@fenix/resource-sandbox/web` 的浏览器可达面（2026-08-17 事故同类风险）。
//
// 与 chat-channel 的守卫同构：静态走 `web/index.ts` 的**值导入图**，而不是对源码做字符串匹配。
// 差别在于本包是资源包模板，图里多了三类必须被拦住的说明符：
//   - `node:*`：浏览器里是 Vite 外置桩，import 期即崩；
//   - `@server/*`：宿主服务端实现，浏览器构建根本不该看见；
//   - 宿主别名 `@/...`：包一旦依赖它就无法独立构建（§1.3 硬条件：包内 web 零宿主别名）。
// 包外依赖走白名单：新增条目必须先在 `packages/ui-components` / `packages/web-runtime` 的导出面中确认可用。
// 另注：本测试只读文件，不 import 被测模块——顶层副作用（如懒加载宿主单例）也不该影响断言。

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const WEB_ROOT = resolve(import.meta.dir, "..");
const WEB_ENTRY = join(WEB_ROOT, "index.ts");
const PKG_ROOT = resolve(WEB_ROOT, "..");

/** 包外运行时依赖白名单：均为浏览器安全的前端库（宿主 apps/web 亦直接依赖） */
const EXTERNAL_ALLOWLIST = new Set([
  "@fenix/ui-components",
  "@fenix/web-runtime",
  "ahooks",
  "i18next",
  "lucide-react",
  "react",
  "react-i18next",
  "sonner",
]);

/** 去掉 // 与块注释（注释里会出现宿主别名写法，必须先剥离再匹配，否则字符串匹配会误报） */
function stripComments(source: string): string {
  let out = "";
  let index = 0;
  let quote: '"' | "'" | "`" | null = null;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      out += char === "\\" ? "\\" : "";
      if (char === "\\") {
        out += next ?? "";
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      out += char;
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

interface Clause {
  /** import/export 子句（default / namespace / named 列表原文），无则视为副作用导入 */
  clause: string | null;
  /** import type / export type 声明，编译期擦除 */
  typeOnly: boolean;
  specifier: string;
}

/** 提取一条语句的模块说明符（import/export ... from "spec"、副作用 import "spec"、动态 import()） */
function extractStatements(code: string): Clause[] {
  const clauses: Clause[] = [];
  const fromRe = /\b(import|export)\s+(type\s+)?([\s\S]*?)?\s*from\s*["']([^"']+)["']/g;
  for (const match of code.matchAll(fromRe)) {
    clauses.push({ clause: match[3] ?? null, typeOnly: Boolean(match[2]), specifier: match[4] });
  }
  const sideEffectRe = /(?:^|[\s;])import\s*["']([^"']+)["']/gm;
  for (const match of code.matchAll(sideEffectRe)) {
    clauses.push({ clause: null, typeOnly: false, specifier: match[1] });
  }
  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of code.matchAll(dynamicRe)) {
    clauses.push({ clause: null, typeOnly: false, specifier: match[1] });
  }
  return clauses;
}

/** 子句是否含值绑定：default / namespace / named 列表中剔除 `type X` 后仍有剩余 */
function hasValueBinding(clause: string | null): boolean {
  if (!clause) return true; // 副作用导入或动态 import：一律按值处理
  const braceMatch = clause.match(/\{([^}]*)\}/);
  if (braceMatch) {
    const values = braceMatch[1]
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && !/^type\s/.test(entry));
    if (values.length > 0) return true;
  }
  const braceless = clause
    .replace(/\{[^}]*\}/g, "")
    .replace(/,/g, " ")
    .trim();
  return braceless.length > 0;
}

/**
 * 相对说明符解析到真实文件。
 *
 * 与 chat-channel 版本的差异：本包页面是 .tsx，i18n 资源是 .json。
 * `.json` 视为图的叶子（JSON 不可能再导入 node 内建），不进入队列也不计入 externals。
 */
function resolveModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

interface WalkResult {
  files: string[];
  externals: Array<{ file: string; specifier: string }>;
}

function walkValueGraph(entry: string): WalkResult {
  const visited = new Set<string>([entry]);
  const queue = [entry];
  const externals: Array<{ file: string; specifier: string }> = [];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const code = stripComments(readFileSync(file, "utf8"));
    for (const statement of extractStatements(code)) {
      if (statement.typeOnly || !hasValueBinding(statement.clause)) continue;
      if (statement.specifier.endsWith(".json")) continue; // 叶子资源，无可执行代码
      const resolved = resolveModule(file, statement.specifier);
      if (resolved) {
        if (!visited.has(resolved)) {
          visited.add(resolved);
          queue.push(resolved);
        }
      } else {
        externals.push({ file, specifier: statement.specifier });
      }
    }
  }
  return { files: [...visited], externals };
}

const graph = walkValueGraph(WEB_ENTRY);
const relFiles = graph.files.map((file) => relative(WEB_ROOT, file));
const describeExternal = (entry: { file: string; specifier: string }) =>
  `${relative(WEB_ROOT, entry.file)} → ${entry.specifier}`;

describe("sandbox web 入口浏览器可达面", () => {
  // 遍历有效性自检：图若解析失败会退化为「只有入口文件」，后续断言全部假绿。
  test("遍历有效性自检：页面、api、i18n 模块都在到达集合中", () => {
    for (const expected of [
      "index.ts",
      "i18n/index.ts",
      "i18n/namespace.ts",
      "src/api/system-sandbox.ts",
      "src/api/system-organizations.ts",
      "src/lib/admin-key.ts",
      "src/pages/admin/AdminSandboxPage.tsx",
      "src/pages/admin/use-sandbox-dashboard.ts",
      "src/pages/admin/components/SandboxDashboard.tsx",
      "src/pages/admin/components/PoolTree.tsx",
      "src/pages/admin/components/ClusterPanel.tsx",
      "src/pages/admin/components/RemoteSandboxPanel.tsx",
    ]) {
      expect(relFiles).toContain(expected);
    }
    expect(relFiles.length).toBeGreaterThanOrEqual(20);
  });

  // node 内建一旦进入值导入图，浏览器构建只会得到外置桩并在加载期崩溃（chat-channel 事故）。
  test("值导入图不触及 node 内建", () => {
    const offenders = graph.externals.filter((entry) => entry.specifier.startsWith("node:"));
    expect(offenders.map(describeExternal)).toEqual([]);
  });

  // @server/* 是宿主服务端实现，包内 web 只能经 API + ./server 出口协作。
  test("值导入图不触及 @server 宿主服务端路径", () => {
    const offenders = graph.externals.filter((entry) => entry.specifier.startsWith("@server/"));
    expect(offenders.map(describeExternal)).toEqual([]);
  });

  // 宿主别名会让包离开 apps/web 的 tsconfig/vite 配置后无法解析，属于 1.3 的硬性禁止项。
  test("值导入图不残留宿主别名（@/src、@/components）", () => {
    const offenders = graph.externals.filter((entry) => /^@\/(src|components)(\/|$)/.test(entry.specifier));
    expect(offenders.map(describeExternal)).toEqual([]);
  });

  // 跨包必须走 exports 出口：@fenix/*/src 之类的深路径会把别的包的内部实现拖进浏览器图。
  test("跨包引用不深入 @fenix/*/src 内部路径", () => {
    const offenders = graph.externals.filter((entry) => /^@fenix\/[^/]+\/src(\/|$)/.test(entry.specifier));
    expect(offenders.map(describeExternal)).toEqual([]);
  });

  // 未列入白名单的裸包说明符可能是「忘记声明依赖」或「引入了非浏览器库」，必须显式评审。
  test("包外运行时依赖在白名单内", () => {
    const offenders = graph.externals.filter((entry) => {
      const root = entry.specifier.startsWith("@")
        ? entry.specifier.split("/").slice(0, 2).join("/")
        : entry.specifier.split("/")[0];
      return !EXTERNAL_ALLOWLIST.has(root);
    });
    expect(offenders.map(describeExternal)).toEqual([]);
  });

  // 浏览器入口的实现文件里不得 import '@fenix/resource-sandbox/server' 之类子路径（自我回环）。
  test("web 子图不导入本包的 server / module 出口", () => {
    const offenders = graph.externals.filter((entry) => entry.specifier.startsWith("@fenix/resource-sandbox/"));
    expect(offenders.map(describeExternal)).toEqual([]);
  });

  // ./web 出口的契约：package.json 必须指向 web/index.ts，否则宿主解析到别的文件时守卫失去意义。
  test("package.json 的 ./web 出口指向 web/index.ts", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      exports?: Record<string, string>;
    };
    expect(pkg.exports?.["./web"]).toBe("./web/index.ts");
  });

  // i18n 资源必须由入口转出（宿主统一注册）；迁移后 observer 侧删除键的前提是这里已提供。
  test("入口导出 sandbox 命名空间与 en/zh 资源", () => {
    const source = stripComments(readFileSync(WEB_ENTRY, "utf8"));
    expect(source).toContain("SANDBOX_NS");
    expect(source).toContain("sandboxResources");
  });
});
