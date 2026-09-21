import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

const RMD_05_MOVES = [
  [
    "web/src/components/agent-panel/SiteFrame.tsx",
    "packages/resources/agent-config/web/components/agent-panel/SiteFrame.tsx",
  ],
  [
    "web/src/components/agent-panel/SiteTabsBar.tsx",
    "packages/resources/agent-config/web/components/agent-panel/SiteTabsBar.tsx",
  ],
  [
    "web/src/pages/agent-panel/components/ChunkDetailSheet.tsx",
    "packages/resources/knowledge/web/src/pages/agent-panel/components/ChunkDetailSheet.tsx",
  ],
  [
    "web/src/pages/agent-panel/components/RetrievalTestPanel.tsx",
    "packages/resources/knowledge/web/src/pages/agent-panel/components/RetrievalTestPanel.tsx",
  ],
] as const;

/**
 * RMD-05 迁入后经后续任务裁定删除的目标（迁移记录保留在此，只豁免「目标必须存在」断言）。
 * - `packages/resources/knowledge/web/src/__tests__/context-panel-ssr.test.tsx`：CE 阶段 2 §1.6 T5d 删除。
 *   它断言的 `ContextPanel` 宿主从不渲染（`ACPMain` 恒传 `hideContextPanel={true}`，渲染分支恒假），
 *   属生产不可达的死代码；裁定与证据见
 *   `docs/design/ce-ee-refactoring/review/task-1.6-web-shell.md` §四.9。同批从 knowledge 的
 *   `package.json` 移除仅它使用的 `@fenix/chat-channel` 依赖。
 */
const RMD_05_TARGETS_LATER_DELETED = [
  [
    "web/src/__tests__/context-panel-ssr.test.tsx",
    "packages/resources/knowledge/web/src/__tests__/context-panel-ssr.test.tsx",
  ],
] as const;

describe("RMD-05 ownership migration", () => {
  // 仅这 5 个已批准的源文件迁入指定 owner，防止旧根路径或额外迁移悄然出现。
  test("removes every legacy source and retains its exact owner target", () => {
    expect(RMD_05_MOVES.length + RMD_05_TARGETS_LATER_DELETED.length).toBe(5);
    for (const [source, target] of RMD_05_MOVES) {
      expect(existsSync(source), `legacy source still exists: ${source}`).toBe(false);
      expect(existsSync(target), `owner target is missing: ${target}`).toBe(true);
    }
  });

  // §四.9 裁定删除的死代码：源与目标都必须保持不存在——记录的是「已裁定删除」，不是「迁移丢失」。
  test("later-deleted migration targets and their legacy sources stay absent", () => {
    for (const [source, target] of RMD_05_TARGETS_LATER_DELETED) {
      expect(existsSync(source), `legacy source came back: ${source}`).toBe(false);
      expect(existsSync(target), `deleted target came back: ${target}`).toBe(false);
    }
  });
});
