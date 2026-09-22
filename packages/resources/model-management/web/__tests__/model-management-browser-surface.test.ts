// web/__tests__/model-management-browser-surface.test.ts
// 守护 `@fenix/model-management/web` 的浏览器可达面（2026-08-17 事故同类风险）。
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
 * 收录条件：由宿主提供（本包 peerDependency）或本包直接声明并直接引用的纯浏览器库——即与
 * `package.json` 的依赖声明一一对应。workspace 包一律不收录——它们必须被递归进入，否则
 * `@fenix/x/server` 又能穿透（见「白名单不收录 workspace 包」）。
 *
 * 兄弟包经 `@fenix/ui-components` / `@fenix/web-runtime` / 资源包子路径带进来的
 * 外部库（`@radix-ui/*`、knowledge 的 `mammoth` 等）**不在此列**：那些引用由各自包内的
 * 同款守卫评审（见 ownRefs）。未收录的自有依赖一旦被引入就会让本测试变红，从而强制一次浏览器可用性评审。
 */
const BROWSER_SAFE_EXTERNAL: ReadonlyMap<string, string> = new Map([
  // 宿主提供：本包 package.json 的 peerDependency
  ["react", "React 运行时（本包 peerDependency，宿主注入）"],
  ["react-i18next", "React i18n 绑定（本包 peerDependency）"],
  ["i18next", "i18n 运行时（本包 peerDependency；图不直接引用，react-i18next 依赖它）"],
  ["@tanstack/react-router", "路由钩子 useNavigate（本包 peerDependency，宿主提供 router 上下文）"],
  // 本包直接声明并直接引用的纯浏览器库（无 node 依赖）
  ["@lobehub/icons", "模型品牌图标（本包 dependencies），SVG 组件，只在 ModelIcon 内出现"],
  ["ahooks", "useRequest 数据获取（本包 dependencies）"],
  ["lucide-react", "SVG 图标库（本包 dependencies）"],
  ["recharts", "用量趋势图（本包 dependencies），纯浏览器实现"],
  ["sonner", "Toast 渲染（本包 dependencies）"],
]);

const graph = walkValueGraph(WEB_ENTRY);
/** 违规定位用仓库根相对路径：图现在跨包（ui-components / web-runtime / identity / 兄弟资源包），包内相对路径会产生 `../../` 噪音。 */
const describeRef = (ref: { from: string; specifier: string }): string => `${repoPath(ref.from)} → ${ref.specifier}`;
const offendersOf = (references: ReadonlyArray<{ from: string; specifier: string }>): string[] =>
  references.map(describeRef);
/**
 * 只取**本包文件发出**的引用。
 *
 * 递归会进入兄弟包（ui-components / web-runtime / identity / knowledge / observer / sandbox）的真实源码：
 * 那些包本轮也在切宿主别名、也在补齐自己的白名单，它们的问题由各自包内的同款守卫负责——本包既改不了
 * 也不该替它们变红（knowledge 的同名守卫对别名断言有同样的边界说明）。本包能担保的是「本包文件发出的
 * 引用」：不外泄宿主别名、不引入未评审的包外依赖、不反向引用自己的 server 出口。
 */
const ownRefs = (references: ReadonlyArray<{ from: string; specifier: string }>) =>
  references.filter((ref) => ref.from === WEB_ROOT || ref.from.startsWith(`${WEB_ROOT}${sep}`));
/** 包内到达文件（WEB_ROOT 相对）。 */
const reachedWebFiles = new Set(
  graph.files.filter((file) => file.startsWith(`${WEB_ROOT}${sep}`)).map((file) => relative(WEB_ROOT, file)),
);
/** 经 exports 递归进入的包外文件（仓库根相对）。 */
const reachedPackageFiles = new Set(
  graph.references.flatMap((ref) => (ref.kind === "file" && ref.scope === "cross-package" ? [repoPath(ref.file)] : [])),
);
const externals = graph.references.filter((ref) => ref.kind === "external");

