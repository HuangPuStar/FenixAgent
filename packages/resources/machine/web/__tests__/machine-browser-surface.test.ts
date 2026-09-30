// web/__tests__/machine-browser-surface.test.ts
// 守护 `@fenix/resource-machine/web` 的浏览器可达面（2026-08-17 事故同类风险）。
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
//   - 相对路径越界到宿主 `apps/web`：同样是主城内部引用，且解析成功时不会报「解析不到」，必须单独钉住；
//   - exports 未声明 / 目标缺失的跨包说明符，以及解析不到实现的相对说明符。
//
// 测试文件与 `node:*` 的豁免：递归只沿 exports 出口走，而任何包的 exports 都不指向 `__tests__`，
// 所以 `bun:test` 与测试夹具不会进入图，不需要豁免；本文件自身的 `node:fs` 是守卫的运行时，
// 不是被守卫的浏览器面。另注：本测试只读文件，不 import 被测模块——顶层副作用（如懒加载宿主单例）
// 不该影响断言。

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import {
  loadWorkspacePackages,
  PROJECT_ROOT,
  repoPath,
  stripComments,
  WEB_ROOT,
  walkValueGraph,
} from "./value-import-graph";

const WEB_ENTRY = join(WEB_ROOT, "index.ts");
const PKG_ROOT = resolve(WEB_ROOT, "..");
/** 本包名：自我回环断言与负例注入都从 package.json 取，避免与 manifest 漂移。 */
const PKG_NAME = (JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as { name: string }).name;

/**
 * 浏览器安全外部依赖白名单：键是包根（`@scope/name` 或裸名），值说明它为什么可以停在图外。
 *
 * 收录条件：由宿主提供（本包 peerDependency），或经 `@fenix/ui-components` / `@fenix/web-runtime`
 * 子路径传递进入的纯浏览器库。workspace 包一律不收录——它们必须被递归进入，否则 `@fenix/x/server`
 * 又能穿透（见「白名单不收录 workspace 包」）。
 *
 * 2026-09-24（台账 D2）文件域客户端与上传 hook 迁入后，图里首次出现裸包说明符：两条都是宿主注入的
 * peerDependency（React 运行时与 i18n 绑定），不含 node 内建。**空表状态到此结束**——新增外部依赖
 * 仍会立即变红，强制做一次浏览器可用性评审后逐条录入。
 *
 * 2026-09-24（D2 第二批）文件树容器 / tab 栏 / 文件工作区迁入，图里随之出现 `@fenix/ui-components`
 * 子路径组件的传递依赖（该包 `web/` 不重新导出这些库，只能停在图外并逐条评审）。收录判据仍是
 * 「无 node 依赖、可在浏览器执行」：无样式原语（radix）、类名工具（clsx / tailwind-merge /
 * class-variance-authority）、图标与浏览期渲染库（lucide-react / react-file-icon / react-arborist /
 * react-resizable-panels / @open-file-viewer）都已在本包消费方 `@fenix/ui-components` 的生产路径里
 * 被浏览器加载（面板、文件树与预览 tab 本就在同一 chunk），此处只是把既成事实登记下来。
 *
 * 2026-09-25 批量评审（一条裁定，四个包共用）：`machine/web/index.ts` 把文件工作区（`FileTreeTab` /
 * `artifacts-files-workspace`）随包根出口转出后，「文件域归位」的这同一批 `@fenix/ui-components` 传递
 * 依赖同时出现在 `@fenix/resource-task` / `@fenix/resource-prod-view` / `@fenix/agent-config` 的浏览器图里
 * （三家的逐条登记见各自守卫的 2026-09-25 段落，措辞统一指向本条）。
 * **收录范围**：本表「经 `@fenix/ui-components` 子路径传递进入」一节中由文件域子树引入的条目——
 * `react-arborist`、`react-resizable-panels`、`@open-file-viewer/core`、`@open-file-viewer/react`，
 * 以及消费方自身声明的 React 运行时。**结论**：逐条核对为浏览器安全库——React 运行时 / Radix 无样式
 * 原语 / 纯函数类名工具 / 文件图标 / 虚拟化树 / 分栏 / 文件预览内核，均不含 node 内建或服务端实现。
 * **依据**：这批放行只作用于「裸包说明符是否可以停在图外」这一条断言，`node:*` 与 `@server/*` 的断言
 * 不变；且本文件的负例注入用例仍在跑（注入真实 `./server` 出口后必须递归进入服务端实现并命中 node
 * 内建），穿透检测能力未被放行削弱。
 */
