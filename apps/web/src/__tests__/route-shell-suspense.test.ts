// 路由壳必须自带 `Suspense` 边界的回归守卫（前端规范 §2.5）。
//
// 由来：`agent/_panel/agents.tsx` 曾按「极简壳」写法把懒组件直接交给 `component:`，本壳没有边界。
// 懒加载挂起时 React 只能冒泡到最近的上层边界——`_panel.tsx` 为**壳自身代码块**备的整屏
// `Spinner variant="screen"`——于是整个 WebShell（侧栏、聊天保活）被卸载重建，用户看到的现象就是
// 「切到智能体管理时整页刷新一次」。页面内的 `loading` 只覆盖取数、接不住代码块加载，
// 所以边界必须与壳一一对应：这条断言防它复活。
//
// 扫描前剥注释：说明文字里会写出被要求的字面量，直接匹配会误报（同 `web-location-write-guard.test.ts`）。
// 剥注释用正则，前提是路由壳里没有字符串内含 `//`（无 URL 字面量，2026-09-23 全量扫描已确认）。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROUTES_DIR = join(import.meta.dirname, "..", "routes");

/** 递归收集路由目录下的全部 `.tsx` 壳文件。 */
function collectRouteShells(dir: string): string[] {
  const shells: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      shells.push(...collectRouteShells(path));
    } else if (entry.endsWith(".tsx")) {
      shells.push(path);
    }
  }
  return shells;
}

/** 壳源码，已剥掉块注释与行注释。 */
function shellSource(path: string): string {
  return readFileSync(path, "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

const LAZY_SHELLS = collectRouteShells(ROUTES_DIR).filter((path) => shellSource(path).includes("lazy("));

describe("路由壳 Suspense 边界", () => {
  // 业务意图：懒加载壳缺边界会把整个 WebShell 卸载重建（用户看到的「整页刷新」），
  // 因此每个用 lazy 的壳都必须在同一文件里渲染自己的 <Suspense>，不许依赖上层兜底。
  test("每个 lazy 路由壳都自带 Suspense 边界", () => {
    expect(LAZY_SHELLS.length).toBeGreaterThan(0);
    const missing = LAZY_SHELLS.filter((path) => !/<Suspense[\s>]/.test(shellSource(path)));
    expect(missing.map((path) => relative(ROUTES_DIR, path))).toEqual([]);
  });

  // 业务意图：点名本缺陷的现场——智能体管理壳要用面板级 fallback 包住懒组件，
  // 不能再把裸懒组件直接赋给 component（那条写法上层只剩整屏 fallback，切页即整页刷新）。
  test("智能体管理壳用 PanelRouteFallback 包住懒组件", () => {
    const source = shellSource(join(ROUTES_DIR, "agent", "_panel", "agents.tsx"));
    expect(source).toContain("<Suspense fallback={<PanelRouteFallback />}>");
    expect(source).not.toMatch(/component:\s*AgentManagementPage\b/);
  });
});
