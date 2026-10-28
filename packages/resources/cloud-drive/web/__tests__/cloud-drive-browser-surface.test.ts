// web/__tests__/cloud-drive-browser-surface.test.ts
// 守护 `@fenix/resource-cloud-drive/web` 的浏览器可达面（2026-08-17 事故同类风险）。
//
// 遍历口径在 ./value-import-graph：静态走 `web/index.ts` 的**值导入图**，并且
// `@fenix/<pkg>[/<subpath>]` 会**经对方 package.json 的 exports 解析到真实源文件后递归进入**。
// 这正是事故的形态——`@fenix/x/server` 这类子路径会把 node 内建与服务端实现拖进浏览器 bundle。
//
// 本文件只放**本包的策略与断言**：node 内建、`@server/*`、宿主别名、越界到宿主 `apps/web`、
// 未声明/缺失的 exports 目标、白名单外的裸包依赖，以及「web 子图不得导入本包 server 出口」。
// 负例注入用真实的 `./server` 出口验证递归确实能穿透到服务端实现（否则拦截能力只是假绿）。
//
// 测试文件与 `node:*` 的豁免：递归只沿 exports 出口走，而任何包的 exports 都不指向 `__tests__`，
// 所以 `bun:test` 与测试夹具不会进入图。本测试只读文件，不 import 被测模块。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
const PKG_NAME = (JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as { name: string }).name;

/**
 * 浏览器安全外部依赖白名单：键是包根，值说明它为什么可以停在图外。
 *
 * 收录条件：由宿主提供（本包 peerDependency），或经 `@fenix/ui-components` 子路径传递进入的纯浏览器库。
 * workspace 包一律不收录——它们必须被递归进入，否则 `@fenix/x/server` 又能穿透。
 */
const BROWSER_SAFE_EXTERNAL: ReadonlyMap<string, string> = new Map([
  ["react", "React 运行时（本包 peerDependency，宿主注入）"],
  ["react-i18next", "React i18n 绑定（本包 peerDependency）"],
  // 本包直接依赖的纯浏览器库
  ["ahooks", "useRequest 数据获取（本包 dependencies）"],
  ["lucide-react", "SVG 图标库（本包 dependencies）"],
  ["sonner", "Toast 渲染（本包 dependencies），宿主亦直接依赖"],
  // 经 @fenix/ui-components 子路径传递进入的浏览器库
  ["radix-ui", "无样式原语聚合包（ui/progress 传递依赖）"],
  ["@radix-ui/react-slot", "无样式原语（ui/button 传递依赖）"],
  ["@radix-ui/react-dialog", "无样式原语（ui/dialog 传递依赖）"],
  ["@radix-ui/react-alert-dialog", "无样式原语（ui/alert-dialog 传递依赖）"],
  ["@radix-ui/react-label", "无样式原语（ui/label 传递依赖）"],
  ["class-variance-authority", "类名变体工具（ui/button 传递依赖），纯函数"],
  ["clsx", "类名拼接工具（ui-components/lib/cn 传递依赖），纯函数"],
  ["tailwind-merge", "Tailwind 类名去重（ui-components/lib/cn 传递依赖），纯函数"],
  ["react-hook-form", "表单状态（config/FormDialog 传递依赖），纯浏览器"],
  ["@hookform/resolvers", "react-hook-form 的解析器（config/FormDialog 的 zodResolver），纯函数"],
]);

const graph = walkValueGraph(WEB_ENTRY);
const describeRef = (ref: { from: string; specifier: string }): string => `${repoPath(ref.from)} → ${ref.specifier}`;
const offendersOf = (references: ReadonlyArray<{ from: string; specifier: string }>): string[] =>
  references.map(describeRef);
const reachedWebFiles = new Set(
  graph.files.filter((file) => file.startsWith(`${WEB_ROOT}${sep}`)).map((file) => relative(WEB_ROOT, file)),
);
const reachedPackageFiles = new Set(
  graph.references.flatMap((ref) => (ref.kind === "file" && ref.scope === "cross-package" ? [repoPath(ref.file)] : [])),
);
const externals = graph.references.filter((ref) => ref.kind === "external");

