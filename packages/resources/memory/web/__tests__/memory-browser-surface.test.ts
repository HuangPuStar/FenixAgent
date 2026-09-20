// web/__tests__/memory-browser-surface.test.ts
// 守护 `@fenix/resource-memory/web` 的浏览器可达面（2026-08-17 事故同类风险）。
//
// 遍历口径在 ./value-import-graph：静态走 `web/index.ts` 的**值导入图**而不是对源码做字符串匹配，
// 并且 `@fenix/<pkg>[/<subpath>]` 会**经对方 package.json 的 exports 解析到真实源文件后递归进入**。
// 这正是事故的形态——`@fenix/x/server` 这类子路径会把 node 内建与服务端实现拖进浏览器 bundle，
// 而「记一条外部依赖放过」的旧口径对它完全无感（CLAUDE.md YJS 不变量 11）。递归的代价是放行必须显式：
// 只有下面的白名单里的**浏览器安全外部依赖**才允许停在图外。
//
// 本文件只放**本包的策略与断言**，图里可能出现的违规形态各自有独立断言，便于定位：
//   - `node:*`：浏览器里是 Vite 外置桩，import 期即崩；
//   - `@server/*`：宿主服务端实现，浏览器构建根本不该看见；
//   - 宿主别名 `@/...`：包一旦依赖它就无法独立构建（§1.3 硬条件：包内 web 零宿主别名）；
//   - exports 未声明 / 目标缺失的跨包说明符，以及解析不到实现的相对说明符。
//
// 测试文件与 `node:*` 的豁免：递归只沿 exports 出口走，而任何包的 exports 都不指向 `__tests__`，
// 所以 `bun:test` 与测试夹具不会进入图，不需要豁免；本文件自身的 `node:fs` 是守卫的运行时，
// 不是被守卫的浏览器面。另注：本测试只读文件，不 import 被测模块——顶层副作用（如懒加载宿主单例）
// 不该影响断言。

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { loadWorkspacePackages, repoPath, stripComments, WEB_ROOT, walkValueGraph } from "./value-import-graph";

const WEB_ENTRY = join(WEB_ROOT, "index.ts");
const PKG_ROOT = resolve(WEB_ROOT, "..");
/** 本包名：自我回环断言与负例注入都从 package.json 取，避免与 manifest 漂移。 */
const PKG_NAME = (JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as { name: string }).name;

/**
 * 浏览器安全外部依赖白名单：键是包根（`@scope/name` 或裸名），值说明它为什么可以停在图外。
 *
 * 收录条件：由宿主提供（本包 peerDependency）、记忆可视化用的纯浏览器库，或经
 * `@fenix/ui-components` 子路径传递进入的无 node 依赖原语。workspace 包一律不收录——它们必须被
 * 递归进入，否则 `@fenix/x/server` 又能穿透（见「白名单不收录 workspace 包」）。
 * 未收录的库一旦被引入就会让本测试变红，从而强制做一次浏览器可用性评审。
 */
const BROWSER_SAFE_EXTERNAL: ReadonlyMap<string, string> = new Map([
  // 宿主提供：本包 package.json 声明的 peerDependency
  ["react", "React 运行时（本包 peerDependency，宿主注入）"],
  ["react-i18next", "React i18n 绑定（本包 peerDependency）"],
  ["i18next", "i18n 运行时（本包 peerDependency；当前图不直接引用，react-i18next 会用到）"],
  // 本包可视化：无 node 依赖，只在浏览器里渲染
  ["cytoscape", "图布局/渲染库（Constellation 的知识图谱）"],
  ["cytoscape-fcose", "cytoscape 的 fcose 布局插件"],
  ["@chenglou/pretext", "文本测量与分行（Constellation 的连线标签）"],
  // 经 @fenix/ui-components 子路径传递进入：无 node 依赖的浏览器库
  ["@radix-ui/react-slot", "无样式原语（ui/button 传递依赖），只依赖 react/DOM"],
  ["@radix-ui/react-dialog", "无样式原语（ui/dialog 传递依赖）"],
  ["@radix-ui/react-label", "无样式原语（ui/label 传递依赖）"],
  ["@radix-ui/react-select", "无样式原语（ui/select 传递依赖）"],
  ["class-variance-authority", "类名变体工具（ui/* 传递依赖），纯函数"],
  ["clsx", "类名拼接工具（lib/cn 传递依赖），纯函数"],
  ["tailwind-merge", "Tailwind 类名去重（lib/cn 传递依赖），纯函数"],
  ["lucide-react", "SVG 图标库（宿主亦直接依赖）"],
  ["sonner", "Toast 渲染（宿主亦直接依赖）"],
]);

