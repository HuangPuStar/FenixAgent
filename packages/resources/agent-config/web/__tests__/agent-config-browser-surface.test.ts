// web/__tests__/agent-config-browser-surface.test.ts
// 守护 `@fenix/agent-config/web` 的浏览器可达面（2026-08-17 事故同类风险）。
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
//   - 跨包相对说明符：逃出本包目录即把别包的内部结构变成事实契约（§2.3）；
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
 * 收录条件：由宿主提供（本包 peerDependency）、本包声明的浏览器库，或经 `@fenix/ui-components`、
 * `@fenix/web-runtime`、`@fenix/model-management/web` 子路径传递进入的纯浏览器库。
 * workspace 包一律不收录——它们必须被递归进入，否则 `@fenix/x/server` 又能穿透（见「白名单不收录
 * workspace 包」）。未收录的库一旦被引入就会让本测试变红，从而强制做一次浏览器可用性评审。
 */
const BROWSER_SAFE_EXTERNAL: ReadonlyMap<string, string> = new Map([
  // 宿主提供：本包 package.json 声明的 peerDependency（单例框架库，宿主注入同一实例）
  ["react", "React 运行时（本包 peerDependency，宿主注入）"],
  ["react-dom", "React DOM 渲染器（本包 peerDependency；AgentFormDialog 用 createPortal）"],
  ["react-i18next", "React i18n 绑定（本包 peerDependency）"],
  ["i18next", "i18n 运行时（本包 peerDependency；当前图不直接引用，react-i18next 会用到）"],
  ["@tanstack/react-router", "浏览器路由（本包 peerDependency；站点页面跳转用）"],
  // 本包 dependencies 里的纯浏览器库
  ["ahooks", "React hooks 工具库（本包依赖，宿主亦直接依赖）"],
  ["lucide-react", "SVG 图标库（本包依赖，宿主亦直接依赖）"],
  ["sonner", "Toast 渲染（本包依赖，宿主亦直接依赖）"],
  ["qrcode", "二维码生成（本包依赖，站点分享面板用；纯浏览器实现）"],
  ["react-hook-form", "表单状态库（本包依赖；编辑器表单）"],
  ["@hookform/resolvers", "表单校验桥接（本包依赖；zodResolver）"],
  ["zod", "运行时校验（本包依赖 zod/v4，纯函数，无 node 依赖）"],
  // 经 @fenix/ui-components 子路径传递进入：无 node 依赖的浏览器库
  ["@radix-ui/react-alert-dialog", "无样式原语（ui/alert-dialog 传递依赖）"],
  ["@radix-ui/react-checkbox", "无样式原语（ui/checkbox 传递依赖）"],
  ["@radix-ui/react-collapsible", "无样式原语（ui/collapsible 传递依赖）"],
  ["@radix-ui/react-dialog", "无样式原语（ui/dialog、config/ConfirmDialog 传递依赖）"],
  ["@radix-ui/react-dropdown-menu", "无样式原语（ui/dropdown-menu 传递依赖，站点目录操作菜单）"],
  ["@radix-ui/react-label", "无样式原语（ui/label 传递依赖）"],
  ["@radix-ui/react-popover", "无样式原语（ui/popover 传递依赖）"],
  ["@radix-ui/react-scroll-area", "无样式原语（ui/scroll-area 传递依赖）"],
  ["@radix-ui/react-select", "无样式原语（ui/select 传递依赖）"],
  ["@radix-ui/react-separator", "无样式原语（ui/* 传递依赖）"],
  ["@radix-ui/react-slider", "无样式原语（ui/slider 传递依赖）"],
  ["@radix-ui/react-slot", "无样式原语（ui/button 传递依赖）"],
  ["@radix-ui/react-switch", "无样式原语（ui/switch 传递依赖）"],
  ["@radix-ui/react-tabs", "无样式原语（ui/tabs 传递依赖，编辑器分节页签）"],
  ["@radix-ui/react-tooltip", "无样式原语（ui/tooltip 传递依赖）"],
  ["radix-ui", "Radix 聚合包（ui/* 传递依赖），只重导出各原语"],
  ["class-variance-authority", "类名变体工具（ui/* 传递依赖），纯函数"],
  ["clsx", "类名拼接工具（lib/cn 传递依赖），纯函数"],
  ["tailwind-merge", "Tailwind 类名去重（lib/cn 传递依赖），纯函数"],
  ["cmdk", "命令面板（ui/command 传递依赖），浏览器安全"],
  ["dompurify", "HTML 消毒（ui-components 渲染层传递依赖），纯浏览器实现"],
  ["react-markdown", "Markdown 渲染（ui-components 渲染层传递依赖）"],
  ["rehype-sanitize", "Markdown 渲染前的 hast 清洗（knowledge 资源预览传递依赖），纯函数"],
  ["remark-gfm", "GitHub 风格 Markdown 插件（同上）"],
  ["streamdown", "流式 Markdown 渲染（ui-components chat 层传递依赖）"],
  ["mammoth", "docx 转 HTML（ui-components 文件预览传递依赖），纯浏览器实现"],
  ["recharts", "图表渲染（ui-components ui/chart 与 model-management 用量页传递依赖），纯浏览器实现"],
  ["xlsx", "表格解析（ui-components 文件预览传递依赖），纯浏览器实现"],
  ["cytoscape", "图可视化（ui-components 图谱面板传递依赖），纯浏览器实现"],
  ["cytoscape-fcose", "cytoscape 布局插件（同上）"],
  ["@antv/g6", "图可视化（ui-components 图谱面板传递依赖），纯浏览器实现"],
  ["@chenglou/pretext", "排版测量库（ui-components 文本层传递依赖），纯浏览器实现"],
  [
    "react-file-icon",
    "文件类型图标（ui-components components/file-icon-helper 传递依赖，经本包编辑器消费的 knowledge 资源列表引入）：" +
      "纯浏览器 SVG 组件，运行时依赖只有 react / prop-types / colord（后者提供颜色解析），无 node 专有能力",
  ],
  // 经 @fenix/model-management/web 子路径传递进入（编辑器模型选择器的品牌图标）
  // `@lobehub/icons` 的 dependencies 里还有 `antd-style`，后者在 import 期就求值
  // `window.matchMedia`：浏览器构建无影响（window 齐备），但无 DOM 的 `bun test` 进程只要被宿主
  // preload 垫上「有 window、无 matchMedia」的垫片就会崩在这里——消费方用例的阻断原因按这条记。
  ["@lobehub/icons", "模型品牌图标（ModelIcon 传递依赖；运行时依赖 antd-style，浏览器可用）"],
]);

