// web/__tests__/mcp-browser-surface.test.ts
// 守护 `@fenix/resource-mcp/web` 的浏览器可达面（2026-08-17 事故同类风险）。
//
// 遍历口径在 ./value-import-graph：静态走 `web/index.ts` 的**值导入图**而不是对源码做字符串匹配，
// 并且 `@fenix/<pkg>[/<subpath>]` 会**经对方 package.json 的 exports 解析到真实源文件后递归进入**。
// 这正是事故的形态——`@fenix/x/server` 这类子路径会把 node 内建与服务端实现拖进浏览器 bundle，
// 而「记一条外部依赖放过」的旧口径对它完全无感（CLAUDE.md YJS 不变量 11）。
// 递归的代价是放行必须显式：只有下面的白名单里的**浏览器安全外部依赖**才允许停在图外。
//
// 本文件只放**本包的策略与断言**，图里可能出现的违规形态各自有独立断言，便于定位：
//   - `node:*`：浏览器里是 Vite 外置桩，import 期即崩；
//   - `@server/*`：宿主服务端实现，浏览器构建根本不该看见；
//   - 宿主别名 `@/...`：包一旦依赖它就无法独立构建（§1.3 硬条件：包内 web 零宿主别名）；
//   - exports 未声明 / 目标缺失的跨包说明符，以及解析不到实现的相对说明符。
//
// 测试文件与 `node:*` 的豁免：递归只沿 exports 出口走，而任何包的 exports 都不指向 `__tests__`，
// 所以 `bun:test` 与测试夹具不会进入图，不需要豁免；本文件自身的 `node:*` 是守卫的运行时，
// 不是被守卫的浏览器面。另注：本测试只读文件，不 import 被测模块——顶层副作用（如懒加载宿主单例）
// 不该影响断言。

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
 * 收录条件：由宿主提供（本包 peerDependency）、本包/传递方 `dependencies` 里的纯浏览器库，
 * 或经 `@fenix/ui-components`、`@fenix/identity/web` 子路径传递进入的纯浏览器库。
 * workspace 包一律不收录——它们必须被递归进入，否则 `@fenix/x/server` 又能穿透（见「白名单不收录
 * workspace 包」）。未收录的库一旦被引入就会让本测试变红，从而强制做一次浏览器可用性评审。
 */
const BROWSER_SAFE_EXTERNAL: ReadonlyMap<string, string> = new Map([
  // 宿主提供：本包 package.json 声明的 peerDependency
  ["react", "React 运行时（本包 peerDependency，宿主注入）"],
  ["react-i18next", "React i18n 绑定（本包 peerDependency）"],
  ["i18next", "i18n 运行时（本包 peerDependency；当前图不直接引用，react-i18next 会用到）"],
  // 本包直接依赖的纯浏览器库
  ["ahooks", "React hooks 工具库（本包依赖，宿主亦直接依赖）"],
  ["lucide-react", "SVG 图标库（本包依赖，宿主亦直接依赖）"],
  ["sonner", "Toast 渲染（本包依赖，宿主亦直接依赖）"],
  ["zod", "运行时校验（本包依赖 zod/v4，纯函数，无 node 依赖）"],
  // 经 @fenix/ui-components 子路径传递进入：无 node 依赖的浏览器库
  ["@radix-ui/react-slot", "无样式原语（ui/button 传递依赖），只依赖 react/DOM"],
  ["@radix-ui/react-dialog", "无样式原语（ui/dialog、config/ConfirmDialog 传递依赖）"],
  ["@radix-ui/react-alert-dialog", "无样式原语（ui/alert-dialog 传递依赖）"],
  ["@radix-ui/react-select", "无样式原语（ui/select 传递依赖）"],
  ["@radix-ui/react-collapsible", "无样式原语（ui/collapsible 传递依赖，编辑器 OAuth 折叠面板）"],
  ["@radix-ui/react-tabs", "无样式原语（ui/tabs 传递依赖，编辑器手工/JSON 双 Tab）"],
  ["@radix-ui/react-scroll-area", "无样式原语（ui/scroll-area 传递依赖）"],
  ["@radix-ui/react-label", "无样式原语（ui/label 传递依赖，经 identity 的 API Key 页面进入）"],
  ["class-variance-authority", "类名变体工具（ui/* 传递依赖），纯函数"],
  ["clsx", "类名拼接工具（lib/cn 传递依赖），纯函数"],
  ["tailwind-merge", "Tailwind 类名去重（lib/cn 传递依赖），纯函数"],
  ["react-hook-form", "表单状态库（ui-components config/FormDialog 传递依赖）"],
  ["@hookform/resolvers", "表单校验桥接（config/FormDialog 的 zodResolver）"],
  // 经 @fenix/identity/web 子路径传递进入：身份浏览器入口（§6.5 裁定 useOrg 必须取宿主同一份 context）
  ["@tanstack/react-router", "浏览器路由（identity OrgContext 的导航用）"],
  ["better-auth", "认证客户端 SDK（identity lib/auth-client 的 client/react 入口）"],
  ["@better-auth/api-key", "API Key 客户端插件（identity lib/auth-client）"],
  ["@noble/ciphers", "纯 JS 密码学实现（identity lib/password-crypto），无 node 依赖"],
]);

