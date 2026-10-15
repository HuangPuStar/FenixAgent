import type { ChangedFile } from "@fenix/ui-components/chat/lib/extract-changed-files";
import { PreviewTab } from "@fenix/ui-components/components/PreviewTab";
import { type RefObject, useCallback, useRef, useState } from "react";
import { buildPreviewSourceUrl, readPreviewSource } from "../api/fs";
import { useFileTreeLayout } from "../hooks/use-file-tree-layout";
import { FILE_TREE_DEFAULT_WIDTH, FILE_TREE_MIN_WIDTH } from "../lib/file-tree-layout";
import { FileTabsBar } from "./FileTabsBar";
import { FileTreeTab, type FileTreeTabHandle } from "./FileTreeTab";
import { FileTreeLayoutToggle } from "./file-tree-layout-toggle";
import { FileTreeWorkbench } from "./file-tree-workbench";

interface ArtifactsFilesWorkspaceProps {
  envId: string | null;
  fileTreeRef: RefObject<FileTreeTabHandle | null>;
  openFiles: string[];
  activeFile: string | null;
  changedFiles: ChangedFile[];
  onSelectFile: (path: string) => void;
  onCloseFile: (path: string) => void;
  onOpenFile: (path: string) => void;
  onReferenceFile: (path: string, name: string) => void;
}

function readFileTreeWidth(): number {
  try {
    const width = Number(localStorage.getItem("fenix:file-tree-width"));
    return Number.isFinite(width) && width >= FILE_TREE_MIN_WIDTH ? width : FILE_TREE_DEFAULT_WIDTH;
  } catch {
    return FILE_TREE_DEFAULT_WIDTH;
  }
}

/**
 * Files mode keeps the explorer and preview in one VS Code-like workbench.
 *
 * 布局（2026-10-15）：文件树有「浮动 / 固定」两种模式，几何归 `FileTreeWorkbench`，本组件只做装配——
 * - 两种模式共用一棵 DOM（切模式不重建预览与树，见 `file-tree-workbench.tsx` 的说明）；
 * - 模式判定与持久化（`fenix:file-tree-layout`）：`useFileTreeLayout`，未手动选择时小屏浮动、大屏固定；
 * - 模式切换控件在树的面板标题栏（`FileTreeTab` → `FileTreeView` 的 `headerActions` 槽）；
 * - 浮动模式下树的显隐由预览区左缘的常驻切换按钮负责（工作台渲染），首屏在小屏默认收起。
 *
 * 归属（2026-09-24，台账 `ce-standards-todo.md` D2）：由宿主
 * `apps/web/src/shell/artifacts/artifacts-files-workspace.tsx` 迁入（该簇 2026-09-28 归位到
 * `apps/web/src/pages/agent-panel/artifacts/`，本文件不在其中），预览源的 URL 与取数改经同包
 * `api/fs.ts`（§5.8：组件不拼后端 URL、不裸调 fetch）。宿主 `ArtifactsPanel` 经
 * `@fenix/resource-machine/web` 消费本组件。
 */
export function ArtifactsFilesWorkspace({
  envId,
  fileTreeRef,
  openFiles,
  activeFile,
  changedFiles,
  onSelectFile,
  onCloseFile,
  onOpenFile,
  onReferenceFile,
}: ArtifactsFilesWorkspaceProps) {
  const { mode: treeLayout, isWideViewport, toggleMode } = useFileTreeLayout();
  // 首屏：小屏（<1024px）默认浮动 → 收起，只露切换按钮、内容区最大化；大屏维持「固定 + 展开」。
  // 用惰性初值而不是 effect：首帧就该是最终形态，否则会闪一下展开态。
  const [treeOpen, setTreeOpen] = useState(() => treeLayout === "docked" || isWideViewport);
  const initialFileTreeWidthRef = useRef(readFileTreeWidth());

  const overlayOpen = treeLayout === "floating" && treeOpen;

  const handleTreeWidthChange = useCallback((width: number) => {
    try {
      localStorage.setItem("fenix:file-tree-width", String(width));
    } catch {
      // Width persistence is optional.
    }
  }, []);

  const toggleTree = useCallback(() => setTreeOpen((open) => !open), []);
  const closeTree = useCallback(() => setTreeOpen(false), []);

  // 手选切模式后必须保持可见：从固定切到浮动却看不到树，等于点了没有反馈（用户逐条确认过）。
  const switchLayoutMode = useCallback(() => {
    setTreeOpen(true);
    toggleMode();
  }, [toggleMode]);

  return (
    <FileTreeWorkbench
      layout={treeLayout}
      initialTreeWidth={initialFileTreeWidthRef.current}
      onTreeWidthChange={handleTreeWidthChange}
      treeOpen={treeOpen}
      onToggleTree={toggleTree}
      tree={
        <FileTreeTab
          ref={fileTreeRef}
          envId={envId}
          onPreviewFile={onOpenFile}
          onReferenceFile={onReferenceFile}
          headerActions={<FileTreeLayoutToggle mode={treeLayout} onToggleMode={switchLayoutMode} />}
        />
      }
      preview={
        <>
          <FileTabsBar
            openFiles={openFiles}
            activeFile={activeFile}
            changedFiles={changedFiles}
            onSelectFile={onSelectFile}
            onCloseFile={onCloseFile}
            onPreviewChangedFile={onOpenFile}
          />
          {/* 点预览区收起浮层：遮罩只盖预览内容区（不含 tab 栏），既满足「点文件树以外区域收起」，
              又不至于让带浮层时连 tab 都点不动。不做 Esc 关闭、也不做选中文件后自动收起。 */}
          <div className="relative flex-1 min-h-0 min-w-0">
            {/* 预览源文件的 URL 与取数都注入自本包的 fs 客户端（§5.8：组件不拼后端 URL、不裸调 fetch）；
                预览 tab 内不再有全局 fetch 兜底，两个 prop 必须一起给。 */}
            <PreviewTab
              envId={envId}
              filePath={activeFile}
              buildPreviewUrl={buildPreviewSourceUrl}
              fetchPreview={readPreviewSource}
            />
            {overlayOpen && (
              <div data-slot="file-tree-overlay-backdrop" className="absolute inset-0 z-10" onClick={closeTree} />
            )}
          </div>
        </>
      }
    />
  );
}
