// web/__tests__/trace-browser-surface.test.ts
// 守护 `@fenix/resource-trace/web` 的浏览器可达面（2026-08-17 事故同类风险）。
//
// 遍历口径在 ./value-import-graph：静态走 `web/index.ts` 的**值导入图**而不是对源码做字符串匹配，
// 并且 `@fenix/<pkg>[/<subpath>]` 会**经对方 package.json 的 exports 解析到真实源文件后递归进入**。
// 本包对这条口径尤其敏感：观测面板的服务端实现（`src/server/**`）会经 `@fenix/chat-channel/server` 拉进
// Yjs / Redis / node 内建，`@fenix/resource-trace/server` 这类子路径一旦从浏览器面漏进一句值导入，
// 前端 bundle 会在加载期直接崩（CLAUDE.md YJS 不变量 11 / chat-channel 浏览器面事故）。
//
// 本文件只放**本包的策略与断言**：
//   - `node:*`：浏览器里是 Vite 外置桩，import 期即崩；
//   - `@server/*`：宿主服务端实现，浏览器构建根本不该看见；
//   - 宿主别名 `@/...`：包一旦依赖它就无法独立构建（§1.3 硬条件：包内 web 零宿主别名）；
//   - exports 未声明 / 目标缺失的跨包说明符，以及解析不到实现的相对说明符。
//
// **两类「可构建性」断言的范围（本包 + 共享基础设施包）**：宿主别名与「外部依赖在白名单内」表达的是
// **文件所属包能否脱离 `apps/web` 的 vite/tsconfig 独立构建**，因此只对以下文件断言：本包文件，以及共享
// 基础设施包（`packages/ui-components`、`packages/web-runtime`）的文件——后者是本包 web 面的公共底座
// （`POLICED_DIRECTORIES` 逐目录列出）。其余经 exports 递归进入的文件只做「解析 / 穿透 / node 内建 /
// `@server`」断言：它们的内部卫生由各自包的 `web/__tests__/*-browser-surface` 守卫负责，一个文件只有一个
// owner。本包图的跨包面很窄（ui-components 的基础组件与共享件 + web-runtime 的 request / NS /
// use-request-signal），因此不再登记任何兄弟资源包的债务清单。
//
// 测试文件与 `node:*` 的豁免：递归只沿 exports 出口走，而任何包的 exports 都不指向 `__tests__`，
// 所以 `bun:test` 与测试夹具不会进入图，不需要豁免；本文件自身的 `node:fs` 是守卫的运行时，
// 不是被守卫的浏览器面。另注：本测试只读文件，不 import 被测模块——顶层副作用（如懒加载宿主单例）
// 不该影响断言。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { loadWorkspacePackages, repoPath, stripComments, WEB_ROOT, walkValueGraph } from "./value-import-graph";

const WEB_ENTRY = join(WEB_ROOT, "index.ts");
const PKG_ROOT = resolve(WEB_ROOT, "..");
/** 本包名：自我回环断言与负例注入都从 package.json 取，避免与 manifest 漂移。 */
const PKG_NAME = (JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as { name: string }).name;

/**
 * 浏览器安全外部依赖白名单：键是包根（`@scope/name` 或裸名），值说明它为什么可以停在图外。
 *
 * 收录条件：由宿主提供（本包 peerDependency），或经 `@fenix/ui-components` / `@fenix/web-runtime`
 * 子路径传递进入的纯浏览器库。workspace 包一律不收录——它们必须被递归进入，否则 `@fenix/x/server`
 * 又能穿透（见「白名单不收录 workspace 包」）。未收录的库一旦被引入就会让本测试变红，从而强制做一次
 * 浏览器可用性评审。
 */
const BROWSER_SAFE_EXTERNAL: ReadonlyMap<string, string> = new Map([
  // 宿主提供：本包 package.json 声明的 peerDependency
  ["react", "React 运行时（本包 peerDependency，宿主注入）"],
  ["react-dom", "React DOM 运行时（本包 peerDependency，宿主注入）"],
  ["react-i18next", "React i18n 绑定（本包 peerDependency）"],
  ["i18next", "i18n 运行时（本包 peerDependency；当前图不直接引用，react-i18next 会用到）"],
  // 本包 dependencies：可独立打进浏览器 bundle 的普通库
  ["ahooks", "React hooks 工具库（本包 dependencies；面板的 useRequest 取数）"],
  ["lucide-react", "SVG 图标库（本包 dependencies 直接使用）"],
  // 经 @fenix/ui-components 子路径传递进入：无 node 依赖的浏览器库
  ["@radix-ui/react-separator", "无样式原语（ui/separator 传递依赖）"],
  ["@radix-ui/react-slot", "无样式原语（ui/button、ui/badge 传递依赖）"],
  ["@radix-ui/react-tabs", "无样式原语（ui/tabs 传递依赖）"],
  ["class-variance-authority", "类名变体工具（ui/* 传递依赖），纯函数"],
  ["clsx", "类名拼接工具（lib/cn 传递依赖），纯函数"],
  ["tailwind-merge", "Tailwind 类名去重（lib/cn 传递依赖），纯函数"],
]);

