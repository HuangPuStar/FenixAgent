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

  // 文件树必须由 React Arborist 虚拟化渲染，不得回退到通用异步 Tree。
  test("renders file sections with react-arborist", () => {
    const componentPath = join(import.meta.dirname, "..", "components", "agent-panel", "file-tree-view.tsx");
    const source = fs.readFileSync(componentPath, "utf-8");

    expect(source).toContain('from "react-arborist"');
    expect(source).toContain("<ArboristTree");
    expect(source).toContain("NodeRendererProps<ParsedFileNode>");
    expect(source).not.toContain('from "@/components/ui/tree"');
    expect(source).not.toContain("getWorkspaceChildren");
    expect(source).not.toContain("getUserChildren");
  });

  // 每个文件树节点右侧都必须提供刷新和经确认的删除入口，且不能在展示组件中直接调用文件 API。
  test("renders refresh and delete actions for each file tree node", () => {
    const componentPath = join(import.meta.dirname, "..", "components", "agent-panel", "file-tree-view.tsx");
    const source = fs.readFileSync(componentPath, "utf-8");
    const actions = source.slice(source.indexOf("function FileTreeNode"), source.indexOf("function Feedback"));

    expect(actions).toContain("props.onRefresh()");
    expect(actions).toContain("props.onDeleteRequest(data.path, data.name)");
    expect(actions).toContain("<RefreshCw aria-hidden />");
    expect(actions).toContain("<Trash2 aria-hidden />");
    expect(actions).not.toContain("<ExternalLink");
    expect(actions).not.toContain("fsApi.");
  });

  // 节点操作必须绝对定位覆盖在文件名右侧，不得作为 flex 子项压缩文件名宽度。
  test("floats file tree actions over the node label", () => {
    const stylesheetPath = join(import.meta.dirname, "..", "pages", "agent-panel", "artifacts-workspace.css");
    const styles = fs.readFileSync(stylesheetPath, "utf-8");
    const actionStyles = styles.match(
      /\.file-tree-section \[data-slot="tree-item-actions"\],\s*\.file-tree-arborist-actions \{([^}]*)\}/,
    )?.[1];

    expect(actionStyles).toContain("position: absolute");
    expect(actionStyles).toContain("right: 4px");
  });

  // 文件服务重连提示必须占据文件内容空状态，不能作为搜索框下的独立横幅与工作区标题重叠。
  test("renders stale file service state inside the file content area", () => {
    const componentPath = join(import.meta.dirname, "..", "components", "agent-panel", "file-tree-view.tsx");
    const source = fs.readFileSync(componentPath, "utf-8");
    const sectionsStart = source.indexOf('className="file-tree-sections"');
    const staleBranch = source.indexOf("{props.stale ? (", sectionsStart);
    const loadingBranch = source.indexOf(") : props.loading ? (", staleBranch);

    expect(sectionsStart).toBeGreaterThan(-1);
    expect(staleBranch).toBeGreaterThan(sectionsStart);
    expect(loadingBranch).toBeGreaterThan(staleBranch);
    expect(source.slice(0, sectionsStart)).not.toContain("file-tree-stale");
    expect(source.slice(staleBranch, loadingBranch)).toContain("fileTree.staleBanner");
    expect(source.slice(staleBranch, loadingBranch)).toContain("file-tree-feedback-action");
  });

  // 垂直文件分区的默认值必须显式使用百分比、下限必须使用像素，避免 v4 将裸数字统一解释为像素后初始化坍缩。
  test("uses explicit units for file tree panel sizes", () => {
    const componentPath = join(import.meta.dirname, "..", "components", "agent-panel", "file-tree-view.tsx");
    const source = fs.readFileSync(componentPath, "utf-8");

    expect(source).toContain('const FILE_TREE_WORKSPACE_MIN_HEIGHT = "112px"');
    expect(source).toContain('const FILE_TREE_USER_MIN_HEIGHT = "68px"');
    expect(source).toContain('defaultSize="60%" minSize={FILE_TREE_WORKSPACE_MIN_HEIGHT}');
    expect(source).toContain('defaultSize="40%" minSize={FILE_TREE_USER_MIN_HEIGHT}');
  });

  // 浮动工作区的阴影必须落在稳定容器上，避免 filter 合成整棵动态文件树时残留旧帧。
  test("uses container box shadow for the floating workspace", () => {
    const stylesheetPath = join(import.meta.dirname, "..", "pages", "agent-panel", "artifacts-workspace.css");
    const source = fs.readFileSync(stylesheetPath, "utf-8");
    const shellStyles = source.match(/\.artifacts-shell\[data-layout="floating"\] \{([^}]*)\}/)?.[1];
    const workspaceStyles = source.match(
      /\.artifacts-shell\[data-layout="floating"\] \.artifacts-workspace \{([^}]*)\}/,
    )?.[1];

    expect(shellStyles).not.toContain("filter:");
    expect(workspaceStyles).toContain("box-shadow:");
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
