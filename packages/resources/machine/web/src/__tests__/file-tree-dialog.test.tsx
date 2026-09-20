// 文件树的**消费方契约**（W2.5 重写）。
//
// 归属：文件树视图（搜索框 / 双分区 / 反馈态 / 上传目标）按 §6.5 的共享 web 模块裁决上收到
// `@fenix/ui-components`，本包经对方**包根入口**取用（`web/components/file-tree-view` 这类深路径不在其
// exports 里，实测 `ResolveMessage: Cannot find module`）。宿主的容器 `FileTreeTab`（下载、重试、WS 事件）
// 与页面装配 `artifacts-files-workspace.tsx` 未随包迁移，归 §1.6。
//
// 为什么要重写：旧版本以六级相对路径 import 宿主 `FileTreeTab` 的校验函数，并逐个 `readFileSync` 宿主
// 源码文件做**字符串包含**断言（§1 静态条件 3 的 11 处命中里占 5 处）；那类断言钉的是文本而不是行为，
// 宿主实现一挪就断，也让包无法离开宿主解析环境构建。现在改为对共享视图做 SSR 行为断言。
//
// 文件名保留历史命名：旧版本覆盖的是「文件树 + 弹窗」这一组宿主文件，容器未随包迁移，本文件随之收敛到
// 视图契约本身。
//
// i18n 说明：资源包不初始化 i18next，`t()` 回退为 key 本身，因此断言锚在**键名**上（视图向宿主请求哪条
// 文案）；文案内容由 owner 包 `web/i18n/locales/*/uiComponents.json` 保证。
//
// 覆盖下降说明（每条都对应一个未随包迁移的 owner，不是删除能力）：
// - 重命名 / 移动的字节数校验（`isValidFileTreeBasename`、`getFileTreeNameByteLength`、`isValidFileTreeMovePath`）
//   仍只在宿主 `apps/web/src/components/agent-panel/FileTreeTab.tsx`，随 §1.6 迁移；服务端同名规则由
//   `src/server/__tests__/file-path-validator.test.ts` 覆盖。
// - 弹窗 `maxLength={255}`：`FileTreeInputDialog` 走 radix Dialog 门户，SSR 输出为空串，无法在此断言；
//   属 owner `@fenix/ui-components`（见报告「遗留」）。
// - CSS 断言（sticky 目录条、悬浮操作、浮层阴影）：样式归 `@fenix/ui-components` 的 `file-tree.css` 与
//   宿主 `artifacts-workspace.css`，旧断言是宿主的源码文本扫描。
// - 节点级操作（每个节点的刷新 / 删除按钮）与右键菜单门户：react-arborist 在 SSR 下不渲染节点
//   （实测 `.file-tree-arborist` 为空），需 DOM 环境；面板 owner 已迁出本包。
// - 宿主容器行为（下载状态、重试、`FileTabsBar` 与预览面板顺序）：`FileTreeTab` / `artifacts-files-workspace.tsx`
//   未迁移，归 §1.6。
import { describe, expect, test } from "bun:test";
import type { FileTreeViewProps } from "@fenix/ui-components";
import { FileTreeView } from "@fenix/ui-components";
import ReactDOMServer from "react-dom/server";

/** 视图契约的最小注入：所有远端操作由调用方通过回调提供，视图自身不碰文件 API。 */
function treeProps(overrides: Partial<FileTreeViewProps> = {}): FileTreeViewProps {
  return {
    loading: false,
    stale: false,
    uploading: false,
    dragOver: false,
    searchQuery: "",
    normalizedSearch: "",
    hasSearchResults: false,
    treeVersion: 1,
    showTree: true,
    workspaceHasNodes: true,
    userHasNodes: true,
    expandedIds: [],
    contextMenu: null,
    deleteConfirm: null,
    deleting: false,
    download: null,
    fileInputRef: { current: null },
    folderInputRef: { current: null },
    workspaceNodes: [{ name: "docs", path: "docs", isDir: true, children: [] }],
    userNodes: [{ name: "logo.png", path: "user/logo.png", isDir: false, children: [] }],
    onSelect: () => {},
    onToggle: () => {},
    onSearchChange: () => {},
    onRefresh: () => {},
    onUploadClick: () => {},
    onFolderUploadClick: () => {},
    onDrop: () => {},
    onFileInputChange: () => {},
    onFolderInputChange: () => {},
    onDragOver: () => {},
    onDragEnter: () => {},
    onDragLeave: () => {},
    onContextMenu: () => {},
    onReference: () => {},
    onDownload: () => {},
    onRenameRequest: () => {},
    onMoveRequest: () => {},
    onDeleteRequest: () => {},
    onNewFile: () => {},
    onNewFolder: () => {},
    onCloseDelete: () => {},
    onConfirmDelete: () => {},
    ...overrides,
  };
}