describe("model-management web 入口浏览器可达面", () => {
  // 遍历有效性自检：图若解析失败会退化为「只有入口文件」，后续断言全部假绿。
  test("遍历有效性自检：包内模块与跨包 exports 目标都在到达集合中", () => {
    for (const expected of [
      "index.ts",
      "i18n/index.ts",
      "i18n/namespace.ts",
      "api/model-gateway.ts",
      "api/models.ts",
      "api/providers.ts",
      "components/config/ModelConfigDialog.tsx",
      "components/model-icon/ModelIcon.tsx",
      "components/model-icon/model-icon-map.ts",
      "lib/model-config-utils.ts",
      "lib/model-gateway-usage.ts",
      "lib/provider-resource-access.ts",
      "pages/admin/AdminModelGatewayPage.tsx",
      "pages/admin/ModelGatewayKeyManagementPanel.tsx",
      "pages/agent-panel/pages/AgentModelsPage.tsx",
      "pages/agent-panel/pages/ModelGatewayUsagePage.tsx",
      "pages/agent-panel/pages/VerticalModelsPage.tsx",
      "src/pages/agent-panel/pages/AlgorithmsPage.tsx",
    ]) {
      expect(reachedWebFiles).toContain(expected);
    }
    expect(reachedWebFiles.size).toBeGreaterThanOrEqual(25);

    // 跨包递归的有效性：只钉稳定路径——ui-components 的按钮、web-runtime 的 request 与 org/session
    // 契约、兄弟资源包（observer / sandbox）的包根入口。少了这一段，「@fenix/* 被当成
    // 外部依赖放过」会以「包内断言全绿」的形式漏网。
    // 这里不再钉 knowledge：`EmbeddingModelManager` 收归 knowledge 后，本包与它已无值导入边。
    // 也不再钉 identity：§1.6 T7 后本包的组织/会话取值经 `@fenix/web-runtime` 契约，
    // 图里已没有 platform-impl 这条边（`special-dependency` 同批归零）。
    for (const expected of [
      "packages/ui-components/web/ui/button.tsx",
      "packages/web-runtime/web/api/request.ts",
      "packages/web-runtime/web/contexts/org-session.tsx",
      "packages/resources/observer/web/index.ts",
      "packages/resources/sandbox/web/index.ts",
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

  // 宿主别名会让包离开 apps/web 的 tsconfig/vite 配置后无法解析，属于 1.3 的硬性禁止项（静态条件 2）。
  // 只查本包文件：兄弟包的别名残留由它们各自包内的同款守卫负责（见 ownRefs 的说明）。
  test("本包 web 文件不残留宿主别名（@/src、@/components）", () => {
    const offenders = ownRefs(graph.references).filter((ref) => /^@\/(src|components)(\/|$)/.test(ref.specifier));
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
  // 只评审**本包文件发出**的包外依赖：递归进入的兄弟包会带来它们自己的依赖（knowledge 的 mammoth /
  // xlsx、identity 的 better-auth 等），那些由各自的守卫与依赖声明负责，列进本包白名单只会制造噪音。
  // 本包直连的外部依赖因此必须逐一出现在上面的白名单里——新增一个未评审的库即变红。
  test("本包直连的包外运行时依赖在白名单内", () => {
    const offenders = ownRefs(externals).filter((ref) => !BROWSER_SAFE_EXTERNAL.has(ref.root));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 浏览器入口的实现文件里不得 import `@fenix/model-management/server` 之类子路径（自我回环）。
  // 断言扫**本包文件**的全部引用而不是只扫外部依赖：递归进入后自我引用会被解析掉，只看 externals 就漏了；
  // 同时不能用包名过滤全局引用——兄弟包 import `@fenix/model-management/web` 是合法消费。
  test("本包 web 文件不导入本包的 server / module 出口", () => {
    const offenders = ownRefs(graph.references).filter((ref) => ref.specifier.startsWith(`${PKG_NAME}/`));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 负例（人为注入，不建 fixture 文件）：`<pkg>/server` 是本包真实存在的 exports 出口，其后是
  // elysia / drizzle / node 内建。两条断言缺一不可——只断言「有违规」会被「递归失效、说明符本身被
  // 当成外部依赖」满足；只断言「进到了服务端实现」则漏掉拦截能力。
  // `@server/*` 的断言在 §1.7 B10 由「必须出现」改为「必须为空」（零容忍）：它原先的载体不是本包自己的
  // 宿主导入，而是 `@fenix/resource-memory` 那条残留（poisoned 图经上游包递归到 memory 的仓储，见 §7.22），
  // B10 清掉它之后本包的 poisoned 图不再命中 `@server/`。断言因此从「取样」升级为「全图零容忍」，与上面
  // 正向图的同名断言同口径；「递归够深」仍由上面两条 `poisoned.files` 断言承担。
  test("负例：注入真实的 ./server 出口时递归进入服务端实现并触发拦截", () => {
    const poisoned = walkValueGraph(WEB_ENTRY, [`${PKG_NAME}/server`]);
    expect(poisoned.files).toContain(join(PKG_ROOT, "src", "server.ts"));
    const serverDir = `${join(PKG_ROOT, "src", "server")}${sep}`;
    expect(poisoned.files.filter((file) => file.startsWith(serverDir)).length).toBeGreaterThan(0);
    const nodeBuiltins = poisoned.references.filter((ref) => ref.specifier.startsWith("node:"));
    const hostServer = poisoned.references.filter((ref) => ref.specifier.startsWith("@server/"));
    expect(offendersOf(nodeBuiltins).length).toBeGreaterThan(0);
    expect(offendersOf(hostServer)).toEqual([]);
  });

  // ./web 出口的契约：package.json 必须指向 web/index.ts，否则宿主解析到别的文件时守卫失去意义。
  test("package.json 的 ./web 出口指向 web/index.ts", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      exports?: Record<string, string>;
    };
    expect(pkg.exports?.["./web"]).toBe("./web/index.ts");
    expect(pkg.exports?.["./web/i18n"]).toBe("./web/i18n/index.ts");
  });

  // 根入口转出浏览器代码会把 React 页面图拖进服务端模块图（计划 §2.3 的 exports 注记）。
  test("根入口 src/index.ts 为空，浏览器能力只经 ./web 转出", () => {
    expect(stripComments(readFileSync(join(PKG_ROOT, "src", "index.ts"), "utf8")).trim()).toBe("export {};");
  });

  // i18n 资源必须由入口转出（宿主统一注册）；observer 侧删除 modelGateway 键的前提是这里已提供。
  test("入口导出命名空间常量与 en/zh 资源", () => {
    const source = stripComments(readFileSync(WEB_ENTRY, "utf8"));
    expect(source).toContain("MODELS_NS");
    expect(source).toContain("modelManagementResources");
  });

  // 跨包实测需求（本包是被测方，缺一个符号就会在对方的构建/守卫里炸）：把方向记在这里，任何一次
  // 「入口导出面缩水」都当场变红，而不是等 agent-config / knowledge / 宿主路由发现缺符号。
  // 只读文件不 import 入口（顶层副作用不该影响断言），因此逐条校验「入口转出该模块 + 模块导出该符号」。
  test("入口覆盖已实测的跨包消费符号", () => {
    const entry = stripComments(readFileSync(WEB_ENTRY, "utf8"));
    const declared = (specifier: string): string => {
      const base = join(WEB_ROOT, specifier);
      for (const candidate of [`${base}.ts`, `${base}.tsx`]) {
        if (existsSync(candidate)) return candidate;
      }
      throw new Error(`入口转出的模块不存在：${specifier}`);
    };
    for (const [specifier, names] of [
      ["./api/models", ["modelApi"]],
      ["./lib/provider-resource-access", ["getModelProviderKey", "isExternalModelProvider"]],
      ["./components/model-icon/ModelIcon", ["ModelIcon"]],
      ["./src/pages/agent-panel/pages/AlgorithmsPage", ["AlgorithmsPage"]],
    ] as const) {
      expect(entry).toContain(`"${specifier}"`);
      const module = readFileSync(declared(specifier), "utf8");
      for (const name of names) expect(module).toContain(name);
    }
  });
});
