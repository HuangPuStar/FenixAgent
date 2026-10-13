// web/__tests__/tickets-browser-surface.test.ts
// 守护 `@fenix/resource-tickets/web` 的浏览器可达面（2026-08-17 事故同类风险）。
//
// 遍历口径在 ./value-import-graph：静态走 `web/index.ts` 的**值导入图**而不是对源码做字符串匹配，
// 并且 `@fenix/<pkg>[/<subpath>]` 会**经对方 package.json 的 exports 解析到真实源文件后递归进入**。
// 这正是事故的形态——`@fenix/x/server` 这类子路径会把 node 内建与服务端实现拖进浏览器 bundle，
// 而「记一条外部依赖放过」的旧口径对它完全无感（CLAUDE.md YJS 不变量 11）。
//
// 本包的特殊性：工单包**同时持有服务端实现**（elysia 路由、drizzle 仓储、`node:crypto`），浏览器面
// 只有 `web/**`。因此这里的红线是「入口的值导入图一步都不许碰到 `src/server/**` 或 `./module`」——
// 生产里做到这件事靠的是入口只 export web 子图，而入口的 export 列表会随功能增删漂移，所以由本文件
// 钉住：文件头自检 + 负例注入（真的把 `./server` 出口塞进图，证明拦截能力还在）。
//
// 本文件只放**本包的策略与断言**，图里可能出现的违规形态各自有独立断言，便于定位：
//   - `node:*`：浏览器里是 Vite 外置桩，import 期即崩；
//   - `@server/*`：宿主服务端实现，浏览器构建根本不该看见；
//   - 宿主别名 `@/...`：包一旦依赖它就无法独立构建（§1.3 硬条件：包内 web 零宿主别名）；
//   - exports 未声明 / 目标缺失的跨包说明符，以及解析不到实现的相对说明符。
//
// **两类「可构建性」断言的范围（本包 + 共享基础设施包）**：宿主别名与「外部依赖在白名单内」
// 表达的是**文件所属包能否脱离 `apps/web` 的 vite/tsconfig 独立构建**，因此只对以下文件断言：
// 本包文件，以及共享基础设施包（`packages/ui-components`、`packages/web-runtime`）的文件——后者是本包
// web 面的公共底座（`POLICED_DIRECTORIES` 逐目录列出）。其余经 exports 递归进入的文件只做
// 「解析 / 穿透 / node 内建 / `@server`」断言：它们的内部卫生由各自包的 `web/__tests__/*-browser-surface`
// 守卫负责（守卫模板要求每个带 `web/` 的资源包都建一份），一个文件只有一个 owner。
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
 *
 * **清单是逐条评审当前真实图的产物**（2026-10-12 T03 详情页落地后实测：76 文件 / 314 引用，外部根恰 22 个），
 * 不是「见过的库先记上」的宽表：多登记的条目会让后来引入的同名依赖静默通过评审。
 *
 * T03 追加的四条（`cmdk`、`@radix-ui/react-popover`、`@radix-ui/react-checkbox`、`@radix-ui/react-alert-dialog`）
 * 同样出自真实图的评审，只是**评审对象是四个 `ui/*` 原语的入口文件**：用本目录的 `walkValueGraph` 逐个走
 * `packages/ui-components/web/ui/{command,popover,checkbox,alert-dialog}.tsx`，新出现的外部根恰好就是这四个
 * （其余根已在表内）。评论编辑器、指派选择器、标签多选与关闭确认落进本包页面后，这四条即进入本包图；
 * 不预登记的唯一后果是守卫在界面落地的同一刻变红，而那一步没有可做的评审了。
 */
