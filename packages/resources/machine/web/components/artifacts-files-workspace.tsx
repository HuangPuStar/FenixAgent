import type { ChangedFile } from "@fenix/ui-components/chat/lib/extract-changed-files";
import { PreviewTab } from "@fenix/ui-components/components/PreviewTab";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@fenix/ui-components/ui/resizable";
import { type RefObject, useEffect, useRef } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { buildPreviewSourceUrl, readPreviewSource } from "../api/fs";
import { FileTabsBar } from "./FileTabsBar";
import { FileTreeTab, type FileTreeTabHandle } from "./FileTreeTab";

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

const FILE_TREE_MIN_WIDTH = 176;
const PREVIEW_MIN_WIDTH = 160;

function readFileTreeWidth(): number {
  try {
    const width = Number(localStorage.getItem("fenix:file-tree-width"));
    return Number.isFinite(width) && width >= FILE_TREE_MIN_WIDTH ? width : 184;
  } catch {
    return 184;
  }
}

/**
 * Files mode keeps the explorer and preview in one VS Code-like workbench.
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
  const initialFileTreeWidthRef = useRef(readFileTreeWidth());
  const panelGroupRef = useRef<HTMLDivElement>(null);
  const fileTreePanelRef = useRef<PanelImperativeHandle>(null);

  // react-resizable-panels v4 在父 Group 缩放时会按比例重算 layout，且该路径不会重新应用
  // panel 的 min/max 约束。外侧右栏变化后主动校正，确保文件树始终处于 176px..50%。
  useEffect(() => {
    const panelGroup = panelGroupRef.current;
    if (!panelGroup) return;

    let animationFrame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const panel = fileTreePanelRef.current;
        if (!panel) return;

        const groupWidth = panelGroup.clientWidth;
        const currentWidth = panel.getSize().inPixels;
        const maxWidth = groupWidth * 0.5;
        const nextWidth = Math.max(FILE_TREE_MIN_WIDTH, Math.min(currentWidth, maxWidth));
        if (Math.abs(currentWidth - nextWidth) >= 1) panel.resize(`${nextWidth}px`);
      });
    });
    observer.observe(panelGroup);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(animationFrame);
    };
  }, []);

  return (
    <div ref={panelGroupRef} className="flex-1 min-h-0 min-w-0">
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel
          panelRef={fileTreePanelRef}
          defaultSize={`${initialFileTreeWidthRef.current}px`}
          minSize={`${FILE_TREE_MIN_WIDTH}px`}
          maxSize="50%"
          groupResizeBehavior="preserve-pixel-size"
          onResize={(size) => {
            if (size.inPixels == null || !Number.isFinite(size.inPixels)) return;
            const width = Math.max(FILE_TREE_MIN_WIDTH, size.inPixels);
            try {
              localStorage.setItem("fenix:file-tree-width", String(width));
            } catch {
              // Width persistence is optional.
            }
          }}
        >
          {/* 文件树面板底色：原 `artifacts-files-workspace.css`（伴随表，2026-09-28 第四波随最后一条声明
              撤回而删除）里的 `background: #fbfcff`，按色阶口径归一到最近档 `slate-50`（#f8fafc，
              ΔE2000 = 0.94，肉眼不可辨；与 `--color-surface-0` 同值，取色阶类与同批其他页一致）。
              该表只剩这一条规则，故文件与 import 一并删除，`artifacts-explorer` 留作语义钩子。 */}
          <div className="artifacts-explorer h-full min-h-0 flex flex-col overflow-hidden bg-slate-50">
            <FileTreeTab ref={fileTreeRef} envId={envId} onPreviewFile={onOpenFile} onReferenceFile={onReferenceFile} />
          </div>
        </ResizablePanel>
        <ResizableHandle className="artifacts-workbench-divider bg-border-subtle" />
        <ResizablePanel minSize={`${PREVIEW_MIN_WIDTH}px`}>
          <div className="h-full min-h-0 min-w-0 flex flex-col">
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
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
