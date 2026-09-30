// web/src/__tests__/artifacts-cluster-location.test.ts
// 工件面板一簇的落点与样式落点守卫（前端规范 §1 的目录分工：`shell/` 是应用壳与侧栏装配、
// `pages/` 是宿主专有页面）。
//
// 由来：这一簇（`ArtifactsPanel` / `TopModeTabs` / `artifacts-dialogs`）是**跨资源包的宿主装配**——同时
// import `@fenix/agent-config/web`、`@fenix/resource-machine/web`、`@fenix/resource-prod-view/web`、
// `@fenix/resource-task/web`，进组件库违反该包零依赖定位、进任一资源包违反 §2.3 依赖矩阵，因此只能留宿主。
// 落点跟着**唯一生产消费者**走：消费者是宿主页面 `pages/agent-panel/`，故 2026-09-28 从
// `apps/web/src/shell/artifacts/` 归位 `apps/web/src/pages/agent-panel/artifacts/`。
//
// 两条断言防的是**静态检查与 tsc 都发现不了**的漂移：文件放错目录（层级语义被静默破坏）与样式落点漂移。
// 后者的历史是：伴随表 `artifacts-workspace.css` 原由 `ChatArea.tsx` 副作用导入，进的是懒加载 chunk
// （preload helper 在运行期把 <link> append 到 head 末尾，与 index.html 静态 <link> 的级联先后正好相反）；
// 2026-09-28 该表退役——几何撤回消费方 `className`（刻度已在 `@theme` 按 px 落地），伪元素、
// `[data-layout=…]` 属性选择器、跨元素覆写与 1050px 非标准断点收进 `src/index.css` 的「宿主壳残余样式」段，
// 变成**静态且在前**。多一个样式导入点、或在宿主 `src/` 里留下一份同名表，都可能翻转级联且不会报错。

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** 宿主 `src/`（本文件在 `src/__tests__/` 下）。 */
const host = resolve(import.meta.dir, "..");

/** 一簇三个文件（相对 `src/`）：面板本体、一级 tab 栏与站点弹窗。 */
const CLUSTER_FILES = [
  "pages/agent-panel/artifacts/ArtifactsPanel.tsx",
  "pages/agent-panel/artifacts/TopModeTabs.tsx",
  "pages/agent-panel/artifacts/artifacts-dialogs.tsx",
];

/** 递归收集宿主源码目录下指定扩展名的文件。 */
function collectByExtension(dir: string, extension: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...collectByExtension(path, extension));
    else if (entry.endsWith(extension)) files.push(path);
  }
  return files;
}

/** 递归收集宿主源码目录下的全部 `.ts` / `.tsx`。 */
function collectSources(dir: string): string[] {
  return [...collectByExtension(dir, ".ts"), ...collectByExtension(dir, ".tsx")];
}

/** 剥掉块注释与行注释后的源码：说明文字里会写出被断言的字面量，直接匹配会误报（同路由壳守卫口径）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("工件面板一簇的落点", () => {
  // 业务意图：面板本体与两个私有件必须同目录同住（§4.6 文件结构）且落在唯一消费者所在的页面目录；
  // 被搬回 `shell/` 或散到别处都会在这里失败。
  test("一簇三个文件都在 pages/agent-panel/artifacts/ 下", () => {
    for (const file of CLUSTER_FILES) {
      expect(existsSync(resolve(host, file)), `${file} 不在宿主页面目录下`).toBe(true);
    }
  });

  // 业务意图：`shell/` 只留应用壳与侧栏装配；旧目录复活说明这次归位被回退，壳层语义会重新混入页面装配。
  test("shell/artifacts/ 目录不再存在", () => {
    expect(existsSync(resolve(host, "shell/artifacts"))).toBe(false);
  });

  // 业务意图：宿主 `src/` 只有一份样式表，且只有 `main.tsx` 静态导入它。这是「样式落点唯一」的可执行
  // 判据——伴随表复活、或某处又冒出一个副作用导入（可能进懒加载 chunk、翻转与静态表的先后）都会失败。
  test("宿主 src 只留 index.css 一份样式表，且只有 main.tsx 导入", () => {
    const cssFiles = collectByExtension(host, ".css").map((path) => path.slice(host.length + 1));
    expect(cssFiles).toEqual(["index.css"]);

    const importers = collectSources(host)
      .filter((path) => !path.includes(`${join("src", "__tests__")}`))
      .filter((path) => /^\s*import\s+["'][^"']*\.css["']/m.test(stripComments(readFileSync(path, "utf-8"))))
      .map((path) => path.slice(host.length + 1));
    expect(importers).toEqual(["main.tsx"]);
  });

  // 业务意图：工件面板的残余规则必须整体落在 `index.css` 的「宿主壳残余样式」段——属性选择器与跨元素
  // 覆写要在那里压过工具类；同时撤回 `className` 的几何不得回流成 CSS 声明（同一属性只由一边声明）。
  test("工件面板的残余规则落在 index.css，撤回的几何不得回流", () => {
    const css = stripComments(readFileSync(resolve(host, "index.css"), "utf-8"));

    expect(css).toContain('.artifacts-shell[data-layout="floating"]');
    expect(css).toContain('.artifacts-shell[data-layout="docked"] .artifacts-workspace');
    expect(css).toContain(".artifacts-shell__resizer::after");
    expect(css).toContain(".artifacts-mode-tab.is-active::after");
    expect(css).toContain("@media (max-width: 1050px)");
    expect(css).not.toContain("min-width: 320px");
    expect(css).not.toContain("border-radius: 12px");
    expect(css).not.toContain("height: 44px");
  });
});