/**
 * 全图宿主别名红线：`@/...` 说明符在整张值导入图里零容忍。
 *
 * 历史（2026-09-20 实测）：本包 web 自身一直零别名，但上游 `@fenix/identity/web` 当时仍有 33 处
 * `@/src`、`@/components`；本包改不动也不该替它掩盖，于是把债务**钉到具体目录**
 * （`UPSTREAM_ALIAS_DEBT_DIR`）。§1.6 T4 把身份包的别名归零后，这份白名单失去唯一成员，
 * 原地删除并升级为严格断言：任何包往本包图里渗别名都直接失败，不再有「来自哪个目录」的例外。
 */
const ALIAS_SPECIFIER = /^@\//;

/** 到达的包内文件（WEB_ROOT 相对）。 */
const graph = walkValueGraph(WEB_ENTRY);
/** 违规定位用仓库根相对路径：图现在跨包（identity / ui-components / web-runtime），包内相对路径会产生 `../../` 噪音。 */
const describeRef = (ref: { from: string; specifier: string }): string => `${repoPath(ref.from)} → ${ref.specifier}`;
const offendersOf = (references: ReadonlyArray<{ from: string; specifier: string }>): string[] =>
  references.map(describeRef);
/** 本包文件发射的引用：§1.3 硬条件（零宿主别名、零 @server）只对本包源码成立。 */
const ownReferences = graph.references.filter((ref) => ref.from.startsWith(`${WEB_ROOT}${sep}`));
/** 包内到达文件（WEB_ROOT 相对）。 */
const reachedWebFiles = new Set(
  graph.files.filter((file) => file.startsWith(`${WEB_ROOT}${sep}`)).map((file) => relative(WEB_ROOT, file)),
);
/**
 * 经 exports 递归进入的包外文件（仓库根相对）。
 *
 * 用「图里的包外文件」而不是「scope 为 cross-package 的引用」：上游包内部继续用相对路径往下走
 * （如 `identity/web/index.ts` → `./contexts/OrgContext`），那一段的 scope 是 internal，只统计
 * cross-package 会低估到达面，甚至漏掉本包真正的组织上下文来源。
 */
const reachedPackageFiles = new Set(graph.files.filter((file) => !file.startsWith(`${WEB_ROOT}${sep}`)).map(repoPath));
const externals = graph.references.filter((ref) => ref.kind === "external");

/** 收集 web 下的源码文件（排除测试与字典），供「包内不得另建 context」这类源码级断言使用。 */
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

