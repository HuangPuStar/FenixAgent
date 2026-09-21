// web/__tests__/prod-view-browser-surface.test.ts
// 守护 `@fenix/resource-prod-view/web` 的浏览器可达面（2026-08-17 事故同类风险）。
//
// 遍历口径在 ./value-import-graph：静态走 `web/index.ts` 的**值导入图**而不是对源码做字符串匹配，
// 并且 `@fenix/<pkg>[/<subpath>]` 会**经对方 package.json 的 exports 解析到真实源文件后递归进入**。
// 这正是事故的形态——`@fenix/x/server` 这类子路径会把 node 内建与服务端实现拖进浏览器 bundle，
// 而「记一条外部依赖放过」的旧口径对它完全无感（CLAUDE.md YJS 不变量 11）。
// 递归的代价是放行必须显式：只有下面的白名单里的**浏览器安全外部依赖**才允许停在图外。
//
// 两条跨包口径（本包特有，必须在断言里显式区分，否则守卫要么假红要么假绿）：
//   1. 本包消费 `@fenix/agent-config` 的浏览器能力。agent-config 的
//      `exports["./web"]` 现指向它自己的 `web/index.ts`（全量索引，其文件头自述「导出面覆盖当前跨包
//      消费方」），因此递归会经它进入编辑器，再连带 identity / knowledge / memory / machine / mcp /
//      model-management / sandbox / skill / agent-runtime 的 web 入口。
//      （2026-09-21 T5b 起本包不再消费聊天包：分享页的聊天容器改为宿主经 `chatArea` prop 注入，
//      `@fenix/chat-channel` 已整个离开本条值导入图，不再是登记项。）
//      这些包图内的文件仍写着宿主别名 `@/...`，既无法递归进去（宿主别名不是包说明符，只能由宿主
//      vite alias 解析），也不是本包能改的。因此「零宿主别名」按计划 §1 条件 2 的口径**限定在本包
//      文件**，跨包残留改为登记制断言：只有登记过的包允许有别名残留，出现第三处即失败。
//   2. `@/...` 停在图外意味着那些包的后半段（如 agent-config 编辑器的宿主别名段）**不在本守卫
//      覆盖范围内**：它们是否浏览器安全由各自守卫负责，本包的结论只说「本包能看到的这一层是安全的」。
//      因此本文件的白名单收录了经这些包传递进入的外部库（逐条评审后登记），它们的版本与用法变动由
//      对应包的守卫负责。
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
 * 收录条件：由宿主提供（本包 peerDependency），或经 `@fenix/ui-components` / `@fenix/agent-config/web`
 * 子路径传递进入的纯浏览器库。workspace 包一律不收录——它们必须被递归进入，否则 `@fenix/x/server`
 * 又能穿透（见「白名单不收录 workspace 包」）。未收录的库一旦被引入就会让本测试变红，
 * 从而强制做一次浏览器可用性评审。带「经 agent-config 传递」的条目是该包全量索引的传导项，
 * 无法从本包侧消除（见文件头第 1 条）。
 */
