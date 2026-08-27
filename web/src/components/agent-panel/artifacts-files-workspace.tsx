import { type RefObject, useState } from "react";
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

function readFileTreeWidth(): number {
  try {
    const width = Number(localStorage.getItem("fenix:file-tree-width"));
    return Number.isFinite(width) && width >= 176 && width <= 220 ? width : 184;
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
  const [fileTreeWidth, setFileTreeWidth] = useState(readFileTreeWidth);
  return (
    <>
      <FileTabsBar
        openFiles={openFiles}
        activeFile={activeFile}
        changedFiles={changedFiles}
        onSelectFile={onSelectFile}
        onCloseFile={onCloseFile}
        onPreviewChangedFile={onOpenFile}
      />
      <div className="flex-1 min-h-0 min-w-0">
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel
            defaultSize={fileTreeWidth}
            minSize={176}
            maxSize={220}
            groupResizeBehavior="preserve-pixel-size"
            onResize={(size) => {
              if (size.inPixels == null || !Number.isFinite(size.inPixels)) return;
              setFileTreeWidth(size.inPixels);
              try {
                localStorage.setItem("fenix:file-tree-width", String(size.inPixels));
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
          <ResizablePanel defaultSize={70} minSize={36}>
            <div className="h-full min-h-0 min-w-0 flex flex-col">
              <PreviewTab envId={envId} filePath={activeFile} />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </>
  );
}
