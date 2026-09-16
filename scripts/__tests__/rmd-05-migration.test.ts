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
  [
    "web/src/__tests__/context-panel-ssr.test.tsx",
    "packages/resources/knowledge/web/src/__tests__/context-panel-ssr.test.tsx",
  ],
] as const;

describe("RMD-05 ownership migration", () => {
  // 仅这 5 个已批准的源文件迁入指定 owner，防止旧根路径或额外迁移悄然出现。
  test("removes every legacy source and retains its exact owner target", () => {
    expect(RMD_05_MOVES).toHaveLength(5);
    for (const [source, target] of RMD_05_MOVES) {
      expect(existsSync(source), `legacy source still exists: ${source}`).toBe(false);
      expect(existsSync(target), `owner target is missing: ${target}`).toBe(true);
    }
  });
});
