// web/src/__tests__/preview-read-injection.test.ts
// 预览链路的两条宿主侧不变量（前端规范 §5.8 / §5.3 的预览源文件读取登记）：
//
// 1. **预览 URL 与取数都在域模块**：`/web/environments/<envId>/fs/<path>?preview=true` 是后端文件代理
//    路由，拼 URL 与带凭据取数都归 `api/fs.ts`；组件（含包内的 `PreviewTab` / `FileViewerPreview`）只
//    消费注入进来的两个函数。包内刻意不留全局 `fetch` 兜底，因此宿主必须两个 prop 一起给，否则预览
//    加载不到内容——这条断言就是防「注入悄悄掉了」。
// 2. **宿主侧只允许一处拼该 URL**：新增第二处就会重新长出一份路由字面量。

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../../..");

/** 宿主前端源码里所有出现 `?preview=true` 的文件（包内预览器的默认构建器不在扫描范围）。 */
async function findPreviewUrlSites(): Promise<string[]> {
  const sites: string[] = [];
  for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan({
    cwd: resolve(repoRoot, "apps/web/src"),
  })) {
    if (file.includes("__tests__") || file.includes(".test.")) continue;
    const content = await Bun.file(resolve(repoRoot, "apps/web/src", file)).text();
    if (content.includes("preview=true")) sites.push(file);
  }
  return sites;
}

describe("预览源文件的 URL 与取数归域模块", () => {
  // 组件只消费注入：文件工作区把域模块的两个函数一起交给包内的 tab 容器。
  test("宿主把 buildPreviewSourceUrl / readPreviewSource 注入预览 tab", async () => {
    const source = await Bun.file(
      resolve(repoRoot, "apps/web/src/components/agent-panel/artifacts-files-workspace.tsx"),
    ).text();

    expect(source).toContain('from "@/src/api/fs"');
    expect(source).toContain("buildPreviewUrl={buildPreviewSourceUrl}");
    expect(source).toContain("fetchPreview={readPreviewSource}");
  });

  // URL 字面量只有一份：换路由时不需要到处找（组件里再拼一次就会漏）。
  test("?preview=true 只出现在 api/fs.ts", async () => {
    expect(await findPreviewUrlSites()).toEqual(["api/fs.ts"]);
  });
});
