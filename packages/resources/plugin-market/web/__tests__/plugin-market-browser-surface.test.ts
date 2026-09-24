// web/__tests__/plugin-market-browser-surface.test.ts
// 守护 `@fenix/resource-plugin-market/web` 的浏览器可达面（2026-08-17 事故同类风险）。
//
// 遍历口径在 ./value-import-graph：静态走 `web/index.ts` 的**值导入图**而不是对源码做字符串匹配，
// 并且 `@fenix/<pkg>[/<subpath>]` 会**经对方 package.json 的 exports 解析到真实源文件后递归进入**。
// 这正是事故的形态——`@fenix/x/server` 这类子路径会把 node 内建与服务端实现拖进浏览器 bundle，
// 而「记一条外部依赖放过」的旧口径对它完全无感（CLAUDE.md YJS 不变量 11）。
//
// 本包的风险点比 mcp 更靠前：它**同时持有** npm 私有源客户端与服务端路由，且两者都在 `src/server/**`
// 下、都会 import `node:` 内建（`fetch` 之外还有流式读取用的 web 流 API 与 crypto 摘要）。因此
// 「web 子图不得触达本包 ./server 出口」这条在本包不是形式要求，而是唯一的拦截面。
//
// 只读文件、不 import 被测模块：顶层副作用（如懒加载宿主单例）不该影响断言。

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { loadWorkspacePackages, repoPath, stripComments, WEB_ROOT, walkValueGraph } from "./value-import-graph";

const WEB_ENTRY = join(WEB_ROOT, "index.ts");
const PKG_ROOT = resolve(WEB_ROOT, "..");
/** 本包名：自我回环断言与负例注入都从 package.json 取，避免与 manifest 漂移。 */
const PKG_NAME = (JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as { name: string }).name;

/**
 * 浏览器安全外部依赖白名单：键是包根（`@scope/name` 或裸名），值说明它为什么可以停在图外。
 *
 * 收录条件：由宿主提供（本包 peerDependency）、本包/传递方 `dependencies` 里的纯浏览器库。
 * workspace 包一律不收录——它们必须被递归进入，否则 `@fenix/x/server` 又能穿透。
 * 未收录的库一旦被引入就会让本测试变红，从而强制做一次浏览器可用性评审。
 */
const BROWSER_SAFE_EXTERNAL: ReadonlyMap<string, string> = new Map([
  // 宿主提供：本包 package.json 声明的 peerDependency
  ["react", "React 运行时（本包 peerDependency，宿主注入）"],
  ["react-dom", "React DOM 渲染器（peerDependency；ui/ 组件经由 react 间接使用）"],
  ["react-i18next", "React i18n 绑定（本包 peerDependency）"],
  ["i18next", "i18n 运行时（本包 peerDependency；react-i18next 会用到）"],
  // 本包直接依赖的纯浏览器库
  ["ahooks", "React hooks 工具库（本包依赖，宿主亦直接依赖）"],
  ["lucide-react", "SVG 图标库（本包依赖，宿主亦直接依赖）"],
  ["sonner", "Toast 渲染（本包依赖，宿主亦直接依赖）"],
  ["zod", "运行时校验（本包依赖 zod/v4，纯函数，无 node 依赖）"],
  // 经 @fenix/ui-components 子路径传递进入：无 node 依赖的浏览器库
  ["@radix-ui/react-slot", "无样式原语（ui/button 传递依赖），只依赖 react/DOM"],
  ["@radix-ui/react-dialog", "无样式原语（config/FormDialog 的 ui/dialog 传递依赖）"],
  ["@radix-ui/react-alert-dialog", "无样式原语（config/ConfirmDialog 的 ui/alert-dialog 传递依赖）"],
  ["@radix-ui/react-scroll-area", "无样式原语（agent-master-detail-workspace 的滚动容器）"],
  ["@radix-ui/react-label", "无样式原语（ui/label 传递依赖，表单字段）"],
  ["class-variance-authority", "类名变体工具（ui/* 传递依赖），纯函数"],
  ["clsx", "类名拼接工具（lib/cn 传递依赖），纯函数"],
  ["tailwind-merge", "Tailwind 类名去重（lib/cn 传递依赖），纯函数"],
  ["react-hook-form", "表单状态库（config/FormDialog 传递依赖）"],
  ["@hookform/resolvers", "表单校验桥接（config/FormDialog 的 zodResolver）"],
]);

/** 全图宿主别名红线：`@/...` 说明符在整张值导入图里零容忍。 */
const ALIAS_SPECIFIER = /^@\//;

const graph = walkValueGraph(WEB_ENTRY);
const describeRef = (ref: { from: string; specifier: string }): string => `${repoPath(ref.from)} → ${ref.specifier}`;
const offendersOf = (references: ReadonlyArray<{ from: string; specifier: string }>): string[] =>
  references.map(describeRef);
