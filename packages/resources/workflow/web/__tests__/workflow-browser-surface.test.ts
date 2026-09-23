// web/__tests__/workflow-browser-surface.test.ts
// 守护 `@fenix/resource-workflow/web` 的浏览器可达面（2026-08-17 事故同类风险）。
//
// 遍历口径在 ./value-import-graph：静态走 `web/index.ts` 的**值导入图**而不是对源码做字符串匹配，
// 并且 `@fenix/<pkg>[/<subpath>]` 会**经对方 package.json 的 exports 解析到真实源文件后递归进入**。
// 这正是事故的形态——`@fenix/x/server` 这类子路径会把 node 内建与服务端实现拖进浏览器 bundle，
// 而「记一条外部依赖放过」的旧口径对它完全无感（CLAUDE.md YJS 不变量 11）。
// 递归的代价是放行必须显式：只有下面白名单里的**浏览器安全外部依赖**才允许停在图外。
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
 * 收录条件：由宿主提供（本包 peerDependency），或经 `@fenix/ui-components` 子路径传递进入的纯浏览器库。
 * workspace 包一律不收录——它们必须被递归进入，否则 `@fenix/x/server` 又能穿透（见「白名单不收录
 * workspace 包」）。未收录的库一旦被引入就会让本测试变红，从而强制做一次浏览器可用性评审。
 *
 * 这份清单与入口的实际可达面**逐项对应**（不多列）：新增一项必然意味着入口新引了一个库，多列一项则由
 * 「白名单不超列实际可达面」那条断言打回。
 *
 * 2026-09-22：运行面板的事件/输出页签由手写 button 改为 `ui/tabs`，带入 `@radix-ui/react-tabs`（+1）。
 * 现在的 21 条重新回到两类来源：本包/宿主自己的依赖，以及本包编辑器经 `@fenix/ui-components` 共享原语
 * 传递进入的库——即下面各组注释所示。
 */
