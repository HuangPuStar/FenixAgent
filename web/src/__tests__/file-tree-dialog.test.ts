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
