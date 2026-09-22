// 文件树视图 Tailwind 迁移后的锚点回归（owner: `web/components`）。
//
// 背景：`web/components/file-tree.css`（436 行）已整体迁入 JSX 的 Tailwind 工具类并删除；迁移契约要求
// 修饰性类名（`file-tree-*` / `is-selected` / `is-danger`）全删，只留 `data-slot` 锚点供测试与「父选子」。
// 跨包消费方（`packages/resources/machine` 的 `web/src/__tests__/file-tree-dialog.test.tsx`）原先断言的
// 正是这些类名，改锚后由本文件在包内把这些锚点钉住，避免后续改动无声破坏消费方契约。
//
// 断言方式：SSR 静态标记，不需要 DOM 引导（react-arborist 在服务端只渲染外层容器，节点列表要客户端
// 测高后才出现，节点行的选中 / 悬停类组合不由本文件覆盖）。
//
// i18n：与 `tree-component.test.tsx` 同一约定——用包内字典经 `I18nextProvider` 注入，不用 `mock.module`。

import { describe, expect, test } from "bun:test";
import { createInstance, type i18n as I18nInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { initReactI18next } from "react-i18next/initReactI18next";
import type { FileTreeViewProps } from "../components/file-tree-view";
import { FileTreeView } from "../components/file-tree-view";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

const i18n: I18nInstance = createInstance();
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: { en: { [UI_COMPONENTS_NS]: en } },
});

/** 视图契约的最小注入：所有远端操作由调用方通过回调提供。 */
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

function render(node: ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

function renderTree(overrides: Partial<FileTreeViewProps> = {}): string {
  return render(<FileTreeView {...treeProps(overrides)} />);
}

/** 取某个 `data-slot` 锚点元素上的 class 值；`nth` 用于同锚点多次出现时定位（0 起）。 */
function slotClass(html: string, slot: string, nth = 0): string {
  const matches = html.split(`data-slot="${slot}"`);
  const segment = matches[nth + 1] ?? "";
  return /class="([^"]*)"/.exec(segment)?.[1] ?? "";
}

/** 渲染结果里所有 class 值拍平成类名列表，用于「旧修饰类名是否还在」这类整体断言。 */
function classNames(html: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)].flatMap((match) => match[1].split(/\s+/).filter(Boolean));
}

/** 迁移时删除的修饰性类名前缀 / 全名；命中任意一条即说明样式没有真正迁进工具类。 */
const REMOVED_CLASSES = ["file-tree-", "file-real-file-icon", "is-selected", "is-danger"];

describe("文件树视图（Tailwind 迁移锚点）", () => {
  // 工具条动作区是消费方定位刷新/新建入口的锚点，首个动作必须是刷新（沿用原类名锚点的语义）。
  test("工具条暴露 file-tree-panel-actions 锚点且刷新在新建之前", () => {
    const html = renderTree();
    const actions = slotClass(html, "file-tree-panel-actions");

    expect(html).toContain('data-slot="file-tree-panel-actions"');
    expect(actions).toContain("gap-px");
    const refreshAt = html.indexOf(`title="${en.fileTree.refresh}"`);
    const newFolderAt = html.indexOf(`title="${en.fileTree.contextMenu.newFolder}"`);
    expect(refreshAt).toBeGreaterThan(-1);
    expect(refreshAt).toBeLessThan(newFolderAt);
  });

  // 双分区与拖拽落点属性是上传逻辑的输入：属性缺失会让服务端收到空落点，故与分区结构一并守住。
  test("双分区、拖拽目标与两棵树容器锚点都保留", () => {
    const html = renderTree();

    expect(html).toContain('data-slot="file-tree-sections-layout"');
    expect(html.match(/data-slot="file-tree-arborist"/g)?.length).toBe(2);
    expect(html.match(/data-upload-target=/g)?.length).toBe(2);
    expect(slotClass(html, "file-tree-section-upload")).toContain("text-brand");
  });

  // 没有节点时分区与空态仍需在场：分区数量随数据跳变会让新建 / 上传入口位置不稳定。
  test("空数据时保留分区与各自空态", () => {
    const html = renderTree({ workspaceHasNodes: false, userHasNodes: false });

    expect(html.match(/data-slot="file-tree-feedback"/g)?.length).toBe(2);
    expect(html).not.toContain('data-slot="file-tree-arborist"');
    expect(html).toContain(en.fileTree.emptyState);
    expect(html).toContain(en.fileTree.userEmptyState);
  });

  // 陈旧横幅必须落在文件内容区内（滚动区之后）并可重试，避免覆盖搜索框与分区标题。
  test("陈旧横幅落在文件内容区内并带重试锚点", () => {
    const html = renderTree({ stale: true });

    expect(html.indexOf('data-slot="file-tree-feedback"')).toBeGreaterThan(
      html.indexOf('data-slot="file-tree-sections"'),
    );
    expect(html).toContain('data-slot="file-tree-feedback-action"');
    expect(html).toContain(en.fileTree.staleBanner);
    expect(html).toContain(en.fileTree.retry);
  });

  // 迁移契约：样式只经工具类表达，旧修饰类名一律不得再出现在渲染结果中（保留即等于留了半套样式钩子）。
  test("渲染结果不再包含被删除的修饰性类名", () => {
    const html = renderTree();
    const leftovers = classNames(html).filter((name) => REMOVED_CLASSES.some((removed) => name.startsWith(removed)));

    expect(leftovers).toEqual([]);
  });

  // 「我的文件」分区高度只有工作区一半，空态靠父级传入的 className 压缩间距并隐去图标与说明行；
  // 这里验证父传子这条链路真的生效（原实现是靠父级选择器命中子组件根节点）。
  test("用户分区空态经 className 覆盖压缩间距", () => {
    const html = renderTree({ workspaceHasNodes: false, userHasNodes: false });
    const userFeedback = slotClass(html, "file-tree-feedback", 1);

    expect(userFeedback).toContain("min-h-11");
    expect(userFeedback).toContain("p-2");
    expect(userFeedback).not.toContain("p-5");
  });
});