const BROWSER_SAFE_EXTERNAL: ReadonlyMap<string, string> = new Map([
  // 宿主提供（本包 package.json 的 peerDependencies：单实例库必须与宿主同一份）
  ["react", "React 运行时（本包 peerDependency，宿主注入）"],
  ["react-i18next", "React i18n 绑定（本包 peerDependency）"],
  ["@tanstack/react-router", "路由运行时（本包 peerDependency；WorkflowVersions 用 Link 生成工作流编辑链接）"],
  // 本包依赖（可独立打包的浏览器库）
  ["lucide-react", "SVG 图标库（宿主亦直接依赖）"],
  ["sonner", "Toast 渲染（宿主亦直接依赖）"],
  ["ahooks", "React hooks 工具库（宿主亦直接依赖）"],
  ["dagre", "DAG 自动布局算法（纯计算，`layout.ts` 消费）"],
  ["js-yaml", "YAML 解析/序列化（纯计算，`yaml-utils.ts` 消费）"],
  // 经 @fenix/ui-components 子路径传递进入：本包编辑器用的共享原语（ui/button、ui/dialog、
  // config/ConfirmDialog 等）各自的依赖，均为无 node 依赖的浏览器库
  ["@radix-ui/react-slot", "无样式原语（ui/button 传递依赖），只依赖 react/DOM"],
  ["@radix-ui/react-dialog", "无样式原语（ui/dialog、config/ConfirmDialog 传递依赖）"],
  ["@radix-ui/react-alert-dialog", "无样式原语（ui/alert-dialog 传递依赖）"],
  ["@radix-ui/react-label", "无样式原语（ui/label 传递依赖）"],
  ["@radix-ui/react-tabs", "无样式原语（ui/tabs 传递依赖，运行面板的事件/输出页签）"],
  ["class-variance-authority", "类名变体工具（ui/* 传递依赖），纯函数"],
  ["clsx", "类名拼接工具（lib/cn 传递依赖），纯函数"],
  ["tailwind-merge", "Tailwind 类名去重（lib/cn 传递依赖），纯函数"],
  // 编辑器自身引入（本包 package.json 的 dependencies）
  ["@xyflow/react", "DAG 画布库（编辑器画布，`pages/workflow/{WorkflowEditor,nodes,edges}.tsx` 与三个 hook）"],
  // 编辑器可达面传递进入：同为 @fenix/ui-components 的原语依赖（ui/sheet、ui/popover、ui/select、
  // ui/checkbox），与上一组同源——2026-09-21 实测每条 external 的发出文件都落在
  // `packages/ui-components/web/**`，不经 agent-config。
  ["radix-ui", "Radix 聚合包（ui/sheet、ui/progress 传递依赖），无 node 依赖"],
  ["@radix-ui/react-popover", "无样式原语（ui/popover 传递依赖）"],
  ["@radix-ui/react-select", "无样式原语（ui/select 传递依赖）"],
  ["@radix-ui/react-checkbox", "无样式原语（ui/checkbox 传递依赖）"],
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

describe("workflow web 入口浏览器可达面", () => {
  // 遍历有效性自检：图若解析失败会退化为「只有入口文件」，后续断言全部假绿。
  test("遍历有效性自检：包内模块与跨包 exports 目标都在到达集合中", () => {
    for (const expected of [
      "index.ts",
      "i18n/index.ts",
      "i18n/namespace.ts",
      "api/workflow-defs.ts",
      "api/workflow-engine.ts",
      "api/workflow-sse.ts",
      "lib/use-workflow-events.ts",
      "pages/workflow/WorkflowBreadcrumb.tsx",
      "pages/workflow/WorkflowList.tsx",
      "pages/workflow/WorkflowRuns.tsx",
      "pages/workflow/WorkflowVersions.tsx",
      "pages/workflow/components/SkeletonRows.tsx",
      // 2026-09-22：版本行三处（版本页 / 编辑器版本面板 / 版本弹层）收敛出的共享件——它们只被
      // 上面这几个页面经相对路径引用，不在 `web/index.ts` 的导出面里，列在这里是为了让「共享件
      // 仍在浏览器图内」这件事在遍历失效时立刻变红，而不是靠别处的间接断言。
      "pages/workflow/components/VersionRow.tsx",
      "pages/workflow/components/VersionConfirmDialog.tsx",
      // 本批新增的两件包内共享件：运行记录页与编辑器运行面板的状态筛选行、三个面板的面板头
      // （编辑器经 `WorkflowEditor` 的 Sheet 与 `RunStatusPanel` 的侧栏消费，同样不在入口导出面里）。
      "pages/workflow/components/StatusFilterRow.tsx",
      "pages/workflow/components/PanelHeader.tsx",
      // 运行视图态的整组复位（`resetRunView`）：编辑器页面、运行 hook 与运行面板三处消费，
      // 同样只走包内相对路径，不在入口导出面里。
      "pages/workflow/run-view.ts",
      // 弹层头骨架（标题行）：文件菜单 / 版本指示器 / 元数据三个弹层消费。
      "pages/workflow/components/PopoverHeader.tsx",
      // 参数分组标题行（ParamsEditor 与 RunParamsDialog 消费）与三份编辑器的行内字段样式配方。
      "pages/workflow/components/ParamGroupHeader.tsx",
      "pages/workflow/components/entry-field-classes.ts",
    ]) {
      expect(reachedWebFiles).toContain(expected);
    }
    expect(reachedWebFiles.size).toBeGreaterThanOrEqual(18);

    // 跨包递归的有效性：只钉三条稳定路径——ui-components 的按钮、web-runtime 的 request 与上下文队列。
    // 少了这一段，「@fenix/* 被当成外部依赖放过」会以「包内断言全绿」的形式漏网。
    for (const expected of [
      "packages/ui-components/web/ui/button.tsx",
      "packages/web-runtime/web/api/request.ts",
      "packages/web-runtime/web/chat/context-queue.ts",
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

  // 白名单「不多列」：注释里声明清单与可达面逐项对应，这条把它变成被守护的不变量。收窄可达面（如
  // T12 的窄子路径出口）后必须同批删掉不再可达的条目，否则清单会重新变成「历史上引过什么」的堆积。
  test("白名单不超列实际可达面", () => {
    const reachedRoots = new Set(externals.map((ref) => ref.root));
    const extra = [...BROWSER_SAFE_EXTERNAL.keys()].filter((root) => !reachedRoots.has(root));
    expect(extra).toEqual([]);
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

  // 浏览器入口的实现文件里不得 import '@fenix/resource-workflow/server' 之类子路径（自我回环）。
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
  test("package.json 的 ./web 出口指向 web/index.ts", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      exports?: Record<string, string>;
    };
    expect(pkg.exports?.["./web"]).toBe("./web/index.ts");
  });

  // i18n 资源必须由入口转出（宿主统一注册）；本包命名空间自持是 §4 的交付物。
  test("入口导出 workflows 命名空间与 en/zh 资源", () => {
    const source = stripComments(readFileSync(WEB_ENTRY, "utf8"));
    expect(source).toContain("WORKFLOW_NS");
    expect(source).toContain("workflowResources");
  });

  // 编辑器纳入入口的**回归锚点**：宿主 route adapter 不再经别名穿透到 `web/pages/**`，入口必须转出
  // 编辑器，且它的整条值导入图确实被走了一遍（只断言导出行会被「导出但图没进」满足）。
  test("入口导出编辑器，且其值导入图在可达集合内", () => {
    const source = stripComments(readFileSync(WEB_ENTRY, "utf8"));
    expect(source).toContain("WorkflowEditor");
    expect(reachedWebFiles).toContain("pages/workflow/WorkflowEditor.tsx");
    // 编辑器经环境列表 API 构建普通 Agent 节点选项。
    expect(reachedPackageFiles).toContain("packages/agent-runtime/web/api/environments.ts");
  });
});