const graph = walkValueGraph(WEB_ENTRY);
/** 违规定位用仓库根相对路径：图现在跨包（ui-components / web-runtime），包内相对路径会产生 `../../` 噪音。 */
const describeRef = (ref: { from: string; specifier: string }): string => `${repoPath(ref.from)} → ${ref.specifier}`;
const offendersOf = (references: ReadonlyArray<{ from: string; specifier: string }>): string[] =>
  references.map(describeRef);
/** 包内到达文件（WEB_ROOT 相对）。 */
const reachedWebFiles = new Set(
  graph.files.filter((file) => file.startsWith(`${WEB_ROOT}${sep}`)).map((file) => relative(WEB_ROOT, file)),
);
/** 经 exports 递归进入的包外文件（仓库根相对）。 */
const reachedPackageFiles = new Set(
  graph.references.flatMap((ref) => (ref.kind === "file" && ref.scope === "cross-package" ? [repoPath(ref.file)] : [])),
);
const externals = graph.references.filter((ref) => ref.kind === "external");

describe("memory web 入口浏览器可达面", () => {
  // 遍历有效性自检：图若解析失败会退化为「只有入口文件」，后续断言全部假绿。
  test("遍历有效性自检：包内模块与跨包 exports 目标都在到达集合中", () => {
    for (const expected of [
      "index.ts",
      "i18n/index.ts",
      "i18n/namespace.ts",
      "api/hindsight.ts",
      "pages/hindsight/MemoriesPage.tsx",
      "pages/hindsight/types.ts",
      "pages/hindsight/components/DataView.tsx",
      "pages/hindsight/components/EntitiesView.tsx",
      "pages/hindsight/components/MentalModelsView.tsx",
      "pages/hindsight/components/Constellation.tsx",
      "pages/hindsight/components/Graph2d.tsx",
      "pages/hindsight/components/MemoryDetailModal.tsx",
      "pages/hindsight/components/MemoryDetailPanel.tsx",
      "pages/hindsight/components/MemoryViewSwitcher.tsx",
      "pages/hindsight/components/MemoryVisualizationShell.tsx",
    ]) {
      expect(reachedWebFiles).toContain(expected);
    }
    expect(reachedWebFiles.size).toBeGreaterThanOrEqual(15);

    // 跨包递归的有效性：只钉两条稳定路径——ui-components 的按钮与 web-runtime 的 request 边界。
    // 少了这一段，「@fenix/* 被当成外部依赖放过」会以「包内断言全绿」的形式漏网。
    for (const expected of [
      "packages/ui-components/web/ui/button.tsx",
      "packages/web-runtime/web/api/request.ts",
      "packages/web-runtime/web/i18n/namespace.ts",
    ]) {
      expect(reachedPackageFiles).toContain(expected);
    }
    expect(reachedPackageFiles.size).toBeGreaterThanOrEqual(10);
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

  // 递归只沿 exports 出口走：任何包的 exports 都不该指向测试文件，图里出现 __tests__ 即说明有出口写错
  // （浏览器 bundle 会把测试代码与 bun:test 一起打进去）。这条把「测试文件不需要豁免」变成被守护的不变量。
  test("值导入图不进入任何测试文件", () => {
    const offenders = graph.files.filter((file) => file.includes(`${sep}__tests__${sep}`));
    expect(offenders.map(repoPath)).toEqual([]);
  });

  // node 内建一旦进入值导入图，浏览器构建只会得到外置桩并在加载期崩溃（chat-channel 事故）。
  test("值导入图不触及 node 内建", () => {
    const offenders = graph.references.filter((ref) => ref.specifier.startsWith("node:"));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // @server/* 是宿主服务端实现，包内 web 只能经 API + ./server 出口协作。
  test("值导入图不触及 @server 宿主服务端路径", () => {
    const offenders = graph.references.filter((ref) => ref.specifier.startsWith("@server/"));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 宿主别名会让包离开 apps/web 的 tsconfig/vite 配置后无法解析，属于 1.3 的硬性禁止项。
  test("值导入图不残留宿主别名（@/src、@/components）", () => {
    const offenders = graph.references.filter((ref) => /^@\/(src|components)(\/|$)/.test(ref.specifier));
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

  // 浏览器入口的实现文件里不得 import '@fenix/resource-memory/server' 之类子路径（自我回环）。
  // 断言扫全部引用而不是只扫外部依赖：递归进入后自我引用会被解析掉，只看 externals 就漏了。
  test("web 子图不导入本包的 server / module 出口", () => {
    const offenders = graph.references.filter((ref) => ref.specifier.startsWith(`${PKG_NAME}/`));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 负例（人为注入，不建 fixture 文件）：`<pkg>/server` 是本包真实存在的 exports 出口，其后是
  // elysia / drizzle / 宿主 @server/* 与平台 sdk。两条断言缺一不可——只断言「有违规」会被
  // 「递归失效、说明符本身被当成外部依赖」满足；只断言「进到了服务端实现」则漏掉拦截能力。
  // 本包的服务端子图不触及 `node:` 内建（实测 2026-09-20），因此这里用「宿主路径 + 未白名单外部依赖」
  // 作为违规信号，而不是照抄沙盒样本的 node: 断言。
  test("负例：注入真实的 ./server 出口时递归进入服务端实现并触发拦截", () => {
    const poisoned = walkValueGraph(WEB_ENTRY, [`${PKG_NAME}/server`]);
    expect(poisoned.files).toContain(join(PKG_ROOT, "src", "server.ts"));
    const serverDir = `${join(PKG_ROOT, "src", "server")}${sep}`;
    expect(poisoned.files.filter((file) => file.startsWith(serverDir)).length).toBeGreaterThan(0);
    const hostServer = poisoned.references.filter((ref) => ref.specifier.startsWith("@server/"));
    expect(offendersOf(hostServer).length).toBeGreaterThan(0);
    const poisonedExternals = poisoned.references.filter(
      (ref) => ref.kind === "external" && !BROWSER_SAFE_EXTERNAL.has(ref.root),
    );
    expect(offendersOf(poisonedExternals).length).toBeGreaterThan(0);
  });

  // ./web 出口的契约：package.json 必须指向 web/index.ts，否则宿主解析到别的文件时守卫失去意义。
  test("package.json 的 ./web 出口指向 web/index.ts", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      exports?: Record<string, string>;
    };
    expect(pkg.exports?.["./web"]).toBe("./web/index.ts");
  });

  // i18n 资源必须由入口转出：宿主经包入口注册字典（§1.6 接线），导出面不缩水是迁移的前提。
  test("入口导出 hindsight 命名空间与 en/zh 资源", () => {
    const source = stripComments(readFileSync(WEB_ENTRY, "utf8"));
    expect(source).toContain("HINDSIGHT_NS");
    expect(source).toContain("hindsightResources");
  });

  // CompactMarkdown 未被入口引用（当前无消费者），因此不得被浏览器面误引；
  // 一旦它被入口拉进图，react-markdown / remark-gfm 会立刻以「未白名单外部依赖」失败——这条
  // 把「新增消费者时必须先评审 markdown 渲染链的浏览器安全性」写进断言。
  test("无消费者的 CompactMarkdown 未进入浏览器图", () => {
    expect(reachedWebFiles.has(`pages/hindsight/components/CompactMarkdown.tsx`)).toBe(false);
    expect(existsSync(join(WEB_ROOT, "pages/hindsight/components/CompactMarkdown.tsx"))).toBe(true);
  });
});
