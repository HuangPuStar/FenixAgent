// web/__tests__/workflow-page-route.test.ts
// 守护 WorkflowPage 的导航契约：视图解析正确，且包内 web 不再出现 location 写操作。
//
// 为什么单独一个文件：解析逻辑拆到 `pages/workflow/workflow-path.ts`（纯函数）就是为了能被这样直接测到——
// 从 `pages/WorkflowPage.tsx` 导入会连带加载 `WorkflowEditor` 及其整条跨包链（`web/index.ts` 的说明与
// `workflow-browser-surface.test.ts` 的守卫都记录了这件事；§1.6 T6d 后该链不再经 `ChatPanel` →
// `@fenix/chat-channel`，面板改由宿主经 `chatPanel` 端口注入）。
//
// 第二条断言是 P0 规则的回归守卫：前端规范把 `window.location.href =` / `replace` / `reload` 与
// `history.pushState` / `replaceState` 列为 location 写操作禁令（`docs/developer/guide/frontend-development.md`
// 的导航一节）。本页原先正是用 `pushState` 自持子路由，改回 Router 之后需要一条防复活断言——否则
// 「包内某个页面又自己改地址栏」只会在人工 review 时被发现。扫描时先剥注释：注释里会举例写出这些
// 字面量（本包 `pages/WorkflowPage.tsx` 的说明就是这样），直接匹配会误报。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { parseWorkflowPath } from "../pages/workflow/workflow-path";
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

describe("WorkflowPage 视图解析", () => {
  // 列表页与运行记录 tab：`/agent/workflow` 上不带 section，`runs` 是其子段。
  test("列表与运行记录视图", () => {
    expect(parseWorkflowPath("/agent/workflow")).toEqual({ view: "list" });
    expect(parseWorkflowPath("/agent/workflow/")).toEqual({ view: "list" });
    expect(parseWorkflowPath("/agent/workflow/runs")).toEqual({ view: "runs" });
  });

  // 子视图必须解析出工作流 ID：拿不到 ID 时页面只能回落列表，用户点「版本历史」会莫名跳走。
  test("编辑与版本历史子视图带出 workflowId", () => {
    expect(parseWorkflowPath("/agent/workflow/wf_123/edit")).toEqual({ view: "edit", workflowId: "wf_123" });
    expect(parseWorkflowPath("/agent/workflow/wf_123/versions")).toEqual({ view: "versions", workflowId: "wf_123" });
  });

  // 非工作流路径（页面可能被挂在 `/agent/*` 的任意一层）与残缺子视图都回落列表，不抛错、不渲染空白。
  test("未命中工作流子路径时回落列表页", () => {
    expect(parseWorkflowPath("/agent/home")).toEqual({ view: "list" });
    expect(parseWorkflowPath("/")).toEqual({ view: "list" });
    expect(parseWorkflowPath("/agent/workflow/wf_123")).toEqual({ view: "list" });
    expect(parseWorkflowPath("/agent/workflow/wf_123/unknown")).toEqual({ view: "list" });
  });
});

describe("包内 web 的 location 写操作禁令（P0 回归守卫）", () => {
  // 扫描有效性自检：源码集合为空或漏掉页面时，下面的「无违规」断言会退化为恒真。
  test("扫描有效性自检：页面与纯逻辑模块都在扫描集合内", () => {
    const relatives = webSources.map((file) => relative(WEB_ROOT, file));
    for (const expected of [
      "pages/WorkflowPage.tsx",
      "pages/workflow/workflow-path.ts",
      "pages/workflow/WorkflowList.tsx",
      "pages/workflow/WorkflowVersions.tsx",
    ]) {
      expect(relatives).toContain(expected);
    }
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