const BROWSER_SAFE_EXTERNAL: ReadonlyMap<string, string> = new Map([
  ["react", "React 运行时（本包 peerDependency，宿主注入）"],
  ["react-dom", "React DOM 运行时（本包 peerDependency；ui-components 的菜单/门户组件传递依赖）"],
  ["react-i18next", "React i18n 绑定（本包 peerDependency；文件上传 hook 与文件树容器取本包命名空间文案）"],
  // 本包直接依赖的普通浏览器库（可独立打进 bundle，见 package.json 的 dependencies）
  ["ahooks", "React hooks 工具库（文件树与 Files 编排 hook 的请求状态），纯浏览器"],
  ["lucide-react", "SVG 图标库（本包 tab 栏与 ui-components 组件共用），无 node 依赖"],
  ["sonner", "Toast 渲染（文件操作的失败反馈），宿主亦直接依赖"],
  // 经 @fenix/ui-components 子路径传递进入的浏览器库
  ["@radix-ui/react-slot", "无样式原语（ui/button 传递依赖）"],
  ["@radix-ui/react-dialog", "无样式原语（file-tree-input-dialog / ui/dialog 传递依赖）"],
  ["@radix-ui/react-alert-dialog", "无样式原语（ui/alert-dialog 传递依赖）"],
  ["@radix-ui/react-popover", "无样式原语（ui/popover，文件 tab 的折叠与变更列表）"],
  ["class-variance-authority", "类名变体工具（ui/* 传递依赖），纯函数"],
  ["clsx", "类名拼接工具（ui-components/lib/cn 传递依赖），纯函数"],
  ["tailwind-merge", "Tailwind 类名去重（ui-components/lib/cn 传递依赖），纯函数"],
  ["react-file-icon", "文件类型图标（components/file-icon-helper，tab 与列表都用它）"],
  ["react-arborist", "虚拟化树（components/file-tree-arborist，文件树的渲染内核）"],
  ["react-resizable-panels", "可拖拽分栏（ui/resizable，文件树 / 预览分栏；本包同时以类型导入其句柄类型）"],
  ["@open-file-viewer/core", "预览内核（components/preview/* 的渲染器；随样式表一起被浏览器加载）"],
  ["@open-file-viewer/react", "预览 React 绑定（components/preview/FileViewerPreview 的生产路径）"],
]);

const graph = walkValueGraph(WEB_ENTRY);
/** 违规定位用仓库根相对路径：图现在跨包（web-runtime），包内相对路径会产生 `../../` 噪音。 */
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

