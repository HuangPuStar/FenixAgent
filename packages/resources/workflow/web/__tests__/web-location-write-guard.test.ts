// web/__tests__/web-location-write-guard.test.ts
// 守护工作流页面的两条契约：整页实现的归属，以及包内 web 生产源码不出现 location 写操作。
//
// **整页实现归宿主（2026-09-22 用户裁定落地）**：控制台的三个视图由宿主三份 TanStack 路由壳注册
// （`apps/web/src/routes/agent/_panel/workflow.tsx` 自持列表 / 运行记录 tab，`workflow_.$id.edit.tsx` 与
// `workflow_.$id.versions.tsx` 各自持有编辑与版本历史），壳再从本包 `./web` 入口取视图块
// （`WorkflowList` / `WorkflowRuns` / `WorkflowEditor` / `WorkflowVersions`）。包内曾有的整页副本
// `pages/WorkflowPage.tsx` 未导出、零消费者（路由壳自持整页后不需要它），已删除。本文件用两组断言把这个
// 归属钉住：宿主壳必须存在且注册着那张路由 ID 表（**页面实现消失**要报红），包内不得再长出整页副本
// （**重复页面重现**也要报红——两份实现各自漂移、两边都「能跑」时最难发现）。
//
// 由来：本文件此前叫 `workflow-page-route.test.ts`，第三组断言曾是视图解析。解析逻辑在
// `pages/workflow/workflow-path.ts`（纯函数，当时单独成文件是为了避开整页组件那条跨包值导入链：
// `WorkflowEditor` → `@fenix/agent-runtime`，`web/index.ts` 的说明与 `workflow-browser-surface.test.ts`
// 的守卫都记录了这件事）。该纯函数只被死页与那组断言引用，随死页一并退役，解析断言随之删除；
// 归属与 location 两条守卫与死页无关，保留并把文件改名为本名——守卫覆盖整个 `web/**`，不是某一页。
//
// location 断言是 P0 规则的回归守卫：前端规范把 `window.location.href =` / `replace` / `reload` 与
// `history.pushState` / `replaceState` 列为 location 写操作禁令（`docs/developer/guide/frontend-development.md`
// 的导航一节）。整页副本原先正是用 `pushState` 自持子路由（改回 Router 后由本断言防复活），包内任何页面
// 再自己改地址栏也只会在人工 review 时被发现。扫描时先剥注释：注释里会举例写出这些字面量（已退役的
// `pages/workflow/workflow-path.ts` 的说明就是这样），直接匹配会误报。

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { PROJECT_ROOT, stripComments, WEB_ROOT } from "./value-import-graph";