/**
 * 全图宿主别名红线：`@/...` 说明符在整张值导入图里零容忍。
 *
 * 历史（2026-09-20 实测）：本包 web 自身一直零别名，但本包经 `@fenix/identity/web`（`useOrg`）与
 * `@fenix/model-management/web`（`modelApi` / provider 授权助手）合法消费的两个兄弟入口当时合计仍有
 * 58 处 `@/src`、`@/components`；本包改不动也不该替它们掩盖，于是把债务**钉到具体目录**
 * （`UPSTREAM_ALIAS_DEBT_DIRS`）。§1.6 T4 把身份包的别名归零（model-management 此前已归零）后，
 * 这份白名单失去全部成员，原地删除并升级为严格断言：任何包往本包图里渗别名都直接失败。
 */
const ALIAS_SPECIFIER = /^@\//;

/**
 * 跨包 web 引用只允许「包根 /web」这一个深度，唯一例外是这里登记的说明符。
 *
 * 例外项由 §6.5 的分支融合裁定点名保留：`@fenix/agent-runtime/web/api/environments` 是 agent-runtime
 * 对外发布的**窄契约出口**（站点页与 SiteFrame 取宿主同一份 environment 类型与请求），不是「顺手写深了」
 * 的路径；把它收敛成包根需要先改对方 manifest，超出本任务范围。允许项同时被断言「确实在用」，
 * 避免它退化成无人清理的死豁免。
 */
const ALLOWED_DEEP_WEB_SPECIFIER = "@fenix/agent-runtime/web/api/environments";

const graph = walkValueGraph(WEB_ENTRY);
/** 违规定位用仓库根相对路径：图跨包（ui-components / web-runtime / identity / 兄弟资源包），包内相对路径会产生 `../../` 噪音。 */
const describeRef = (ref: { from: string; specifier: string }): string => `${repoPath(ref.from)} → ${ref.specifier}`;
const offendersOf = (references: ReadonlyArray<{ from: string; specifier: string }>): string[] =>
  references.map(describeRef);