/** 本包文件发射的引用：§1.3 硬条件（零宿主别名、零 @server）只对本包源码成立。 */
const ownReferences = graph.references.filter((ref) => ref.from.startsWith(`${WEB_ROOT}${sep}`));
const reachedWebFiles = new Set(
  graph.files.filter((file) => file.startsWith(`${WEB_ROOT}${sep}`)).map((file) => relative(WEB_ROOT, file)),
);
const reachedPackageFiles = new Set(graph.files.filter((file) => !file.startsWith(`${WEB_ROOT}${sep}`)).map(repoPath));
const externals = graph.references.filter((ref) => ref.kind === "external");

/** 收集 web 下的源码文件（排除测试与字典），供源码级断言使用。 */
function collectSources(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "__tests__" || entry === "locales") continue;
      files.push(...collectSources(path));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      files.push(path);
    }
  }
  return files;
}

describe("插件市场 web 入口浏览器可达面", () => {
  // 遍历有效性自检：图若解析失败会退化为「只有入口文件」，后续断言全部假绿。
  test("遍历有效性自检：包内模块与跨包 exports 目标都在到达集合中", () => {
    for (const expected of [
      "index.ts",
      "api/plugin-market.ts",
      "i18n/index.ts",
      "i18n/namespace.ts",
      "pages/agent-panel/pages/plugin-market-page.tsx",
      "pages/agent-panel/pages/plugin-market-catalog.tsx",
      "pages/agent-panel/pages/plugin-market-detail.tsx",
      "pages/agent-panel/pages/plugin-market-publish-dialog.tsx",
      "pages/agent-panel/pages/plugin-market-utils.ts",
    ]) {
      expect(reachedWebFiles).toContain(expected);
    }
    // `api/plugin-market-types.ts` 刻意**不在**上面这份清单里：它只被 `import type` 引用，编译期即擦除，
    // 出现在值导入图里反而说明有人在运行时 import 了一份纯类型模块。
    expect(reachedWebFiles.has("api/plugin-market-types.ts")).toBe(false);

    // 跨包递归的有效性：钉住每个上游包一条稳定路径。少了这一段，「@fenix/* 被当成外部依赖放过」
    // 会以「包内断言全绿」的形式漏网。
    //
    // 这里**不列** `packages/web-runtime/web/i18n/namespace.ts`：本包的命名空间常量是包自有字面量
    // （`web/i18n/namespace.ts`），中心表当前没有 `pluginMarket` 条目，页面不 import 它；列上去只会
    // 变成一条描述期望而非事实的断言。
    for (const expected of [
      "packages/ui-components/web/ui/button.tsx",
      "packages/ui-components/web/config/FormDialog.tsx",
      "packages/ui-components/web/config/ScopeFilterBar.tsx",
      "packages/web-runtime/web/api/request.ts",
    ]) {
      expect(reachedPackageFiles).toContain(expected);
    }
    expect(reachedPackageFiles.size).toBeGreaterThanOrEqual(20);
  });

  // 2026-08-17 事故的形态：`@fenix/<pkg>/<subpath>` 看起来像外部依赖，实则是穿透入口。
  test("跨包引用一律经 exports 递归进入，不停留在外部依赖", () => {
    const leaked = externals.flatMap((ref) => (ref.root.startsWith("@fenix/") ? [describeRef(ref)] : []));
    expect(leaked).toEqual([]);
  });

  // 白名单是「停在图外」的唯一放行方式，收录 workspace 包等于给上面的穿透开口子。
  test("白名单不收录 workspace 包", () => {
    const packages = loadWorkspacePackages();
    const leaked = [...BROWSER_SAFE_EXTERNAL.keys()].filter((root) => packages.has(root));
    expect(leaked).toEqual([]);
  });

  // 递归只沿 exports 出口走：图里出现 __tests__ 即说明有出口写错（测试代码会连同 bun:test 打进 bundle）。
  test("值导入图不进入任何测试文件", () => {
    const offenders = graph.files.filter((file) => file.includes(`${sep}__tests__${sep}`));
    expect(offenders.map(repoPath)).toEqual([]);
  });

  // node 内建一旦进入值导入图，浏览器构建只会得到外置桩并在加载期崩溃。
  test("值导入图不触及 node 内建", () => {
    const offenders = graph.references.filter((ref) => ref.specifier.startsWith("node:"));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // @server/* 是宿主服务端实现，包内 web 只能经 API 出口协作。
  test("值导入图不触及 @server 宿主服务端路径", () => {
    const offenders = graph.references.filter((ref) => ref.specifier.startsWith("@server/"));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 宿主别名会让包离开 apps/web 的 tsconfig/vite 配置后无法解析，属于硬性禁止项。
  test("全图零宿主别名（本包与上游包均不得发射 @/ 说明符）", () => {
    const offenders = graph.references.filter((ref) => ALIAS_SPECIFIER.test(ref.specifier));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 跨包必须走 exports 出口：@fenix/*/src 之类的深路径会把别的包的内部实现拖进浏览器图。
  test("跨包引用不深入 @fenix/*/src 内部路径", () => {
    const offenders = graph.references.filter((ref) => /^@fenix\/[^/]+\/src(\/|$)/.test(ref.specifier));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // exports 未声明、或目标文件不存在：宿主与包都解析不到，只在构建期才炸，这里提前钉住。
  test("跨包出口均可解析（exports 未声明或目标缺失即违规）", () => {
    const offenders = graph.references.flatMap((ref) =>
      ref.kind === "violation" ? [`${describeRef(ref)}：${ref.detail}`] : [],
    );
    expect(offenders).toEqual([]);
  });

  // 未列入白名单的裸包说明符可能是「忘记声明依赖」或「引入了非浏览器库」，必须显式评审。
  test("包外运行时依赖在白名单内", () => {
    const offenders = externals.filter((ref) => !BROWSER_SAFE_EXTERNAL.has(ref.root));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 浏览器入口的实现文件里不得 import '@fenix/resource-plugin-market/server' 之类子路径（自我回环）。
  // 断言扫全部引用而不是只扫外部依赖：递归进入后自我引用会被解析掉，只看 externals 就漏了。
  test("web 子图不导入本包的 server / module 出口", () => {
    const offenders = graph.references.filter((ref) => ref.specifier.startsWith(`${PKG_NAME}/`));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 负例（人为注入）：`<pkg>/server` 是本包真实存在的 exports 出口，其后是 drizzle / elysia 与二十来个
  // 服务端实现文件。两条断言缺一不可——只断言「有违规」会被「递归失效、说明符本身被当成外部依赖」满足；
  // 只断言「进到了服务端实现」则漏掉拦截能力。
  //
  // 拦截面的取值经过实测：本包服务端的 HTTP 传输走 `fetch` / `AbortSignal`（都是浏览器也有的 Web API），
  // 因此**注入后不会出现 `node:` 内建**（mcp 的负例靠它，这里不行）。真正会命中的是白名单——注入图里带出
  // `drizzle-orm` 这类只可能跑在服务端的依赖，下面第二条断言正是「白名单会拦住它」。
  test("负例：注入真实的 ./server 出口时递归进入服务端实现并被白名单拦下", () => {
    const poisoned = walkValueGraph(WEB_ENTRY, [`${PKG_NAME}/server`]);
    expect(poisoned.files).toContain(join(PKG_ROOT, "src", "server.ts"));
    const serverDir = `${join(PKG_ROOT, "src", "server")}${sep}`;
    expect(poisoned.files.filter((file) => file.startsWith(serverDir)).length).toBeGreaterThan(0);
    const leaked = poisoned.references.filter((ref) => ref.kind === "external" && !BROWSER_SAFE_EXTERNAL.has(ref.root));
    expect(offendersOf(leaked).length).toBeGreaterThan(0);
  });

  // ./web 出口的契约：package.json 必须指向 web/index.ts，否则宿主解析到别的文件时守卫失去意义。
  //
  // `./web/contribution` 是**反向**契约：本市场不是侧栏项（它是 `/agent/mcp?tab=npm` 这一个 tab），
  // 一旦重新声明该出口，就等于给侧栏塞进第二个「插件市场」入口——manifest 的 `web.id` 与导航项 id
  // 必须同名，两边会同时复活。
  test("package.json 的 ./web 与 ./web/i18n 出口指向真实文件，且不声明导航载荷出口", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      exports?: Record<string, string>;
    };
    expect(pkg.exports?.["./web"]).toBe("./web/index.ts");
    expect(pkg.exports?.["./web/i18n"]).toBe("./web/i18n/index.ts");
    expect(pkg.exports?.["./web/contribution"]).toBeUndefined();
    expect(existsSync(join(PKG_ROOT, "web", "index.ts"))).toBe(true);
    expect(existsSync(join(PKG_ROOT, "web", "i18n", "index.ts"))).toBe(true);
  });

  // 跨包消费面（宿主路由懒加载页面、宿主 i18n 登记）必须由入口转出，消费方不得进入实现路径。
  test("入口导出跨包消费面：页面、API client、纯逻辑助手、i18n 资源", () => {
    const source = stripComments(readFileSync(WEB_ENTRY, "utf8"));
    for (const name of [
      "PluginMarketPage",
      "PLUGIN_MARKET_NS",
      "pluginMarketResources",
      "./api/plugin-market",
      "./pages/agent-panel/pages/plugin-market-utils",
    ]) {
      expect(source).toContain(name);
    }
  });

  // 页面不得直接 import 宿主的实现路径或平台实现：包一旦依赖宿主别名就无法独立构建。
  test("本包源码不残留宿主别名与 @server 导入", () => {
    const offenders = ownReferences.filter(
      (ref) => ALIAS_SPECIFIER.test(ref.specifier) || ref.specifier.startsWith("@server/"),
    );
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 页面不得自建 React context（组织上下文只能来自宿主挂载的同一份实例）：包内另建一份会让取值永远是默认值，
  // 而这种现象在界面上只表现为「权限判定全体失效」，很难从现象反推。
  test("包内不另建 React context", () => {
    const offenders = collectSources(WEB_ROOT).filter((file) =>
      /\bcreateContext\b/.test(stripComments(readFileSync(file, "utf8"))),
    );
    expect(offenders.map(repoPath)).toEqual([]);
  });
});