const BROWSER_SAFE_EXTERNAL: ReadonlyMap<string, string> = new Map([
  // 宿主提供：本包 package.json 声明的 peerDependency
  ["react", "React 运行时（本包 peerDependency，宿主注入）"],
  ["react-i18next", "React i18n 绑定（本包 peerDependency）"],
  ["i18next", "i18n 运行时（本包 peerDependency；当前图不直接引用，react-i18next 会用到）"],
  ["@tanstack/react-router", "路由运行时（本包 peerDependency，宿主 router 单例）"],
  // 本包 direct dependency：无 node 依赖的浏览器库
  ["ahooks", "React hooks 工具库（本包 dependencies，亦被既有页面使用）"],
  ["lucide-react", "SVG 图标库（本包 dependencies）"],
  ["sonner", "Toast 渲染（本包 dependencies）"],
  // 经 @fenix/ui-components 子路径传递进入：无 node 依赖的浏览器库
  ["@radix-ui/react-slot", "无样式原语（ui/button 传递依赖），只依赖 react/DOM"],
  ["@radix-ui/react-dialog", "无样式原语（ui/dialog、config/ConfirmDialog 传递依赖）"],
  ["@radix-ui/react-alert-dialog", "无样式原语（ui/alert-dialog 传递依赖）"],
  ["@radix-ui/react-popover", "无样式原语（ui/popover 传递依赖）"],
  ["@radix-ui/react-scroll-area", "无样式原语（ui/scroll-area 传递依赖）"],
  ["@radix-ui/react-select", "无样式原语（ui/select 传递依赖）"],
  ["@radix-ui/react-switch", "无样式原语（ui/switch 传递依赖）"],
  ["@radix-ui/react-label", "无样式原语（ui/label 传递依赖）"],
  ["class-variance-authority", "类名变体工具（ui/* 传递依赖），纯函数"],
  ["clsx", "类名拼接工具（lib/cn 传递依赖），纯函数"],
  ["tailwind-merge", "Tailwind 类名去重（lib/cn 传递依赖），纯函数"],
  ["cmdk", "命令面板组件（ui/command 传递依赖），浏览器安全"],
  // 经 @fenix/agent-config/web 传递进入：该包 exports["./web"] 是「覆盖当前跨包消费方」的全量索引，
  // 会连带其 Agent 编辑器 → 各资源包 web 面（identity / knowledge / machine / mcp / memory /
  // model-management / sandbox / skill / agent-runtime）的依赖。以下条目是 2026-09-20 递归扩面后
  // 逐条评审的结果；对应包的版本与用法变动由它们各自的浏览器守卫负责。
  ["react-dom", "React DOM（agent-config 编辑器传递依赖，宿主亦提供）"],
  ["react-hook-form", "表单状态库（agent-config 编辑器传递依赖），只依赖 react/DOM"],
  ["@hookform/resolvers", "react-hook-form 的 zod 解析器（同上传导），纯函数"],
  ["zod", "schema 校验库（agent-config 与浏览器侧共用），纯函数"],
  ["qrcode", "二维码生成（agent-config 站点分享传递依赖），纯浏览器实现"],
  ["@lobehub/icons", "模型品牌图标（agent-config → model-management 传递依赖），SVG 资源，无 node 依赖"],
  // 经 @fenix/ui-components/* 子路径传递进入：被编辑器与 memory / knowledge 面板共用
  ["@radix-ui/react-checkbox", "无样式原语（ui/checkbox 传递依赖）"],
  ["@radix-ui/react-collapsible", "无样式原语（ui/collapsible 传递依赖）"],
  ["@radix-ui/react-dropdown-menu", "无样式原语（ui/dropdown-menu 传递依赖）"],
  ["@radix-ui/react-separator", "无样式原语（ui/separator 传递依赖）"],
  ["@radix-ui/react-slider", "无样式原语（ui/slider 传递依赖）"],
  ["@radix-ui/react-tabs", "无样式原语（ui/tabs 传递依赖）"],
  ["@radix-ui/react-tooltip", "无样式原语（ui/tooltip 传递依赖）"],
  ["radix-ui", "Radix 聚合包（ui/sheet、ui/progress 传递依赖），只重导出各原语"],
  ["recharts", "图表渲染（ui/chart 与 model-management 用量页传递依赖），纯浏览器实现"],
  ["streamdown", "流式 Markdown 渲染（ui-components chat 层传递依赖）"],
  // 经 agent-config 编辑器 → knowledge / memory 面板传递进入（这两个包的守卫另有其自身的收敛项）
  ["dompurify", "HTML 消毒（knowledge 资源预览与分块详情传递依赖），纯浏览器实现"],
  ["mammoth", "docx 转 HTML（knowledge 资源预览传递依赖），纯浏览器实现"],
  ["react-markdown", "Markdown 渲染（knowledge 资源预览传递依赖）"],
  ["remark-gfm", "GitHub 风格 Markdown 插件（同上）"],
  ["xlsx", "表格解析（同上），纯浏览器实现"],
  [
    "@antv/g6",
    "图可视化（knowledge 图谱面板传递依赖）：浏览器实现、无 node 内建；它在无 DOM 的测试环境导入即崩，" +
      "由 knowledge 侧改为懒加载处理，与本守卫的打包期结论无关",
  ],
  ["cytoscape", "图可视化（memory 图谱组件传递依赖），纯浏览器实现"],
  ["cytoscape-fcose", "cytoscape 布局插件（同上）"],
  ["@chenglou/pretext", "排版测量（memory 对话文本层传递依赖），纯浏览器实现"],
  // 经 @fenix/identity/web 子路径传递进入（§6.5 裁定 useOrg 必须取宿主同一份 context）
  ["better-auth", "认证客户端 SDK（identity lib/auth-client 的 client/react 入口）"],
  ["@better-auth/api-key", "API Key 客户端插件（identity lib/auth-client）"],
  ["@noble/ciphers", "纯 JS 密码学实现（identity lib/password-crypto），无 node 依赖"],
]);

// 曾有一张 `PENDING_MIGRATION_DIRS` 登记表：迁移期允许「跨包宿主别名只来自已登记目录」，被登记的包迁完后
// 收窄一条。2026-09-21（T5b）它的最后两条也失效了——identity web 面的别名在 T4a 清零、chat-channel 随
// ChatArea 迁往宿主而整个离开本图，全图实测 0 处宿主别名，该表退化为「空集恒真」且字面描述已失实（
// T5b 复核发现）。故连同 `underPendingDirs` 一并删除，断言直接要求全图零别名：这与登记表清空后的语义等价，
// 但不再有一张能被删空而不影响任何断言的表。若将来又出现「迁移进行中、必须容忍某包别名」的需要，
// 可照本文件的历史版本恢复登记制，并在恢复时同步写明 owner 与移除条件。

