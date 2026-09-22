// web/__tests__/knowledge-browser-surface.test.ts
// 守护 `@fenix/resource-knowledge/web` 的浏览器可达面（2026-08-17 事故同类风险）。
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
 * 收录条件：由宿主提供（本包 peerDependency）、本包直接声明的纯浏览器库，或经 `@fenix/ui-components` /
 * `@fenix/model-management` 子路径传递进入且不触达 node 的库。workspace 包一律不收录——它们必须被递归
 * 进入，否则 `@fenix/x/server` 又能穿透（见「白名单不收录 workspace 包」）。未收录的库一旦被引入就会
 * 让本测试变红，从而强制做一次浏览器可用性评审。
 */
const BROWSER_SAFE_EXTERNAL: ReadonlyMap<string, string> = new Map([
  // 宿主提供：本包 package.json 的 peerDependency
  ["react", "React 运行时（本包 peerDependency，宿主注入）"],
  ["react-i18next", "React i18n 绑定（本包 peerDependency）"],
  // 本包直接声明并直接引用的纯浏览器库（无 node 依赖）
  // g6 只在 KnowledgeGraphPanel 内**惰性** `import()`（导入期会经 @antv/g → html2canvas 求值
  // `window.document.createElement`，静态导入会让无 DOM 运行时加载即崩，见下面的「不静态导入」断言）
  ["@antv/g6", "知识图谱渲染（本包 dependencies，面板内惰性加载）"],
  ["@tanstack/react-router", "路由钩子 useNavigate/useSearch（宿主提供 router 上下文）"],
  ["ahooks", "useRequest 数据获取（本包 dependencies）"],
  ["dompurify", "切片 HTML 清洗（本包 dependencies），纯浏览器实现"],
  ["lucide-react", "SVG 图标库（本包 dependencies）"],
  ["mammoth", "docx 文本提取（本包 dependencies），纯 JS"],
  ["react-markdown", "Markdown 渲染（本包 dependencies）"],
  ["remark-gfm", "GFM 插件（本包 dependencies），纯函数"],
  ["sonner", "Toast 渲染（本包 dependencies）"],
  ["xlsx", "表格解析（本包 dependencies），纯 JS"],
  // 经 @fenix/ui-components / @fenix/web-runtime / @fenix/model-management 子路径传递进入的浏览器库
  ["@radix-ui/react-alert-dialog", "无样式原语（ui/alert-dialog 传递依赖）"],
  ["@radix-ui/react-checkbox", "无样式原语（ui/checkbox 传递依赖）"],
  ["@radix-ui/react-dialog", "无样式原语（ui/dialog、config/ConfirmDialog 传递依赖）"],
  ["@radix-ui/react-scroll-area", "无样式原语（ui/* 传递依赖）"],
  ["@radix-ui/react-select", "无样式原语（ui/select 传递依赖）"],
  ["@radix-ui/react-slider", "无样式原语（ui/slider 传递依赖）"],
  ["@radix-ui/react-slot", "无样式原语（ui/button 传递依赖）"],
  ["@radix-ui/react-switch", "无样式原语（ui/switch 传递依赖）"],
  ["@radix-ui/react-tabs", "无样式原语（ui/tabs 传递依赖）"],
  ["radix-ui", "无样式原语聚合包（ui/* 传递依赖）"],
  ["class-variance-authority", "类名变体工具（ui/* 传递依赖），纯函数"],
  ["clsx", "类名拼接工具（lib/cn 传递依赖），纯函数"],
  ["tailwind-merge", "Tailwind 类名去重（lib/cn 传递依赖），纯函数"],
  ["react-hook-form", "表单状态（ui-components/config 传递依赖），浏览器实现"],
  ["@hookform/resolvers", "react-hook-form 的 zod 适配（同上），纯函数"],
  ["@lobehub/icons", "模型品牌图标（model-management 的 ModelIcon 传递依赖），SVG 组件"],
  ["better-auth", "浏览器端会话客户端（identity/web 传递依赖）"],
  ["@better-auth/api-key", "better-auth 的 api-key 客户端插件（同上），浏览器实现"],
  ["@noble/ciphers", "better-auth 客户端的加密实现（同上），纯 JS"],
]);

const graph = walkValueGraph(WEB_ENTRY);
/** 违规定位用仓库根相对路径：图现在跨包（ui-components / web-runtime / identity / 兄弟资源包），包内相对路径会产生 `../../` 噪音。 */
const describeRef = (ref: { from: string; specifier: string }): string => `${repoPath(ref.from)} → ${ref.specifier}`;
const offendersOf = (references: ReadonlyArray<{ from: string; specifier: string }>): string[] =>
  references.map(describeRef);
