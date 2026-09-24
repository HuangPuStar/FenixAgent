// web/__tests__/collapsible-group-single-source.test.ts
//
// §4.1「已有组件禁止重复开发」在**包内**的守卫：折叠分组容器 `CollapsibleGroup` 只允许一份实现。
//
// 为什么值得钉死：2026-09-23（第 19 轮）之前本包有两份同名同 props 的实现——`node-config-fields.tsx`
// 里用原生 `<details>`、`RunParamsDialog.tsx` 里用 `useState` + `ParamGroupHeader`。它们都不会编译报错、
// 也不会让任何既有用例变红（两处的分支都各自正确），只有肉眼比对才能发现，于是「再复制一份」的成本为零。
// 收敛之后由本文件兜住：谁再往某个页面里塞第三份，用例立刻变红。
//
// 断言分两层：① 实现只有一处（按函数声明扫全包源码）；② 两个既有调用点都从共享件 import——
// 只断言 ① 的话，把调用点改回内联 JSX（不再声明函数）仍会绿。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const WEB_ROOT = join(import.meta.dir, "..");

/** 递归收集包内 web 源码（排除测试目录）。 */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "__tests__") continue;
      collectSources(path, out);
    } else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

const sources = collectSources(WEB_ROOT);

/** 声明 `CollapsibleGroup` 的文件（函数声明形态，含 `export function`）。 */
const declarationFiles = sources
  .filter((file) => /^(?:export )?function CollapsibleGroup\b/m.test(readFileSync(file, "utf8")))
  .map((file) => relative(WEB_ROOT, file));

describe("CollapsibleGroup 单实现", () => {
  // 扫描有效性自检 + 唯一性：找不到实现说明改名了，断言必须变红而不是空转。
  test("全包只有 components/CollapsibleGroup.tsx 一份实现", () => {
    expect(declarationFiles).toEqual(["pages/workflow/components/CollapsibleGroup.tsx"]);
  });

  // 两个既有调用点（节点配置卡的工具分组、运行参数弹窗的分组）都必须复用共享件，不得就地重写。
  test("两个调用点都从共享件引入", () => {
    for (const rel of [
      "pages/workflow/components/node-config-custom-tool-section.tsx",
      "pages/workflow/components/RunParamsDialog.tsx",
    ]) {
      expect(readFileSync(join(WEB_ROOT, rel), "utf8")).toContain('from "./CollapsibleGroup"');
    }
  });

  // 字段原语文件（节点配置卡的两种字段外形）不再顺带持有折叠容器，避免下一次从这里复制走。
  test("node-config-fields 不再导出折叠容器", () => {
    expect(readFileSync(join(WEB_ROOT, "pages/workflow/components/node-config-fields.tsx"), "utf8")).not.toContain(
      "export function CollapsibleGroup",
    );
  });
});
