// web/__tests__/web-location-write-guard.test.ts
// 守护包内 web 生产源码的 **location 写操作禁令**（P0 回归守卫）。
//
// 由来：本文件此前叫 `workflow-page-route.test.ts`，同时守着两件事——`pages/WorkflowPage.tsx` 的
// 视图解析，以及本包 web 不出现 location 写操作。前半件随死页删除而消失：宿主改用文件路由后，
// 四个视图由 `apps/web/src/routes/agent/_panel/workflow*.tsx` 各自渲染 `WorkflowList` /
// `WorkflowRuns` / `WorkflowEditor` / `WorkflowVersions`，包内 `WorkflowPage` 变成零消费死页
// （它渲染编辑器时还缺宿主注入的 `chatPanel` 端口，见 tsconfig 门禁修复批）。因此
// `pages/WorkflowPage.tsx`、`pages/workflow/workflow-path.ts` 与那两条解析断言一并删除，
// 只把**与死页无关**的 P0 守卫留下并改名为本文件——守卫覆盖的是整个 `web/**`，不是某一页。
//
// 断言内容：前端规范把 `window.location.href =` / `replace` / `reload` 与
// `history.pushState` / `replaceState` 列为 location 写操作禁令（`docs/developer/guide/frontend-development.md`
// 的导航一节）。此包内曾有页面用 `pushState` 自持子路由，改回 Router 之后需要一条防复活断言——
// 否则「包内某个页面又自己改地址栏」只会在人工 review 时被发现。扫描前先剥注释：注释里会举例写出
// 这些字面量（本文件与 `web/index.ts` 的说明就是这样），直接匹配会误报。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { stripComments, WEB_ROOT } from "./value-import-graph";

/** location 写操作形态；键是说明，值是该形态的正则。 */
const LOCATION_WRITE_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["history.pushState", /\.pushState\s*\(/],
  ["history.replaceState", /\.replaceState\s*\(/],
  ["location.assign", /\blocation\.assign\s*\(/],
  ["location.replace", /\blocation\.replace\s*\(/],
  ["location.reload", /\blocation\.reload\s*\(/],
  ["location.href 赋值", /\blocation\.href\s*=/],
];

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

describe("包内 web 的 location 写操作禁令（P0 回归守卫）", () => {
  // 扫描有效性自检：源码集合为空或漏掉页面时，下面的「无违规」断言会退化为恒真。
  test("扫描有效性自检：页面与纯逻辑模块都在扫描集合内", () => {
    const relatives = webSources.map((file) => relative(WEB_ROOT, file));
    for (const expected of [
      "pages/workflow/WorkflowList.tsx",
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
