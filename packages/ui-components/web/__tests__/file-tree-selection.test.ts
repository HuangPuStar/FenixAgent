import { describe, expect, test } from "bun:test";
import * as model from "../components/file-tree-model";

describe("文件树选择", () => {
  // 连选按可见行计算，不把折叠目录里的文件混入删除范围。
  test("Shift 仅选择锚点与目标之间的可见路径", () => {
    const tree = model.parsePathsToTree(["docs/a.md", "docs/b.md", "other/hidden.md", "user/x.md"]);
    const sections = model.splitFileTreeSections(tree);
    const visible = [
      ...model.getVisibleFileTreePaths(sections.workspace, ["docs"]),
      ...model.getVisibleFileTreePaths(sections.user, []),
    ];
    expect(visible).toEqual(["docs", "docs/a.md", "docs/b.md", "other", "user/x.md"]);
    expect(
      model.selectFileTreePaths({ paths: ["docs/a.md"], anchor: "docs/a.md" }, "user/x.md", visible, {
        toggle: false,
        range: true,
      }),
    ).toEqual({ paths: ["docs/a.md", "docs/b.md", "other", "user/x.md"], anchor: "docs/a.md" });
  });

  // Cmd/Ctrl 点选既能跨分区追加，也能取消单项而不影响其他项。
  test("修饰键切换选择，普通单击替换选择", () => {
    const state = { paths: ["a.md"], anchor: "a.md" };
    const multi = model.selectFileTreePaths(state, "user/b.md", [], { toggle: true, range: false });
    expect(multi.paths).toEqual(["a.md", "user/b.md"]);
    expect(model.selectFileTreePaths(multi, "a.md", [], { toggle: true, range: false }).paths).toEqual(["user/b.md"]);
    expect(model.selectFileTreePaths(multi, "c.md", [], { toggle: false, range: false }).paths).toEqual(["c.md"]);
  });

  // 搜索后锚点不可见时从当前行开始，避免选择未显示的旧范围。
  test("不可见锚点回退到当前项", () => {
    expect(
      model.selectFileTreePaths({ paths: ["hidden"], anchor: "hidden" }, "shown", ["shown"], {
        toggle: false,
        range: true,
      }),
    ).toEqual({ paths: ["shown"], anchor: "shown" });
  });

  // 删除和移动父目录时子目录已被包含，不重复执行子路径。
  test("父子路径去重且相似前缀互不覆盖", () => {
    expect(model.getRootFileTreePaths(["docs/a.md", "docs", "docs-other/x.md", "docs", ""])).toEqual([
      "docs",
      "docs-other/x.md",
    ]);
  });
});