describe("cloud-drive web 入口浏览器可达面", () => {
  // 遍历有效性自检：图若解析失败会退化为「只有入口文件」，后续断言全部假绿。
  test("遍历有效性自检：包内模块与跨包 exports 目标都在到达集合中", () => {
    for (const expected of [
      "index.ts",
      "api/cloud-drive.ts",
      "lib/upload.ts",
      "lib/errors.ts",
      "hooks/use-cloud-drive-files.ts",
      "hooks/use-cloud-drive-uploads.ts",
      "pages/cloud-drive-page.tsx",
      "components/cloud-drive/cloud-drive-file-table.tsx",
    ]) {
      expect(reachedWebFiles).toContain(expected);
    }
    expect(reachedWebFiles.size).toBeGreaterThanOrEqual(20);

    // 跨包递归的有效性：web-runtime 的请求基建必须真的被走进去。
    expect(reachedPackageFiles).toContain("packages/web-runtime/web/api/request.ts");
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

  // node 内建一旦进入值导入图，浏览器构建只会得到外置桩并在加载期崩溃。
  test("值导入图不触及 node 内建", () => {
    expect(offendersOf(graph.references.filter((ref) => ref.specifier.startsWith("node:")))).toEqual([]);
  });

  // @server/* 是宿主服务端实现，包内 web 只能经 API + ./server 出口协作。
  test("值导入图不触及 @server 宿主服务端路径", () => {
    expect(offendersOf(graph.references.filter((ref) => ref.specifier.startsWith("@server/")))).toEqual([]);
  });

  // 宿主别名会让包离开 apps/web 的 tsconfig/vite 配置后无法解析。
  test("值导入图不残留宿主别名（@/src、@/components）", () => {
    const offenders = graph.references.filter((ref) => /^@\/(src|components)(\/|$)/.test(ref.specifier));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 相对路径越界到宿主是「解析成功」的合法内部节点，只有按路径前缀断言才能拦住。
  test("值导入图不进入宿主 apps/web 内部", () => {
    const hostWebRoot = `${join(PROJECT_ROOT, "apps", "web")}${sep}`;
    expect(graph.files.filter((file) => file.startsWith(hostWebRoot)).map(repoPath)).toEqual([]);
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
    expect(offendersOf(externals.filter((ref) => !BROWSER_SAFE_EXTERNAL.has(ref.root)))).toEqual([]);
  });

  // 浏览器入口的实现文件里不得导入本包的 server / module 出口（自我回环）。
  test("web 子图不导入本包的 server / module 出口", () => {
    const offenders = graph.references.filter((ref) => ref.specifier.startsWith(`${PKG_NAME}/`));
    expect(offendersOf(offenders)).toEqual([]);
  });

  // 负例：`<pkg>/server` 是真实存在的 exports 出口，其后是 elysia / node 内建。
  // 只断言「进到服务端实现」不够，还要断言 node 内建真的出现在 poisoned 图里，证明拦截能力未被放行削弱。
  test("负例：注入真实的 ./server 出口时递归进入服务端实现并触发拦截", () => {
    const poisoned = walkValueGraph(WEB_ENTRY, [`${PKG_NAME}/server`]);
    expect(poisoned.files).toContain(join(PKG_ROOT, "src", "server.ts"));
    expect(
      poisoned.files.filter((file) => file.startsWith(`${join(PKG_ROOT, "src", "server")}${sep}`)).length,
    ).toBeGreaterThan(0);
    expect(poisoned.references.filter((ref) => ref.specifier.startsWith("node:")).length).toBeGreaterThan(0);
  });

  // ./web 出口的契约：package.json 必须指向 web/index.ts，否则宿主解析到别的文件时守卫失去意义。
  test("package.json 的 ./web 出口指向 web/index.ts", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      exports?: Record<string, string>;
    };
    expect(pkg.exports?.["./web"]).toBe("./web/index.ts");
  });

  // 入口导出面：宿主路由壳取 CloudDrivePage；页面所需组件只在包内消费，不额外扩大公开面。
  test("入口转出页面与 API，且不转出服务端能力", () => {
    const source = stripComments(readFileSync(WEB_ENTRY, "utf8"));
    expect(source).toContain('from "./pages/cloud-drive-page"');
    expect(source).toContain('from "./api/cloud-drive"');
    expect(source).not.toContain("./server");
    expect(source).not.toContain("createWebCloudDriveRoutes");
  });
});
