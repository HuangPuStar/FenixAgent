import { describe, expect, test } from "bun:test";
import { parsePathsToTree } from "@fenix/ui-components/components/file-tree-model";
import { planWorkspaceFileMoves, remapWorkspaceFilePath } from "../lib/workspace-file-operations";

describe("工作区移动计划", () => {
  // 跨分区移动复用真实相对路径，父子同时选中只移动父目录。
  test("移动到我的文件根目录并归并父子路径", () => {
    const tree = parsePathsToTree(["docs/a.md", "docs/b.md"]);
    expect(planWorkspaceFileMoves(["docs/a.md", "docs"], "user", tree)).toEqual({
      moves: [{ oldPath: "docs", newPath: "user/docs" }],
      failed: [],
    });
  });

  // 自身及后代目标会破坏目录树，必须在请求前拒绝整组。
  test("拒绝自身、后代及固定分区根的移动", () => {
    const tree = parsePathsToTree(["docs/sub/", "a.md"]);
    expect(planWorkspaceFileMoves(["docs"], "docs/sub", tree).failed[0]?.reason).toBe("descendant");
    expect(planWorkspaceFileMoves(["user"], "", tree).failed[0]?.reason).toBe("protected-root");
    expect(planWorkspaceFileMoves(["a.md"], "a.md", tree).failed[0]?.reason).toBe("invalid-target");
  });

  // 同名文件不覆盖，独立项目仍可移动；同目录移动不发请求。
  test("冲突单独报告，同目录移动为空操作", () => {
    const tree = parsePathsToTree(["a.md", "b.md", "target/a.md"]);
    expect(planWorkspaceFileMoves(["a.md", "b.md"], "target", tree)).toEqual({
      moves: [{ oldPath: "b.md", newPath: "target/b.md" }],
      failed: [{ path: "a.md", reason: "conflict" }],
    });
    expect(planWorkspaceFileMoves(["a.md"], "", tree)).toEqual({ moves: [], failed: [] });
  });

  // 目标不存在时不能借由 rename 自动创建目录；来源消失也要保留失败状态。
  test("消失的来源或目标不会生成写请求", () => {
    const tree = parsePathsToTree(["a.md", "target/"]);
    expect(planWorkspaceFileMoves(["a.md"], "missing", tree).failed[0]?.reason).toBe("invalid-target");
    expect(planWorkspaceFileMoves(["missing.md"], "target", tree).failed[0]?.reason).toBe("missing-source");
  });
});

describe("预览路径同步", () => {
  // 目录移动要同时更新后代预览，避免打开的 tab 指向失效地址。
  test("移动目录映射后代但不改相似前缀", () => {
    const change = { moved: [{ oldPath: "docs", newPath: "archive/docs" }], deleted: [] };
    expect(remapWorkspaceFilePath("docs/a.md", change)).toBe("archive/docs/a.md");
    expect(remapWorkspaceFilePath("docs-copy/a.md", change)).toBe("docs-copy/a.md");
  });

  // 只有服务端确认删除的路径才关闭预览，失败项目没有被放入成功结果。
  test("删除目录关闭后代预览，其他路径保留", () => {
    const change = { moved: [], deleted: ["docs"] };
    expect(remapWorkspaceFilePath("docs/a.md", change)).toBeNull();
    expect(remapWorkspaceFilePath("other/a.md", change)).toBe("other/a.md");
  });
});