/** 渲染视图首屏；`renderToString` 不执行 effect，因此这里只覆盖由 props 决定的结构。 */
function renderTree(overrides: Partial<FileTreeViewProps> = {}): string {
  return ReactDOMServer.renderToString(<FileTreeView {...treeProps(overrides)} />);
}

describe("文件树视图（消费方契约）", () => {
  // 顶部工具条的首个动作是刷新当前列表：刷新入口不是文件变更操作，位置变到新建之后会让误触代价升高。
  test("工具条首个动作是刷新，且没有根级新建文件入口", () => {
    const html = renderTree();
    const actionsStart = html.indexOf('class="file-tree-panel__actions"');
    const actions = html.slice(actionsStart, html.indexOf("<input", actionsStart));

    expect(actionsStart).toBeGreaterThan(-1);
    expect(actions.indexOf('title="fileTree.refresh"')).toBeGreaterThan(-1);
    expect(actions.indexOf('title="fileTree.refresh"')).toBeLessThan(
      actions.indexOf('title="fileTree.contextMenu.newFolder"'),
    );
    expect(actions).not.toContain("lucide-file-plus-2");
  });

  // 工作区与「我的文件」两个分区必须同时在场并各自声明拖拽目标：上传落点靠 `data-upload-target` 区分，
  // 少了属性服务端就收到空落点；「我的文件」标题右侧的上传入口对应 `onUploadClick("user")` 注入点。
  test("保留双分区、拖拽目标与分区上传入口", () => {
    const html = renderTree();
    const workspaceSection = html.indexOf('data-upload-target=""');
    const userSection = html.indexOf('data-upload-target="user"');

    expect(html).toContain("file-tree-sections-layout");
    expect(workspaceSection).toBeGreaterThan(-1);
    expect(workspaceSection).toBeLessThan(userSection);
    expect(html.match(/class="file-tree-arborist"/g)?.length).toBe(2);
    const userBlock = html.slice(userSection);
    expect(userBlock.slice(0, userBlock.indexOf("</section>"))).toContain("file-tree-section-upload");
  });

  // 文件服务断连重连中的提示必须占据文件内容区：旧实现把它挂在搜索框下，与工作区标题重叠。
  test("陈旧状态横幅落在文件内容区内并可重试", () => {
    const html = renderTree({ stale: true });
    const sectionsStart = html.indexOf('class="file-tree-sections"');
    const content = html.slice(sectionsStart);

    expect(sectionsStart).toBeGreaterThan(-1);
    expect(html.slice(0, sectionsStart)).not.toContain("file-tree-feedback");
    expect(content).toContain("fileTree.staleBanner");
    expect(content).toContain("file-tree-feedback-action");
    expect(content).toContain("fileTree.retry");
  });

  // 没有节点时两个分区仍要保留并给出各自的空态：分区随数据有无跳变会让新建 / 上传入口位置不稳定。
  test("空数据时保留分区与各自空态", () => {
    const html = renderTree({ workspaceHasNodes: false, userHasNodes: false });

    expect(html.match(/data-upload-target=/g)?.length).toBe(2);
    expect(html).toContain("fileTree.emptyState");
    expect(html).toContain("fileTree.emptyHint");
    expect(html).toContain("fileTree.userEmptyState");
    expect(html).not.toContain("file-tree-arborist");
  });
});