const graph = walkValueGraph(WEB_ENTRY);
/** 违规定位用仓库根相对路径：图跨包（ui-components / web-runtime / agent-config 及其编辑器连带的多包 web 面），包内相对路径会产生 `../../` 噪音。 */
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
/** 本包文件发出的引用：§1.3 硬条件（零宿主别名、依赖已声明）只对本包文件成立。 */
const ownRefs = graph.references.filter((ref) => ref.from.startsWith(`${WEB_ROOT}${sep}`));
/** 跨包文件发出的引用：跨包别名断言的对象。 */
const foreignRefs = graph.references.filter((ref) => !ref.from.startsWith(`${WEB_ROOT}${sep}`));
const isHostAlias = (specifier: string): boolean => /^@\/(src|components)(\/|$)/.test(specifier);

describe("prod-view web 入口浏览器可达面", () => {
  // 遍历有效性自检：图若解析失败会退化为「只有入口文件」，后续断言全部假绿。
  test("遍历有效性自检：包内模块与跨包 exports 目标都在到达集合中", () => {
    for (const expected of [
      "index.ts",
      "i18n/index.ts",
      "i18n/namespace.ts",
      "api/prod-views.ts",
      "lib/prod-view-modules.ts",
      join("pages", "agent-panel", "ProdViewsPanel.tsx"),
      join("pages", "agent-panel", "pages", "AgentProdViewsPage.tsx"),
      join("pages", "prod-view", "ProdViewPage.tsx"),
    ]) {
      expect(reachedWebFiles).toContain(expected);
    }
    expect(reachedWebFiles.size).toBeGreaterThanOrEqual(8);

    // 跨包递归的有效性：钉住本包真实消费的三条链——ui-components 的按钮、web-runtime 的 request 与
    // ns 表、agent-config 的 web 出口（当前解析到 web/index.ts 全量索引）。少了这一段，
    // 「@fenix/* 被当成外部依赖放过」会以「包内断言全绿」的形式漏网。
    // （2026-09-21 T5b 起不再有第四条：分享页的聊天容器改为宿主经 `chatArea` prop 注入，
    //  本包不再引用任何聊天包，`@fenix/chat-channel/web/chat-area` 这条链已消失。）
    for (const expected of [
      "packages/ui-components/web/ui/button.tsx",
      "packages/web-runtime/web/api/request.ts",
      "packages/web-runtime/web/i18n/namespace.ts",
      "packages/resources/agent-config/web/index.ts",
    ]) {
      expect(reachedPackageFiles).toContain(expected);
    }
    expect(reachedPackageFiles.size).toBeGreaterThanOrEqual(15);
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

  // 宿主别名会让包离开 apps/web 的 tsconfig/vite 配置后无法解析，属于 1.3 的硬性禁止项（计划 §1 条件 2）。
  test("本包文件零宿主别名（@/src、@/components）", () => {
    const offenders = ownRefs.filter((ref) => isHostAlias(ref.specifier));
    expect(offendersOf(offenders)).toEqual([]);
    expect(ownRefs.length).toBeGreaterThan(20);
  });

  // 跨包文件同样不得写宿主别名：任何包（含经 agent-config 编辑器间接到达的包）开始泄漏都在这里失败。
  test("跨包文件零宿主别名（登记制已于 T5b 清空，见文件头说明）", () => {
    const offenders = foreignRefs.filter((ref) => isHostAlias(ref.specifier));
    expect(offendersOf(offenders)).toEqual([]);
    // 有效性自检：跨包引用本身非空，证明上面空集不是「图没跨包」造成的。
    expect(foreignRefs.length).toBeGreaterThan(20);
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
  // 宿主别名（`@/src`、`@/components`）不在这里评审：它们由上面两条别名断言按「本包 / 登记包」分别处理，
  // 放到白名单里等于用一条注释抵消掉别名禁令。
  test("包外运行时依赖在白名单内", () => {
    const offenders = externals.filter((ref) => !BROWSER_SAFE_EXTERNAL.has(ref.root) && !isHostAlias(ref.specifier));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 浏览器入口的实现文件里不得 import '@fenix/resource-prod-view/server' 之类子路径（自我回环）。
  // 断言扫全部引用而不是只扫外部依赖：递归进入后自我引用会被解析掉，只看 externals 就漏了。
  test("web 子图不导入本包的 server / module 出口", () => {
    const offenders = graph.references.filter((ref) => ref.specifier.startsWith(`${PKG_NAME}/`));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 负例（人为注入，不建 fixture 文件）：`<pkg>/server` 是本包真实存在的 exports 出口，其后是
  // elysia / drizzle / @server/* 与 agent-runtime 的实例编排链。两条断言缺一不可——只断言「有违规」
  // 会被「递归失效、说明符本身被当成外部依赖」满足；只断言「进到了服务端实现」则漏掉拦截能力。
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
  test("package.json 的 ./web 出口指向 web/index.ts", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      exports?: Record<string, string>;
    };
    expect(pkg.exports?.["./web"]).toBe("./web/index.ts");
  });

  // i18n 资源与命名空间必须由入口转出（宿主统一注册，走 ./web/i18n 子路径，见 web/i18n/index.ts）。
  test("入口导出 prodViews 命名空间与 en/zh 资源", () => {
    const source = stripComments(readFileSync(WEB_ENTRY, "utf8"));
    expect(source).toContain("PROD_VIEWS_NS");
    expect(source).toContain("prodViewsResources");
  });
});