const BROWSER_SAFE_EXTERNAL: ReadonlyMap<string, string> = new Map([
  // 宿主提供：本包 package.json 声明的 peerDependency
  ["react", "React 运行时（本包 peerDependency，宿主注入）"],
  ["react-i18next", "React i18n 绑定（本包 peerDependency；页面经它取本包字典）"],
  ["@tanstack/react-router", "路由运行时（本包 peerDependency；列表行 `<Link>` 与详情页返回链接）"],
  // 本包 dependencies：可独立打进浏览器 bundle 的普通库
  ["ahooks", "React hooks 工具库（本包 dependencies；useRequest 取数）"],
  ["lucide-react", "SVG 图标库（本包 dependencies 直接使用）"],
  ["react-hook-form", "表单状态库（本包 dependencies；创建弹窗的字段注册）"],
  ["sonner", "Toast 渲染（本包 dependencies 直接使用），浏览器安全"],
  ["zod", "运行期 schema 校验（本包 dependencies；创建表单校验，图内说明符是 `zod/v4`）"],
  // 经 @fenix/ui-components 子路径传递进入：无 node 依赖的浏览器库
  ["@hookform/resolvers", "表单校验适配器（config/FormDialog 的 zodResolver 传递依赖），纯函数"],
  ["@radix-ui/react-alert-dialog", "无样式原语（ui/alert-dialog 传递依赖；关闭工单确认弹窗），纯浏览器"],
  ["@radix-ui/react-checkbox", "无样式原语（ui/checkbox 传递依赖；标签多选行），纯浏览器"],
  ["@radix-ui/react-dialog", "无样式原语（ui/dialog 与 config/FormDialog 传递依赖），纯浏览器"],
  ["@radix-ui/react-popover", "无样式原语（ui/popover 传递依赖；负责人选择器），纯浏览器"],
  ["@radix-ui/react-select", "无样式原语（ui/select 传递依赖），纯浏览器"],
  ["@radix-ui/react-separator", "无样式原语（ui/separator 传递依赖），纯浏览器"],
  ["@radix-ui/react-slot", "无样式原语（ui/button、ui/badge 传递依赖），纯浏览器"],
  ["@radix-ui/react-tooltip", "无样式原语（ui/tooltip 传递依赖），纯浏览器"],
  ["class-variance-authority", "类名变体工具（ui/* 传递依赖），纯函数"],
  ["clsx", "类名拼接工具（lib/cn 传递依赖），纯函数"],
  ["cmdk", "无样式命令面板（ui/command 传递依赖；成员搜索列表），纯浏览器"],
  ["tailwind-merge", "Tailwind 类名去重（lib/cn 传递依赖），纯函数"],
  ["streamdown", '流式 Markdown 渲染（chat/primitives/message 传递依赖；详情正文 mode="static" 走它），浏览器安全'],
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

/** 兄弟资源包：目录用于「断言范围」，包名用于「跨包只经包根 web 出口」的说明符检查。 */
const SIBLING_RESOURCES = [...loadWorkspacePackages().values()]
  .filter((pkg) => pkg.directory.startsWith("packages/resources/") && pkg.name !== PKG_NAME)
  .map((pkg) => ({ directory: pkg.directory, name: pkg.name }));
/**
 * 两类「可构建性」断言的断言范围（文件头已说明理由）：本包 + 共享基础设施包。
 *
 * 用显式目录白名单而不是「排除兄弟资源包」的补集：补集会随图上出现的新包自动扩大范围，
 * 让本包守卫因别人的迁移进度变红。
 */
const POLICED_DIRECTORIES = [repoPath(PKG_ROOT), "packages/ui-components", "packages/web-runtime"];
/** 该说明符发出方是否在断言范围内。 */
const policed = (file: string): boolean => {
  const path = repoPath(file);
  return POLICED_DIRECTORIES.some((directory) => path === directory || path.startsWith(`${directory}/`));
};

describe("tickets web 入口浏览器可达面", () => {
  // 遍历有效性自检：图若解析失败会退化为「只有入口文件」，后续断言全部假绿。
  test("遍历有效性自检：包内模块与跨包 exports 目标都在到达集合中", () => {
    for (const expected of [
      "index.ts",
      "api/ticket-attachments.ts",
      "api/ticket-comments.ts",
      "api/ticket-operations.ts",
      "api/ticket-projects.ts",
      "api/tickets.ts",
      "i18n/index.ts",
      "i18n/namespace.ts",
      "hooks/use-ticket-attachments.ts",
      "hooks/use-ticket-comments.ts",
      "hooks/use-ticket-detail.ts",
      "hooks/use-ticket-labels.ts",
      "hooks/use-ticket-list.ts",
      "hooks/use-ticket-members.ts",
      "lib/ticket-attachment-limits.ts",
      "lib/ticket-clipboard-images.ts",
      "lib/ticket-errors.ts",
      "lib/ticket-permissions.ts",
      "lib/ticket-write-failure.ts",
      "lib/ticket-write-outcome.ts",
      "pages/agent-panel/pages/AgentTicketsPage.tsx",
      "pages/agent-panel/pages/AgentTicketDetailPage.tsx",
      "pages/agent-panel/components/field-error.tsx",
      "pages/agent-panel/components/ticket-assignee-picker.tsx",
      "pages/agent-panel/components/ticket-attachment-preview.tsx",
      "pages/agent-panel/components/ticket-attachment-section.tsx",
      "pages/agent-panel/components/ticket-comment-composer.tsx",
      "pages/agent-panel/components/ticket-comment-item.tsx",
      "pages/agent-panel/components/ticket-comment-section.tsx",
      "pages/agent-panel/components/ticket-conflict-notice.tsx",
      "pages/agent-panel/components/ticket-create-dialog.tsx",
      "pages/agent-panel/components/ticket-detail-meta.tsx",
      "pages/agent-panel/components/ticket-fields-dialog.tsx",
      "pages/agent-panel/components/ticket-filter-bar.tsx",
      "pages/agent-panel/components/ticket-format.ts",
      "pages/agent-panel/components/ticket-labels-editor.tsx",
      "pages/agent-panel/components/ticket-list-table.tsx",
      "pages/agent-panel/components/ticket-state-badge.tsx",
      "pages/agent-panel/components/ticket-write-banner.tsx",
    ]) {
      expect(reachedWebFiles).toContain(expected);
    }
    expect(reachedWebFiles.size).toBeGreaterThanOrEqual(33);

    // 跨包递归的有效性：钉住本包 web 面的公共底座（ui-components 的按钮与 Markdown 链路、
    // web-runtime 的 request/NS）。少了这一段，「@fenix/* 被当成外部依赖放过」会以「包内断言全绿」的形状漏网。
    for (const expected of [
      "packages/ui-components/web/ui/button.tsx",
      "packages/ui-components/web/chat/primitives/message.tsx",
      "packages/web-runtime/web/api/request.ts",
      "packages/web-runtime/web/i18n/namespace.ts",
    ]) {
      expect(reachedPackageFiles).toContain(expected);
    }
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
  // 本包同时持有服务端实现（`node:crypto` 在服务层），这条断言因而同时是「入口没有转出 server 子图」的证据。
  test("值导入图不触及 node 内建", () => {
    const offenders = graph.references.filter((ref) => ref.specifier.startsWith("node:"));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // @server/* 是宿主服务端实现，包内 web 只能经 API + ./server 出口协作。
  test("值导入图不触及 @server 宿主服务端路径", () => {
    const offenders = graph.references.filter((ref) => ref.specifier.startsWith("@server/"));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 宿主别名会让包离开 apps/web 的 tsconfig/vite 配置后无法解析，属于 §1.3 的硬性禁止项。
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

  // 浏览器入口的实现文件里不得 import '@fenix/resource-tickets/server' 之类子路径（自我回环）。
  // 断言扫全部引用而不是只扫外部依赖：递归进入后自我引用会被解析掉，只看 externals 就漏了。
  test("web 子图不导入本包的 server / module 出口", () => {
    const offenders = graph.references.filter((ref) => ref.specifier.startsWith(`${PKG_NAME}/`));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 负例（人为注入，不建 fixture 文件）：`<pkg>/server` 是本包真实存在的 exports 出口，其后是
  // elysia / drizzle / `node:crypto` / 本包仓储与表定义。两条断言缺一不可——只断言「有违规」会被
  // 「递归失效、说明符本身被当成外部依赖」满足；只断言「进到了服务端实现」则漏掉拦截能力。
  test("负例：注入真实的 ./server 出口时递归进入服务端实现并触发拦截", () => {
    const poisoned = walkValueGraph(WEB_ENTRY, [`${PKG_NAME}/server`]);
    expect(poisoned.files).toContain(join(PKG_ROOT, "src", "server.ts"));
    const serverDir = `${join(PKG_ROOT, "src", "server")}${sep}`;
    expect(poisoned.files.filter((file) => file.startsWith(serverDir)).length).toBeGreaterThan(0);
    // 「递归够深」由两条深度断言承担：走到协议层路由与仓储（后者经 `@fenix/resource-tickets/db`
    // 出口的自我引用到达本包表定义，解析路径与外部消费方同一条）。
    expect(poisoned.files).toContain(join(PKG_ROOT, "src", "server", "routes", "web", "tickets.ts"));
    expect(poisoned.files).toContain(join(PKG_ROOT, "db", "schema.ts"));
    // 本包服务端的 `node:crypto` 与 drizzle 依赖必须真的进图——否则上面两条「到达」可能只是声明解析的结果。
    const nodeBuiltins = poisoned.references.filter((ref) => ref.specifier.startsWith("node:"));
    expect(offendersOf(nodeBuiltins).length).toBeGreaterThan(0);
    // §1.7 B12 起宿主 `@server/*` 在包内归零：负例只做零容忍断言，不再用它证明递归有效。
    const hostServer = poisoned.references.filter((ref) => ref.specifier.startsWith("@server/"));
    expect(offendersOf(hostServer)).toEqual([]);
  });

  // ./web 出口的契约：package.json 必须指向 web/index.ts，否则宿主解析到别的文件时守卫失去意义。
  test("package.json 的 ./web 出口指向 web/index.ts", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      exports?: Record<string, string>;
    };
    expect(pkg.exports?.["./web"]).toBe("./web/index.ts");
  });

  // i18n 资源必须由入口转出（宿主统一注册）；宿主注册 `tickets` 命名空间的前提是这里已提供。
  test("入口导出 tickets 命名空间与 en/zh 资源", () => {
    const source = stripComments(readFileSync(WEB_ENTRY, "utf8"));
    expect(source).toContain("TICKETS_NS");
    expect(source).toContain("ticketsResources");
  });

  // 兄弟资源包只允许经「对方包根 / `./web` 出口」进入本包浏览器面：深层子路径
  // （如 `@fenix/resource-machine/web/api/registry`）会把别人的内部目录变成事实契约，
  // 对方重构内部结构时本包构建即断。
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
