import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { isValidFileTreeBasename, isValidFileTreeMovePath } from "../components/agent-panel/FileTreeTab";

describe("file tree dialogs", () => {
  // 文件树重命名和新建操作只接受安全的单段名称。
  test("validates basename input after trimming", () => {
    expect(isValidFileTreeBasename(" report.txt ")).toBe(true);
    for (const value of ["", "   ", ".", "..", "a/b", "a\0b"]) {
      expect(isValidFileTreeBasename(value)).toBe(false);
    }
  });

  // 文件树移动操作允许完整路径，但拒绝空路径和 NUL。
  test("validates move path after trimming", () => {
    expect(isValidFileTreeMovePath(" user/archive/report.txt ")).toBe(true);
    expect(isValidFileTreeMovePath("   ")).toBe(false);
    expect(isValidFileTreeMovePath("user/\0report.txt")).toBe(false);
  });

  // 文件树顶部首个操作用于刷新当前列表，不再提供根目录新建文件入口。
  test("uses refresh as the first file tree toolbar action", () => {
    const componentPath = join(import.meta.dirname, "..", "components", "agent-panel", "file-tree-view.tsx");
    const source = fs.readFileSync(componentPath, "utf-8");
    const toolbar = source.slice(
      source.indexOf('<div className="file-tree-panel__actions">'),
      source.indexOf("<input ref="),
    );
    expect(toolbar).toContain("onClick={props.onRefresh}");
    expect(toolbar).toContain('title={t("fileTree.refresh")}');
    expect(toolbar).toContain("<RefreshCw");
    expect(toolbar).not.toContain('createAtSelected("file")');
  });

  // 文件标签栏必须位于右侧预览内容上方，不能回落到整个工作区底部。
  test("renders file tabs above the preview content", () => {
    const componentPath = join(import.meta.dirname, "..", "components", "agent-panel", "artifacts-files-workspace.tsx");
    const source = fs.readFileSync(componentPath, "utf-8");
    const previewPanel = source.slice(source.lastIndexOf("<ResizablePanel minSize="));
    expect(previewPanel.indexOf("<FileTabsBar")).toBeGreaterThanOrEqual(0);
    expect(previewPanel.indexOf("<FileTabsBar")).toBeLessThan(previewPanel.indexOf("<PreviewTab"));
  });

  // 文件树交互必须通过项目 Dialog，不能回退到浏览器 prompt。
  test("does not use window.prompt in file tree components", () => {
    const componentDir = join(import.meta.dirname, "..", "components", "agent-panel");
    const source = ["FileTreeTab.tsx", "file-tree-view.tsx", "file-tree-input-dialog.tsx"]
      .map((file) => fs.readFileSync(join(componentDir, file), "utf-8"))
      .join("\n");
    expect(source).not.toContain("window.prompt");
    expect(source).toContain("FileTreeInputDialog");
  });
});