describe("machine web 入口浏览器可达面", () => {
  // 遍历有效性自检：图若解析失败会退化为「只有入口文件」，后续断言全部假绿。
  test("遍历有效性自检：包内模块与跨包 exports 目标都在到达集合中", () => {
    for (const expected of [
      "index.ts",
      "api/registry.ts",
      "api/fs.ts",
      "api/file-events.ts",
      "hooks/use-file-uploads.ts",
      "hooks/use-file-tree-events.ts",
      "hooks/use-artifacts-files.ts",
      "hooks/use-drag-counter.ts",
      "components/FileTreeTab.tsx",
      "components/FileTabsBar.tsx",
      "components/artifacts-files-workspace.tsx",
      "lib/random-uuid.ts",
      "lib/normalize-to-user-path.ts",
    ]) {
      expect(reachedWebFiles).toContain(expected);
    }
    expect(reachedWebFiles.size).toBeGreaterThanOrEqual(13);

    // 跨包递归的有效性：只钉一条稳定路径——web-runtime 的 request 客户端。
    // 少了这一段，「@fenix/* 被当成外部依赖放过」会以「包内断言全绿」的形式漏网。
    for (const expected of ["packages/web-runtime/web/api/request.ts"]) {
      expect(reachedPackageFiles).toContain(expected);
    }
    expect(reachedPackageFiles.size).toBeGreaterThanOrEqual(1);
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

  // 相对路径越界不是「解析不到」而是「解析成功」：指向宿主前端源码的六级相对路径在图里是合法的
  // internal 文件节点，只有按路径前缀断言才能拦住——文件域实现整体迁入本包时最容易带进来的就是它。
  // （此处不复述该路径字面量：本文件也在 §1 静态条件 3 的扫描范围内，写出来会把守护扫描变成噪声。）
  test("值导入图不进入宿主 apps/web 内部", () => {
    const hostWebRoot = `${join(PROJECT_ROOT, "apps", "web")}${sep}`;
    const offenders = graph.files.filter((file) => file.startsWith(hostWebRoot));
    expect(offenders.map(repoPath)).toEqual([]);
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

  // 浏览器入口的实现文件里不得 import '@fenix/resource-machine/server' 之类子路径（自我回环）。
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

  // 入口导出面：跨包消费方（agent-config 编辑器直连；宿主 route adapter 为 identity 组织机器页注入）
  // 取用的是 registryApi 与它的类型；2026-09-24 起宿主文件域消费方取用的是 fs 客户端、上传 hook、
  // 事件通道，以及 D2 第二批迁入的文件工作区与 Files 编排 hook（宿主 `ArtifactsPanel` 经本入口装配）。
  // 导出面缩水会让消费方退回深层路径（那些路径不在 exports 里）。
  test("入口转出 registryApi、文件域客户端、上传 hook 与文件工作区", () => {
    const source = stripComments(readFileSync(WEB_ENTRY, "utf8"));
    expect(source).toContain('from "./api/registry"');
    expect(source).toContain('from "./api/fs"');
    expect(source).toContain('from "./api/file-events"');
    expect(source).toContain('from "./hooks/use-file-uploads"');
    expect(source).toContain('from "./hooks/use-artifacts-files"');
    expect(source).toContain('from "./components/artifacts-files-workspace"');
    // `use-drag-counter` 的两个调用点都在包内，按「没有第二个消费者就不导出」不转出。
    expect(source).not.toContain('from "./hooks/use-drag-counter"');
    expect(source).toMatch(/export\s+\*/);
    const registrySource = stripComments(readFileSync(join(WEB_ROOT, "api", "registry.ts"), "utf8"));
    for (const name of ["registryApi", "MachineRecord", "RegistryEvent", "MachineDetail"]) {
      expect(registrySource).toContain(name);
    }
    const fsSource = stripComments(readFileSync(join(WEB_ROOT, "api", "fs.ts"), "utf8"));
    for (const name of ["fsApi", "uploadFiles", "uploadChatFiles", "buildPreviewSourceUrl", "readPreviewSource"]) {
      expect(fsSource).toContain(name);
    }
    const fileEventsSource = stripComments(readFileSync(join(WEB_ROOT, "api", "file-events.ts"), "utf8"));
    for (const name of ["buildFileEventsUrl", "openFileEventsConnection", "FileEventsFrame"]) {
      expect(fileEventsSource).toContain(name);
    }
  });

  // i18n 归属（计划 §4：键的最终所在地 = 包的 owner）：2026-09-24（台账 D2）上传 hook 迁入，本包自此
  // 有自持文案键，字典与常量分两个模块（`i18n/namespace.ts` 只持常量、`i18n/index.ts` 持资源）。
  // 字典**不**经 `web/index.ts` 转出——宿主 i18n 引导在启动期求值，根入口会把整个 web 面拉进首屏；
  // 宿主按 §9.2 从 `exports["./web/i18n"]` 子路径登记。
  test("i18n 经 ./web/i18n 子路径公开，不经根入口转出", () => {
    expect(existsSync(join(WEB_ROOT, "i18n", "namespace.ts"))).toBe(true);
    expect(existsSync(join(WEB_ROOT, "i18n", "index.ts"))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      exports?: Record<string, string>;
    };
    expect(pkg.exports?.["./web/i18n"]).toBe("./web/i18n/index.ts");
    const source = stripComments(readFileSync(WEB_ENTRY, "utf8"));
    expect(source).not.toMatch(/(?:from|import\s*\()\s*["'][^"']*i18n/);
  });
});