/**
 * 只取**本包文件发出**的引用。
 *
 * 递归会进入兄弟包（ui-components / web-runtime / identity / model-management / observer / sandbox）
 * 的真实源码：那些包也在切宿主别名、也在补齐自己的白名单，它们的问题由各自包内的同款守卫负责——本包
 * 既改不了也不该替它们变红（下面的「本包 web 文件不残留宿主别名」早已用同一口径）。本包能担保的是
 * 「本包文件发出的引用」：不外泄宿主别名、不引入未评审的包外依赖、不反向引用自己的出口。
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

describe("knowledge web 入口浏览器可达面", () => {
  // 遍历有效性自检：图若解析失败会退化为「只有入口文件」，后续断言全部假绿。
  test("遍历有效性自检：包内模块与跨包 exports 目标都在到达集合中", () => {
    for (const expected of [
      "index.ts",
      "i18n/index.ts",
      "i18n/namespace.ts",
      "api/knowledge-bases.ts",
      "api/knowledge-models.ts",
      "types/knowledge.ts",
      "pages/agent-panel/KnowledgeGraphPanel.tsx",
      "pages/agent-panel/knowledge-graph-state.ts",
      "pages/agent-panel/pages/AgentKnowledgeBasesPage.tsx",
      "pages/agent-panel/pages/agent-knowledge-access-denied.tsx",
      "pages/agent-panel/pages/agent-knowledge-directory.tsx",
      "pages/agent-panel/pages/agent-knowledge-load-failure.tsx",
      "pages/agent-panel/pages/agent-knowledge-resources.tsx",
      "pages/agent-panel/pages/knowledge-status.ts",
      "pages/agent-panel/pages/knowledge-typography.ts",
      "components/knowledge/ResourcePreviewContent.tsx",
      "components/knowledge/ResourcePreviewDialog.tsx",
      "lib/poll-resources.ts",
      "src/pages/agent-panel/components/ChunkDetailSheet.tsx",
      "src/pages/agent-panel/components/EmbeddingModelManager.tsx",
      "src/pages/agent-panel/components/RetrievalTestPanel.tsx",
    ]) {
      expect(reachedWebFiles).toContain(expected);
    }
    // 21 = 原有 19 个模块 + 2026-09-22 前端去重抽出的两个模块（`knowledge-typography.ts` 的字段名
    // 排版常量、`lib/poll-resources.ts` 的资源轮询）：两者都被页面/检索面板以值导入引用，必须在图内。
    expect(reachedWebFiles.size).toBe(21);

    // 跨包递归的有效性：只钉稳定路径——本包实际消费的四个跨包入口。
    // 少了这一段，「@fenix/* 被当成外部依赖放过」会以「包内断言全绿」的形式漏网。
    for (const expected of [
      "packages/ui-components/web/ui/button.tsx",
      "packages/web-runtime/web/api/request.ts",
      "packages/web-runtime/web/i18n/namespace.ts",
      "packages/web-runtime/web/contexts/org-session.tsx",
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
  //
  // 断言只覆盖本包自己的文件：递归进入的兄弟包（identity / model-management）本轮也在切别名，
  // 它们的残留由各自的台账条目（owner 1.6）与包内守卫负责——本包既改不了也不该替它们变红。
  // 本包这一侧由下面的全量源码扫描兜住（含未被入口引用的文件）。
  test("本包 web 文件不残留宿主别名（@/src、@/components）", () => {
    const ownPrefix = `${WEB_ROOT}${sep}`;
    const offenders = graph.references.filter(
      (ref) => ref.from.startsWith(ownPrefix) && /^@\/(src|components)(\/|$)/.test(ref.specifier),
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
  //
  // 只评审**本包文件发出**的包外依赖：递归进入的兄弟包会带来它们自己的依赖（model-management 的
  // recharts、sandbox / observer 页面的 cmdk、ui-components 的 @radix-ui/react-* 等），那些由各自的
  // 守卫与依赖声明负责，列进本包白名单只会制造噪音——本包既评审不了兄弟包的实现，兄弟包每次新增一个
  // 库就会让本包变红。本包直连的外部依赖因此必须逐一出现在上面的白名单里：新增一个未评审的库即变红。
  //
  // 这里只评审**真实包名**：`node:*` 与宿主别名 `@/...` 各有独立断言（前者是事故本体，后者是包
  // 不能独立构建的原因），混在一起会让「别名残留」重复出现在两条失败里，反而看不清根因。
  test("本包直连的包外运行时依赖在白名单内", () => {
    const offenders = ownRefs(externals).filter(
      (ref) =>
        !ref.specifier.startsWith("node:") && !ref.specifier.startsWith("@/") && !BROWSER_SAFE_EXTERNAL.has(ref.root),
    );
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 浏览器入口的实现文件里不得 import '@fenix/resource-knowledge/server' 之类子路径（自我回环）。
  // 断言扫**本包文件**的全部引用而不是只扫外部依赖：递归进入后自我引用会被解析掉，只看 externals 就漏了。
  // 不能用包名过滤全局引用放行跨包回边——那条回边（model-management 的 `EmbeddingModelManager` 反向取本包）
  // 已随组件收归本包而消失，本包如今不含任何跨包互引；再按包名放行等于把自己发出的自我引用一起放过。
  test("本包 web 文件不导入本包的 server / module 出口", () => {
    const offenders = ownRefs(graph.references).filter((ref) => ref.specifier.startsWith(`${PKG_NAME}/`));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 负例（人为注入，不建 fixture 文件）：`<pkg>/server` 是本包真实存在的 exports 出口，其后是
  // elysia / drizzle / node 内建。两条断言缺一不可——只断言「有违规」会被「递归失效、说明符本身被当成
  // 外部依赖」满足；只断言「进到了服务端实现」则漏掉拦截能力。
  //
  // 原先还有第三条「服务端必然出现 `@server/*` 说明符」：§1.7 B9 把三张知识库表的定义迁入本包 `db/`
  // 之后，本包 `src/**` 对宿主已零引用，该断言不再可能成立。它当初证明的是**递归深度够深**（挖到宿主
  // 说明符说明确实走进了服务端实现），这个职责改由「递归到底层仓储文件」+「node 内建确实发自
  // `src/server/**` 内部」两条承担——否则「递归只走了一层」与「服务端确实干净」就分不开。
  // §1.7 B10 起再加一条**零容忍**断言：那批清掉了 `@fenix/resource-memory` 的残留宿主导入（见 §7.22），
  // 本包的 poisoned 图也随之不再命中 `@server/`，于是家族里原先的「必须出现」统一改写为「必须为空」
  // （`resource-task` / `resource-prod-view` / `resource-channel` 因自身仍持有宿主表定义，暂保持原形）。
  test("负例：注入真实的 ./server 出口时递归进入服务端实现并触发拦截", () => {
    const poisoned = walkValueGraph(WEB_ENTRY, [`${PKG_NAME}/server`]);
    expect(poisoned.files).toContain(join(PKG_ROOT, "src", "server.ts"));
    const serverDir = `${join(PKG_ROOT, "src", "server")}${sep}`;
    expect(poisoned.files.filter((file) => file.startsWith(serverDir)).length).toBeGreaterThan(0);
    expect(poisoned.files).toContain(join(PKG_ROOT, "src", "server", "repositories", "knowledge-base.ts"));
    const nodeBuiltins = poisoned.references.filter(
      (ref) => ref.specifier.startsWith("node:") && ref.from.startsWith(serverDir),
    );
    expect(offendersOf(nodeBuiltins).length).toBeGreaterThan(0);
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

  // i18n 资源必须由入口转出（宿主统一注册）；字典留在包内是「键的 owner = 包」的必要条件。
  test("入口导出 knowledge 命名空间与 en/zh 资源", () => {
    const source = stripComments(readFileSync(WEB_ENTRY, "utf8"));
    expect(source).toContain("KNOWLEDGE_NS");
    expect(source).toContain("knowledgeResources");
  });

  // 静态条件 2 的另一半：图只覆盖「入口可达面」，而别名可能留在没被入口引用的文件里
  // （页面注册表、将来才接线的组件）。这里直接扫 `web/**` 全部源码，把那条躲避路径也堵上。
  test("包内 web 源码（含入口不可达文件）零宿主别名", () => {
    const offenders = walkedWebSources().filter((file) => {
      const source = stripComments(readFileSync(file, "utf8"));
      return /(?:from|import)\s*["']@\/(?:src|components)/.test(source);
    });
    expect(offenders.map(repoPath)).toEqual([]);
  });

  // `@antv/g6` → `@antv/g` → `html2canvas` 在**导入期**就求值 `window.document.createElement`，
  // 而无 DOM 的 bun 测试环境里 `window` 存在、`document` 为 undefined，静态导入会让任何间接引入
  // 本包 web 入口的用例加载即崩（2026-09-20：model-management / agent-config 的多个用例 0 断言执行）。
  // 因此 g6 只允许在 `KnowledgeGraphPanel` 内 `await import()`，类型经 `import type`（编译期擦除）。
  test("本包 web 源码不静态导入 @antv/g6（只允许惰性 import()）", () => {
    const offenders = walkedWebSources().filter((file) => {
      const source = stripComments(readFileSync(file, "utf8"));
      return /(?:^|[\s;])(?:import|export)\s+(?!type\s)[^;]*?from\s*["']@antv\/g6["']|(?:^|[\s;])import\s*["']@antv\/g6["']/.test(
        source,
      );
    });
    expect(offenders.map(repoPath)).toEqual([]);
  });
});

/**
 * 包内全部 web 源码文件（`web/**` 下的 .ts/.tsx，含未从入口转出的文件）。
 *
 * 上面的图只覆盖「入口可达面」，而静态条件 2 管的是包内**所有** web 文件；
 * 早前版本把两者混为一谈，会让「某文件没被入口引用」成为别名残留的躲避路径。
 */
function walkedWebSources(): string[] {
  const files: string[] = [];
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  for (const match of glob.scanSync({ cwd: WEB_ROOT, onlyFiles: true })) {
    if (match.includes("/__tests__/")) continue;
    files.push(join(WEB_ROOT, match));
  }
  return files;
}
