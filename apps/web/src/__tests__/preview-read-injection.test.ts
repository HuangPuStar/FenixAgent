// web/src/__tests__/preview-read-injection.test.ts
// 预览链路的两条不变量（前端规范 §5.8 / §5.3 的预览源文件读取登记）：
//
// 1. **预览 URL 与取数都在域模块**：`/web/environments/<envId>/fs/<path>?preview=true` 是文件代理
//    路由，拼 URL 与带凭据取数都归 `@fenix/resource-machine/web` 的 `web/api/fs.ts`（2026-09-24 随
//    台账 `ce-standards-todo.md` D2 从宿主迁入）；组件（含包内的 `PreviewTab` / `FileViewerPreview`）
//    只消费注入进来的两个函数。包内刻意不留全局 `fetch` 兜底，因此调用方必须两个 prop 一起给，
//    否则预览加载不到内容——这条断言就是防「注入悄悄掉了」。
// 2. **URL 字面量全仓只允许一处**：宿主与文件域 owner 包的 web 面一起扫，新增第二处就会重新长出
//    一份路由字面量。

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../../..");

/** 扫描根：宿主前端源码与文件域 owner 包的 web 面（包内预览器的默认构建器不在扫描范围）。 */
const SCAN_ROOTS = ["apps/web/src", "packages/resources/machine/web"];

/** 出现 `?preview=true` 的源码文件（仓库相对路径）。 */
async function findPreviewUrlSites(): Promise<string[]> {
  const sites: string[] = [];
  for (const root of SCAN_ROOTS) {
    for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: resolve(repoRoot, root) })) {
      if (file.includes("__tests__") || file.includes(".test.")) continue;
      const content = await Bun.file(resolve(repoRoot, root, file)).text();
      if (content.includes("preview=true")) sites.push(`${root}/${file}`);
    }
  }
  return sites;
}

describe("预览源文件的 URL 与取数归域模块", () => {
  // 组件只消费注入：文件工作区把域模块的两个函数一起交给包内的 tab 容器。
  // 2026-09-24（台账 D2）：工作区本身随文件域迁入 `@fenix/resource-machine/web`，取数改经同包
  // `web/api/fs.ts`（不再是跨包说明符）；断言点仍是「两个 prop 必须一起给」，与实现所在文件无关。
  test("文件工作区把 buildPreviewSourceUrl / readPreviewSource 注入预览 tab", async () => {
    const source = await Bun.file(
      resolve(repoRoot, "packages/resources/machine/web/components/artifacts-files-workspace.tsx"),
    ).text();

    expect(source).toContain('from "../api/fs"');
    expect(source).toContain("buildPreviewUrl={buildPreviewSourceUrl}");
    expect(source).toContain("fetchPreview={readPreviewSource}");
  });

  // URL 字面量只有一份：换路由时不需要到处找（组件里再拼一次就会漏）。宿主侧随 D2 清零。
  test("?preview=true 只出现在 machine 包的 api/fs.ts", async () => {
    expect(await findPreviewUrlSites()).toEqual(["packages/resources/machine/web/api/fs.ts"]);
  });
});