describe("mcp web 入口浏览器可达面", () => {
  // 遍历有效性自检：图若解析失败会退化为「只有入口文件」，后续断言全部假绿。
  test("遍历有效性自检：包内模块与跨包 exports 目标都在到达集合中", () => {
    for (const expected of [
      "index.ts",
      "i18n/index.ts",
      "i18n/namespace.ts",
      "api/mcp.ts",
      "lib/mcp-resource-access.ts",
      "pages/agent-panel/pages/AgentMcpPage.tsx",
      "pages/agent-panel/pages/agent-mcp-catalog.tsx",
      "pages/agent-panel/pages/agent-mcp-dialog.tsx",
      "pages/agent-panel/pages/agent-mcp-utils.ts",
    ]) {
      expect(reachedWebFiles).toContain(expected);
    }
    expect(reachedWebFiles.size).toBeGreaterThanOrEqual(9);

    // 跨包递归的有效性：钉住每个上游包一条稳定路径（ui-components 的按钮与表单弹窗、web-runtime 的
    // request/namespace、identity 的组织 context）。少了这一段，「@fenix/* 被当成外部依赖放过」
    // 会以「包内断言全绿」的形式漏网。
    for (const expected of [
      "packages/ui-components/web/ui/button.tsx",
      "packages/ui-components/web/config/FormDialog.tsx",
      "packages/web-runtime/web/api/request.ts",
      "packages/web-runtime/web/i18n/namespace.ts",
      "packages/platform/identity/web/contexts/OrgContext.tsx",
    ]) {
      expect(reachedPackageFiles).toContain(expected);
    }
    expect(reachedPackageFiles.size).toBeGreaterThanOrEqual(30);
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
  // 这条对全图生效：上游包（identity / ui-components）拖进 node 内建同样会炸本包的 bundle。
  test("值导入图不触及 node 内建", () => {
    const offenders = graph.references.filter((ref) => ref.specifier.startsWith("node:"));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // @server/* 是宿主服务端实现，包内 web 只能经 API + ./server 出口协作。对全图生效的理由同上。
  test("值导入图不触及 @server 宿主服务端路径", () => {
    const offenders = graph.references.filter((ref) => ref.specifier.startsWith("@server/"));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 宿主别名会让包离开 apps/web 的 tsconfig/vite 配置后无法解析，属于 1.3 的硬性禁止项。
  // 只断言本包源码：跨包文件里的别名（当前仅 identity）不是本包可修的内容，另由下一条钉住来源。
  test("本包源码不残留宿主别名（@/src、@/components）", () => {
    const offenders = ownReferences.filter((ref) => ALIAS_SPECIFIER.test(ref.specifier));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 全图零别名：上游身份包已于 §1.6 T4 归零，白名单删除后这里不再有「来自哪个目录」的例外。
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

  // 浏览器入口的实现文件里不得 import '@fenix/resource-mcp/server' 之类子路径（自我回环）。
  // 断言扫全部引用而不是只扫外部依赖：递归进入后自我引用会被解析掉，只看 externals 就漏了。
  test("web 子图不导入本包的 server / module 出口", () => {
    const offenders = graph.references.filter((ref) => ref.specifier.startsWith(`${PKG_NAME}/`));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 负例（人为注入，不建 fixture 文件）：`<pkg>/server` 是本包真实存在的 exports 出口，其后是
  // elysia / drizzle / 宿主 @server/* / node 内建。两条断言缺一不可——只断言「有违规」会被
  // 「递归失效、说明符本身被当成外部依赖」满足；只断言「进到了服务端实现」则漏掉拦截能力。
  test("负例：注入真实的 ./server 出口时递归进入服务端实现并触发拦截", () => {
    const poisoned = walkValueGraph(WEB_ENTRY, [`${PKG_NAME}/server`]);
    expect(poisoned.files).toContain(join(PKG_ROOT, "src", "server.ts"));
    const serverDir = `${join(PKG_ROOT, "src", "server")}${sep}`;
    expect(poisoned.files.filter((file) => file.startsWith(serverDir)).length).toBeGreaterThan(0);
    const nodeBuiltins = poisoned.references.filter((ref) => ref.specifier.startsWith("node:"));
    const hostServer = poisoned.references.filter((ref) => ref.specifier.startsWith("@server/"));
    expect(offendersOf(nodeBuiltins).length).toBeGreaterThan(0);
    expect(offendersOf(hostServer).length).toBeGreaterThan(0);
  });

  // ./web 出口的契约：package.json 必须指向 web/index.ts，否则宿主解析到别的文件时守卫失去意义。
  test("package.json 的 ./web 与 ./web/i18n 出口指向真实文件", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      exports?: Record<string, string>;
    };
    expect(pkg.exports?.["./web"]).toBe("./web/index.ts");
    expect(pkg.exports?.["./web/i18n"]).toBe("./web/i18n/index.ts");
    expect(existsSync(join(PKG_ROOT, "web", "index.ts"))).toBe(true);
    expect(existsSync(join(PKG_ROOT, "web", "i18n", "index.ts"))).toBe(true);
  });

  // 跨包消费面（宿主路由懒加载页面、宿主纯逻辑用例取库助手）必须由入口转出，消费方不得进入实现路径。
  test("入口导出跨包消费面：页面、API client、授权助手、i18n 资源", () => {
    const source = stripComments(readFileSync(WEB_ENTRY, "utf8"));
    for (const name of ["AgentMcpPage", "MCP_NS", "mcpResources", "./api/mcp", "./lib/mcp-resource-access"]) {
      expect(source).toContain(name);
    }
  });

  // 组织上下文必须取宿主挂载的同一份 React context 实例（§6.5 裁定）；包内另建一份会让 `useOrg`
  // 永远拿到默认值，且这种缺陷在界面上只表现为「权限判定全体失效」，很难从现象反推。
  test("组织上下文取自 @fenix/identity/web，包内不另建 context", () => {
    const page = readFileSync(join(WEB_ROOT, "pages/agent-panel/pages/AgentMcpPage.tsx"), "utf8");
    expect(page).toContain('from "@fenix/identity/web"');
    const offenders = collectSources(WEB_ROOT).filter((file) =>
      /\bcreateContext\b/.test(stripComments(readFileSync(file, "utf8"))),
    );
    expect(offenders.map((file) => repoPath(file))).toEqual([]);
  });
});