const graph = walkValueGraph(WEB_ENTRY);
/** 违规定位用仓库根相对路径：图跨包（ui-components / web-runtime），包内相对路径会产生 `../../` 噪音。 */
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
// `flatMap` 而不是 `filter`：filter 不会收窄联合类型，后续读 `ref.root` 会报 TS2339。
const externals = graph.references.flatMap((ref) => (ref.kind === "external" ? [ref] : []));

/** 兄弟资源包：目录用于「断言范围」，包名用于「跨包只经包根 web 出口」的说明符检查。 */
const SIBLING_RESOURCES = [...loadWorkspacePackages().values()]
  .filter((pkg) => pkg.directory.startsWith("packages/resources/") && pkg.name !== PKG_NAME)
  .map((pkg) => ({ directory: pkg.directory, name: pkg.name }));
/**
 * 两类「可构建性」断言的断言范围：本包 + 共享基础设施包（文件头已说明理由）。
 *
 * 用显式目录白名单而不是「排除兄弟资源包」的补集：补集会随图上出现的新包自动扩大范围，让本包守卫因
 * 别人的迁移进度变红（兄弟资源包随后被本包经包根 web 出口消费时，其内部卫生仍归它自己的守卫）。
 */
const POLICED_DIRECTORIES = [repoPath(PKG_ROOT), "packages/ui-components", "packages/web-runtime"];
/** 该说明符发出方是否在断言范围内。 */
const policed = (file: string): boolean => {
  const path = repoPath(file);
  return POLICED_DIRECTORIES.some((directory) => path === directory || path.startsWith(`${directory}/`));
};

