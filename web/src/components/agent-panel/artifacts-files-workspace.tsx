import { type RefObject, useEffect, useRef } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import type { ChangedFile } from "../../lib/extract-changed-files";
import { FileTabsBar } from "./FileTabsBar";
import { FileTreeTab, type FileTreeTabHandle } from "./FileTreeTab";
import { PreviewTab } from "./PreviewTab";

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

/** Files mode keeps the explorer and preview in one VS Code-like workbench. */
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
    <>
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
            <div className="artifacts-explorer h-full min-h-0 flex flex-col overflow-hidden">
              <FileTreeTab
                ref={fileTreeRef}
                envId={envId}
                onPreviewFile={onOpenFile}
                onReferenceFile={onReferenceFile}
              />
            </div>
          </ResizablePanel>
          <ResizableHandle className="artifacts-workbench-divider" />
          <ResizablePanel minSize={`${PREVIEW_MIN_WIDTH}px`}>
            <div className="h-full min-h-0 min-w-0 flex flex-col">
              <PreviewTab envId={envId} filePath={activeFile} />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
      <FileTabsBar
        openFiles={openFiles}
        activeFile={activeFile}
        changedFiles={changedFiles}
        onSelectFile={onSelectFile}
        onCloseFile={onCloseFile}
        onPreviewChangedFile={onOpenFile}
      />
    </>
  );
}