/** location 写操作形态；键是说明，值是该形态的正则。 */
const LOCATION_WRITE_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["history.pushState", /\.pushState\s*\(/],
  ["history.replaceState", /\.replaceState\s*\(/],
  ["location.assign", /\blocation\.assign\s*\(/],
  ["location.replace", /\blocation\.replace\s*\(/],
  ["location.reload", /\blocation\.reload\s*\(/],
  ["location.href 赋值", /\blocation\.href\s*=/],
];

/**
 * 整页实现的落点（仓库根相对 → 它注册的路由 ID）。
 *
 * 三个视图缺一不可：列表 / 运行记录在工作流首页的 tab 里，编辑与版本历史是独立路由（`workflow_` 段的
 * 下划线是 TanStack 的「路径段转义」写法，路由 ID 因此带 `workflow_`）。任一条被删、被改 ID 或换文件，
 * 工作流控制台就少一个视图——这正是「页面实现消失」的捕手。
 */
const HOST_PAGE_ROUTES: ReadonlyArray<[file: string, routeId: string]> = [
  ["apps/web/src/routes/agent/_panel/workflow.tsx", "/agent/_panel/workflow"],
  ["apps/web/src/routes/agent/_panel/workflow_.$id.edit.tsx", "/agent/_panel/workflow_/$id/edit"],
  ["apps/web/src/routes/agent/_panel/workflow_.$id.versions.tsx", "/agent/_panel/workflow_/$id/versions"],
];

/** 本包已退役的整页副本（相对 `WEB_ROOT`）：宿主壳自持整页后不再需要，也不允许再长一份。 */
const RETIRED_PACKAGE_PAGE = "pages/WorkflowPage.tsx";

/** 收集 `web/**` 的生产源码（排除 `__tests__` 与字典）：测试夹具可以为了造环境写 location。 */
function collectWebSources(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "__tests__" || entry === "i18n") continue;
      files.push(...collectWebSources(path));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      files.push(path);
    }
  }
  return files;
}

const webSources = collectWebSources(WEB_ROOT);

/** 抓取 `createFileRoute("…")` 注册的路由 ID；先剥注释，免得注释里的示例被当成真实注册。 */
function extractRouteIds(source: string): string[] {
  return [...stripComments(source).matchAll(/createFileRoute\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1]);
}

describe("整页实现的归属（宿主壳持有 / 包内不得复活）", () => {
  // 页面实现消失必须报红：宿主壳被删或路由 ID 被改，控制台就再也走不到对应视图。
  test("宿主三份路由壳存在，且各自注册着约定路由 ID", () => {
    for (const [file, routeId] of HOST_PAGE_ROUTES) {
      const path = resolve(PROJECT_ROOT, file);
      expect(existsSync(path)).toBe(true);
      expect(extractRouteIds(readFileSync(path, "utf8"))).toContain(routeId);
    }
  });

  // 抓取有效性自检：形态认错时上一条会假红或假绿——注释里的示例、以及只把路由 ID 写进常量都不算注册。
  test("自检：路由 ID 抓取只认 createFileRoute 调用", () => {
    expect(extractRouteIds('export const Route = createFileRoute("/agent/_panel/workflow")({});')).toEqual([
      "/agent/_panel/workflow",
    ]);
    expect(extractRouteIds('// createFileRoute("/agent/_panel/workflow") 已随整页副本退役\n')).toEqual([]);
    expect(extractRouteIds('const WORKFLOW_LIST_PATH = "/agent/workflow";\n')).toEqual([]);
  });

  // 重复页面重现必须报红：包内再长出一份整页实现，就会与宿主壳各持一套子路由与导航逻辑。
  test("本包不再保留整页实现副本", () => {
    expect(existsSync(join(WEB_ROOT, RETIRED_PACKAGE_PAGE))).toBe(false);
  });
});

describe("包内 web 的 location 写操作禁令（P0 回归守卫）", () => {
  // 扫描有效性自检：源码集合为空或漏掉页面时，下面的「无违规」断言会退化为恒真。
  test("扫描有效性自检：页面与纯逻辑模块都在扫描集合内", () => {
    const relatives = webSources.map((file) => relative(WEB_ROOT, file));
    for (const expected of [
      "pages/workflow/WorkflowList.tsx",
      "pages/workflow/WorkflowRuns.tsx",
      "pages/workflow/WorkflowVersions.tsx",
      "pages/workflow/WorkflowEditor.tsx",
    ]) {
      expect(relatives).toContain(expected);
    }
    // 阈值低于实际文件数（44）：单目录整体掉出扫描集时才报警，不因增删几个文件而抖动。
    expect(webSources.length).toBeGreaterThanOrEqual(40);
  });

  // 任何 location 写操作都必须走 Router（`useNavigate` / `<Link>`），否则 Router 状态与地址栏分叉。
  test("web 生产源码不存在 location 写操作", () => {
    const offenders: string[] = [];
    for (const file of webSources) {
      const code = stripComments(readFileSync(file, "utf8"));
      code.split("\n").forEach((line, index) => {
        for (const [label, pattern] of LOCATION_WRITE_PATTERNS) {
          if (pattern.test(line)) offenders.push(`${relative(WEB_ROOT, file)}:${index + 1} ${label}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  // 负例：确认上面的模式确实能命中写操作（`stripComments` 之后仍然如此），避免正则写坏后静默放过。
  test("负例：写操作样例能被模式命中，且注释中的样例被剥掉", () => {
    const writeSample = stripComments('window.history.pushState(null, "", "/agent/workflow");\n');
    const commentSample = stripComments('// window.history.pushState(null, "", "/agent/workflow");\n');
    const matches = (code: string) => LOCATION_WRITE_PATTERNS.some(([, pattern]) => pattern.test(code));

    expect(matches(writeSample)).toBe(true);
    expect(matches(commentSample)).toBe(false);
  });
});
