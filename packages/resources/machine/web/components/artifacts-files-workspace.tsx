import type { ChangedFile } from "@fenix/ui-components/chat/lib/extract-changed-files";
import { PreviewTab } from "@fenix/ui-components/components/PreviewTab";
import { type RefObject, useCallback, useRef, useState } from "react";
import { buildPreviewSourceUrl, readPreviewSource } from "../api/fs";
import { useFileTreeLayout } from "../hooks/use-file-tree-layout";
import { FILE_TREE_DEFAULT_WIDTH, FILE_TREE_MIN_WIDTH } from "../lib/file-tree-layout";
import { FileTabsBar } from "./FileTabsBar";
import { FileTreeTab, type FileTreeTabHandle } from "./FileTreeTab";
import { FileTreeLayoutControls } from "./file-tree-layout-controls";
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
 * - 模式判定与持久化（`fenix:file-tree-layout`）：`useFileTreeLayout`，未手动选择时小屏浮动、大屏固定；
 * - 切换控件放进树的面板标题栏（`FileTreeTab` → `FileTreeView` 的 `headerActions` 槽），两种模式下都在同一处；
 * - 浮层开合是本地状态：浮动模式下关闭后由工作台左缘的常驻按钮重开。
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
  const { mode: treeLayout, toggleMode } = useFileTreeLayout();
  const [overlayOpen, setOverlayOpen] = useState(true);
  const initialFileTreeWidthRef = useRef(readFileTreeWidth());

  const handleTreeWidthChange = useCallback((width: number) => {
    try {
      localStorage.setItem("fenix:file-tree-width", String(width));
    } catch {
      // Width persistence is optional.
    }
  }, []);

  const openOverlay = useCallback(() => setOverlayOpen(true), []);
  const closeOverlay = useCallback(() => setOverlayOpen(false), []);

  return (
    <FileTreeWorkbench
      layout={treeLayout}
      initialTreeWidth={initialFileTreeWidthRef.current}
      onTreeWidthChange={handleTreeWidthChange}
      overlayOpen={overlayOpen}
      onOpenOverlay={openOverlay}
      tree={
        <FileTreeTab
          ref={fileTreeRef}
          envId={envId}
          onPreviewFile={onOpenFile}
          onReferenceFile={onReferenceFile}
          headerActions={
            <FileTreeLayoutControls
              mode={treeLayout}
              onToggleMode={toggleMode}
              // 只有「浮动且打开」时才有可关闭的浮层；固定模式下树是布局的一列。
              onCloseOverlay={treeLayout === "floating" && overlayOpen ? closeOverlay : undefined}
            />
          }
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
          {/* 预览源文件的 URL 与取数都注入自本包的 fs 客户端（§5.8：组件不拼后端 URL、不裸调 fetch）；
              预览 tab 内不再有全局 fetch 兜底，两个 prop 必须一起给。 */}
          <PreviewTab
            envId={envId}
            filePath={activeFile}
            buildPreviewUrl={buildPreviewSourceUrl}
            fetchPreview={readPreviewSource}
          />
        </>
      }
    />
  );
}