/** 包内到达文件（WEB_ROOT 相对）。 */
const reachedWebFiles = new Set(
  graph.files.filter((file) => file.startsWith(`${WEB_ROOT}${sep}`)).map((file) => relative(WEB_ROOT, file)),
);
/**
 * 经 exports 递归进入的包外文件（仓库根相对）。
 *
 * 用「图里的包外文件」而不是「scope 为 cross-package 的引用」：上游包内部继续用相对路径往下走
 * （如 `identity/web/index.ts` → `./contexts/OrgContext`），那一段的 scope 是 internal，
 * 只统计 cross-package 会低估到达面，甚至漏掉组织上下文这类真正决定运行时行为的文件。
 */
const reachedPackageFiles = new Set(graph.files.filter((file) => !file.startsWith(`${WEB_ROOT}${sep}`)).map(repoPath));
const externals = graph.references.filter((ref) => ref.kind === "external");
/** 本包文件发射的引用：零别名、零 @server 这类硬条件只对本包源码成立。 */
const ownReferences = graph.references.filter((ref) => ref.from.startsWith(`${WEB_ROOT}${sep}`));

/**
 * 实测消费方符号清单（消费方文件 → 符号），`owner` 是 WEB_ROOT 相对路径。
 *
 * 用源码断言而不是求值断言：整条根入口在无 DOM 的 bun 进程里仍被上游宿主 i18n 的旧深链阻断
 * （见 README「已知项」），import 求值只会 0 断言执行；静态断言至少守住「符号从包根可达」这一半契约，
 * 上游清偿后消费方用例自身即可恢复运行。
 */
const CONSUMER_SYMBOLS: ReadonlyArray<{ symbol: string; owner: string }> = [
  // model-management 的编辑器纯逻辑用例（`web/src/__tests__/agent-editor-model.test.ts`，归宿为本包）
  ...[
    "agentDetailToEditorValues",
    "agentEditorSchema",
    "buildAgentEditorPayload",
    "createAgentEditorDefaults",
    "filterAgentEditorOptions",
    "filterValidKnowledgeIds",
    "mapModelOptions",
    "mergeSelectedOptions",
  ].map((symbol) => ({ symbol, owner: "pages/agent-panel/agent-editor/agent-editor-model.ts" })),
  // task / prod-view 与宿主侧栏取 agentApi；宿主导航取 sidebarConfigApi
  { symbol: "agentApi", owner: "api/agents.ts" },
  { symbol: "sidebarConfigApi", owner: "src/api/sidebar-config.ts" },
  // 宿主 route adapter 取三个 agent-panel 页面（§1.6 T11e 归位，原先经 vite / tsconfig 桥接别名）；
  // 首页与创建流程共用的 `resolveCreatedAgentChatTarget` 不在本表——宿主壳经窄子路径
  // `@fenix/agent-config/web/lib/agent-create-navigation` 消费它（同 `web/lib/agent-node` 的先例），
  // 不构成「从包根取用」的契约；它仍随首页进入下面自检的表内（浏览器安全由同一张图守护）。
  { symbol: "AgentDashboardPage", owner: "pages/agent-panel/pages/AgentDashboardPage.tsx" },
  { symbol: "AgentHomePage", owner: "pages/agent-panel/pages/AgentHomePage.tsx" },
  { symbol: "AgentManagementPage", owner: "pages/agent-panel/pages/AgentManagementPage.tsx" },
];