describe("trace web 入口浏览器可达面", () => {
  // 遍历有效性自检：图若解析失败会退化为「只有入口文件」，后续断言全部假绿。
  test("遍历有效性自检：包内模块与跨包 exports 目标都在到达集合中", () => {
    for (const expected of [
      "index.ts",
      "i18n/index.ts",
      "i18n/namespace.ts",
      "api/traces.ts",
      "components/TracePanel.tsx",
      "components/observation-badges.tsx",
      "components/graph/trace-graph.tsx",
      "components/graph/trace-graph-rows.tsx",
      "components/detail/observation-detail.tsx",
      "components/detail/chat-view.tsx",
      "hooks/use-session-traces.ts",
      "hooks/use-trace-observations.ts",
      "lib/observation-adapter.ts",
      "lib/graph/trace-graph-layout.ts",
    ]) {
      expect(reachedWebFiles).toContain(expected);
    }
    expect(reachedWebFiles.size).toBeGreaterThanOrEqual(20);

    // 跨包递归的有效性：钉住稳定路径——ui-components 的按钮/tabs 与 JSON 查看器（2026-10-10 从本包下沉），
    // web-runtime 的 request / NS 与取消信号 hook（同批下沉）。少了这一段，「@fenix/* 被当成外部依赖放过」
    // 会以「包内断言全绿」的形式漏网。
    for (const expected of [
      "packages/ui-components/web/ui/button.tsx",
      "packages/ui-components/web/ui/tabs.tsx",
      "packages/ui-components/web/ui/json-view.tsx",
      "packages/web-runtime/web/api/request.ts",
      "packages/web-runtime/web/i18n/namespace.ts",
      "packages/web-runtime/web/hooks/use-request-signal.ts",
    ]) {
      expect(reachedPackageFiles).toContain(expected);
    }
    expect(reachedPackageFiles.size).toBeGreaterThanOrEqual(8);
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

  // 观测读取的服务端链路（chat-channel 的 DocManager / Yjs / Redis）绝不可进入浏览器面：本包 web 面
  // 分工是「只调自己的 /web 接口」，`sessionId` 的换算归服务端。这条是上面「不触及 node 内建」在协议
  // 语义上的对应物——即便将来 chat-channel 的浏览器面变得安全，这个分工也不应被前端取数绕过。
  test("值导入图不触及 chat-channel（会话状态归服务端）", () => {
    const offenders = graph.references.filter((ref) => ref.kind === "external" && ref.root === "@fenix/chat-channel");
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 宿主别名会让包离开 apps/web 的 tsconfig/vite 配置后无法解析，属于 1.3 的硬性禁止项。
  // 范围见文件头：本包文件与共享基础设施包文件（兄弟资源包的同一断言归各自守卫）。
  test("本包与共享包文件不残留宿主别名（@/src、@/components）", () => {
    const offenders = graph.references.filter(
      (ref) => policed(ref.from) && /^@\/(src|components)(\/|$)/.test(ref.specifier),
    );
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
  test("本包与共享包的外部运行时依赖在白名单内", () => {
    const offenders = externals.filter((ref) => policed(ref.from) && !BROWSER_SAFE_EXTERNAL.has(ref.root));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 浏览器入口的实现文件里不得 import '@fenix/resource-trace/server' 之类子路径（自我回环）。
  // 断言扫全部引用而不是只扫外部依赖：递归进入后自我引用会被解析掉，只看 externals 就漏了。
  test("web 子图不导入本包的 server / module 出口", () => {
    const offenders = graph.references.filter((ref) => ref.specifier.startsWith(`${PKG_NAME}/`));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 负例（人为注入，不建 fixture 文件）：`<pkg>/server` 是本包真实存在的 exports 出口，其后是
  // elysia / drizzle / `@fenix/chat-channel/server`（Yjs、Redis）/ node 内建。两条断言缺一不可——只断言
  // 「有违规」会被「递归失效、说明符本身被当成外部依赖」满足；只断言「进到了服务端实现」则漏掉拦截能力。
  test("负例：注入真实的 ./server 出口时递归进入服务端实现并触发拦截", () => {
    const poisoned = walkValueGraph(WEB_ENTRY, [`${PKG_NAME}/server`]);
    expect(poisoned.files).toContain(join(PKG_ROOT, "src", "server.ts"));
    const serverDir = `${join(PKG_ROOT, "src", "server")}${sep}`;
    expect(poisoned.files.filter((file) => file.startsWith(serverDir)).length).toBeGreaterThan(0);
    // 「递归够深」由两条深度断言承担：走到会话解析（本包唯一的 yjs 消费点）与上游读取客户端，并经
    // `@fenix/chat-channel/server` 的跨包 exports 到达它的状态层（解析路径与真实消费方同一条）。
    expect(poisoned.files).toContain(join(PKG_ROOT, "src", "server", "services", "trace-session.ts"));
    expect(poisoned.files).toContain(join(PKG_ROOT, "src", "server", "services", "langfuse-client.ts"));
    // 跨包那一跳用仓库相对路径比对：`join(PKG_ROOT, "..")` 之类的层数假设会在包目录调整时静默指错。
    const poisonedRepoPaths = poisoned.files.map(repoPath);
    expect(poisonedRepoPaths).toContain("packages/chat-channel/src/state/doc-manager.ts");
    const nodeBuiltins = poisoned.references.filter((ref) => ref.specifier.startsWith("node:"));
    expect(offendersOf(nodeBuiltins).length).toBeGreaterThan(0);
  });

  // ./web 出口的契约：package.json 必须指向 web/index.ts，否则宿主解析到别的文件时守卫失去意义。
  test("package.json 的 ./web 出口指向 web/index.ts", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      exports?: Record<string, string>;
    };
    expect(pkg.exports?.["./web"]).toBe("./web/index.ts");
  });

  // 面板入口的对外面必须是「组件 + i18n」两项：i18n 资源由入口转出供宿主统一注册，其余内部模块
  // （取数层、图、详情）不得上入口——它们只属于面板内部实现，上入口就会变成事实契约。
  test("入口只导出 TracePanel 与 i18n 命名空间/资源", () => {
    const source = stripComments(readFileSync(WEB_ENTRY, "utf8"));
    expect(source).toContain("TRACE_NS");
    expect(source).toContain("traceResources");
    expect(source).toContain("TracePanel");
  });

  // 兄弟资源包只允许经「对方包根 / `./web` 出口」进入本包浏览器面：深层子路径
  // （如 `@fenix/resource-machine/web/api/registry`）会把别人的内部目录变成事实契约，
  // 对方重构内部结构时本包构建即断。两个包名风格（`@fenix/resource-x` 与 `@fenix/x`）都在此覆盖。
  test("兄弟资源包只经包根 web 出口进入（不写深层子路径）", () => {
    const offenders = graph.references.flatMap((ref) => {
      for (const sibling of SIBLING_RESOURCES) {
        if (!ref.specifier.startsWith(`${sibling.name}/`)) continue;
        const subpath = ref.specifier.slice(sibling.name.length + 1);
        if (subpath === "web") break;
        return [`${describeRef(ref)}：只允许 ${sibling.name} 或 ${sibling.name}/web`];
      }
      return [];
    });
    expect(offenders).toEqual([]);
  });
});