describe("agent-config web 入口浏览器可达面", () => {
  // 遍历有效性自检：图若解析失败会退化为「只有入口文件」，后续断言全部假绿。
  test("遍历有效性自检：包内模块与跨包 exports 目标都在到达集合中", () => {
    for (const expected of [
      "index.ts",
      "i18n/index.ts",
      "i18n/namespace.ts",
      "api/agents.ts",
      "api/sites.ts",
      "lib/agent-site-url.ts",
      "src/api/sidebar-config.ts",
      "components/agent-panel/SiteFrame.tsx",
      "pages/agent-panel/agent-editor/AgentFormDialog.tsx",
      "pages/agent-panel/pages/agent-sites-catalog.tsx",
      "pages/agent-panel/pages/AgentHomePage.tsx",
      "lib/agent-create-navigation.ts",
    ]) {
      expect(reachedWebFiles).toContain(expected);
    }
    // §1.6 T11d 起 `pages/agent-panel/AgentSidebarConfig.tsx` 退场（宿主同源副本与包内死副本同时删除，
    // 侧栏导航改由 WebShell 消费各包的 `web/contribution.ts`），基线随之 24 → 23；T11e 又把三个
    // agent-panel 页面与创建导航助手归位进来（字典是 JSON，不在遍历面内；三个页面 + 助手 = +4）。
    expect(reachedWebFiles.size).toBeGreaterThanOrEqual(27);

    // 跨包递归的有效性：钉住每条上游一条稳定路径（ui-components 的按钮/弹窗、web-runtime 的
    // request / namespace / org-session 契约、model-management 的编辑器依赖、兄弟资源包的
    // API client）。少了这一段，「@fenix/* 被当成外部依赖放过」会以「包内断言全绿」的形式漏网。
    for (const expected of [
      "packages/ui-components/web/ui/button.tsx",
      "packages/ui-components/web/config/FormDialog.tsx",
      "packages/web-runtime/web/api/request.ts",
      "packages/web-runtime/web/i18n/namespace.ts",
      "packages/web-runtime/web/contexts/org-session.tsx",
      "packages/resources/model-management/web/index.ts",
      "packages/resources/knowledge/web/index.ts",
      "packages/resources/sandbox/web/index.ts",
      "packages/agent-runtime/web/api/environments.ts",
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
  // 两个上游（identity / model-management）均已归零，因此本包自己的源码与整张图都要求零别名。
  test("本包与全图零宿主别名", () => {
    const ownOffenders = ownReferences.filter((ref) => ALIAS_SPECIFIER.test(ref.specifier));
    expect(offendersOf(ownOffenders)).toEqual([]);

    const graphOffenders = graph.references.filter((ref) => ALIAS_SPECIFIER.test(ref.specifier));
    expect(graphOffenders.map(describeRef)).toEqual([]);
  });

  // 跨包必须走 exports 出口：@fenix/*/src 之类的深路径会把别的包的内部实现拖进浏览器图。
  test("跨包引用不深入 @fenix/*/src 内部路径", () => {
    const offenders = graph.references.filter((ref) => /^@fenix\/[^/]+\/src(\/|$)/.test(ref.specifier));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 兄弟包只允许经「对方包根 / `./web` 出口」进入：深层子路径（如
  // `@fenix/resource-machine/web/api/registry`）会把别人的内部目录变成事实契约。
  test("兄弟包只经包根 web 出口进入（深路径仅 §6.5 登记的例外）", () => {
    const offenders = ownReferences.flatMap((ref) => {
      if (ref.specifier === ALLOWED_DEEP_WEB_SPECIFIER) return [];
      const match = /^(@fenix\/[^/]+)\/web\/.+/.exec(ref.specifier);
      return match ? [`${describeRef(ref)}：只允许 ${match[1]}/web`] : [];
    });
    expect(offenders).toEqual([]);
    // 例外项必须真的在用：全部收敛到包根后这条豁免应当连着被删掉，而不是留着无人记得。
    expect(ownReferences.some((ref) => ref.specifier === ALLOWED_DEEP_WEB_SPECIFIER)).toBe(true);
  });

  // 跨包相对说明符会随别包的目录调整而静默断裂（本包曾有一处指向 knowledge 的 CSS 相对导入），
  // 且让本包无法脱离仓库布局独立构建；CSS 与组件都应由本包自持或经对方 exports 引入。
  test("相对说明符不逃出本包目录", () => {
    const offenders = ownReferences.filter(
      (ref) => ref.specifier.startsWith(".") && ref.kind === "file" && !ref.file.startsWith(`${WEB_ROOT}${sep}`),
    );
    expect(offenders.map(describeRef)).toEqual([]);
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
    // 宿主别名不在这里评审：它不是「第三方库」而是上游未清偿的硬性违规项，按目录登记后由
    // 「本包零宿主别名」那条断言负责。两类违规混在一条断言里会让三十行别名噪音淹没真正的
    // 「新引入了哪个人家的库」。
    const offenders = externals.filter(
      (ref) => !ALIAS_SPECIFIER.test(ref.specifier) && !BROWSER_SAFE_EXTERNAL.has(ref.root),
    );
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 浏览器入口的实现文件里不得 import '@fenix/agent-config/server' 之类子路径（自我回环）。
  // 断言扫全部引用而不是只扫外部依赖：递归进入后自我引用会被解析掉，只看 externals 就漏了。
  test("web 子图不导入本包的 server / module 出口", () => {
    const offenders = graph.references.filter((ref) => ref.specifier.startsWith(`${PKG_NAME}/`));
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
  // 同批把宿主 i18n 注册用的 ./web/i18n 子路径钉住（宿主改指本模块的前提）。
  test("package.json 的 ./web 指向 web/index.ts，./web/i18n 指向 web/i18n/index.ts", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };
    // 纯字符串目标（与 sandbox 黄金样本及其余资源包同形）：条件对象形式只在 types 与 default 指向
    // 不同文件时才有意义，同文件写成对象会让「出口形状」在各包之间分叉。
    expect(pkg.exports?.["./web"]).toBe("./web/index.ts");
    expect(pkg.exports?.["./web/i18n"]).toBe("./web/i18n/index.ts");
  });

  // i18n 资源必须由入口转出（宿主统一注册）；宿主删除寄居字典的前提是这里已提供。
  // `dashboard` 随概览页在 T11e 归位，与该页的命名空间常量一起断言，防止「页面搬了、字典没搬」。
  test("入口导出 agents / dashboard / agentHome 命名空间与 en/zh 资源", () => {
    const source = stripComments(readFileSync(WEB_ENTRY, "utf8"));
    for (const symbol of [
      "AGENT_HOME_NS",
      "agentHomeResources",
      "AGENTS_NS",
      "agentResources",
      "DASHBOARD_NS",
      "dashboardResources",
    ]) {
      expect(source).toContain(symbol);
    }
    const i18nSource = stripComments(readFileSync(join(WEB_ROOT, "i18n", "index.ts"), "utf8"));
    expect(i18nSource).toContain("AGENT_HOME_NS");
    expect(i18nSource).toContain("AGENTS_NS");
    expect(i18nSource).toContain("DASHBOARD_NS");
  });

  // 独立上下文回归点：组织/会话上下文必须取自宿主挂载的同一份 context（§6.5 裁定），且本包不得依赖
  // 平台实现（§2.3 `special-dependency`）；§1.6 T7 把落点定为 `@fenix/web-runtime` 的 org/session 契约，
  // 实现方仍是身份包的 `OrgProvider`。包内另建 context 会让取值永远拿到默认值——用源码断言钉住，
  // 防止后续「搬运」回来。
  test("组织上下文取自 @fenix/web-runtime/contexts/org-session，包内不另建 context", () => {
    const source = stripComments(
      readFileSync(join(WEB_ROOT, "pages/agent-panel/agent-editor/use-agent-editor.ts"), "utf8"),
    );
    expect(source).toContain('from "@fenix/web-runtime/contexts/org-session"');
    expect(source).not.toContain("@fenix/identity");
    expect(source).not.toContain("OrgContext");
  });

  // 消费方只允许经包根取符号，因此包根的导出面必须覆盖实测消费清单——这是「迁移后消费方还能编译」
  // 的那一半契约。
  test("包根导出面覆盖实测消费方符号", () => {
    const entry = stripComments(readFileSync(WEB_ENTRY, "utf8"));
    const missing: string[] = [];
    for (const { symbol, owner } of CONSUMER_SYMBOLS) {
      const ownerPath = join(WEB_ROOT, owner);
      // 登记表漂移（模块改名/搬走）必须报成一条可读的失败，而不是 ENOENT 崩在断言之前。
      if (!existsSync(ownerPath)) {
        missing.push(`${symbol}（符号表登记的 owner 不存在：${owner}）`);
        continue;
      }
      const specifier = `./${owner.replace(/\.tsx?$/, "")}`;
      const reExported =
        entry.includes(`export * from "${specifier}"`) || new RegExp(`export\\s*\\{[^}]*\\b${symbol}\\b`).test(entry);
      const declared = new RegExp(
        `\\bexport\\s+(?:async\\s+)?(?:function|const|interface|type|class)\\s+${symbol}\\b`,
      ).test(stripComments(readFileSync(ownerPath, "utf8")));
      if (!reExported || !declared) missing.push(`${symbol}（${owner}）`);
    }
    expect(missing).toEqual([]);
  });
});
