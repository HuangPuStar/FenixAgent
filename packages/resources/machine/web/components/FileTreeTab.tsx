import {
  collectDirectoryPaths,
  filterFileTree,
  getVisibleFileTreePaths,
  type ParsedFileNode,
  parsePathsToTree,
  splitFileTreeSections,
} from "@fenix/ui-components/components/file-tree-model";
import { FileTreeView } from "@fenix/ui-components/components/file-tree-view";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { downloadWorkspacePath, fsApi } from "../api/fs";
import { useFileTreeEvents } from "../hooks/use-file-tree-events";
import { useFileTreeInputDialog } from "../hooks/use-file-tree-input-dialog";
import { useFileTreeInteractions } from "../hooks/use-file-tree-interactions";
import { useFileTreeOperations } from "../hooks/use-file-tree-operations";
import { useFileUploads } from "../hooks/use-file-uploads";
import { MACHINE_NS } from "../i18n/namespace";
import type { WorkspaceFilesChange } from "../lib/workspace-file-operations";

/** 上传落点在 user 作用域时归「我的文件」，其余归工作区。 */
export function resolveUploadSection(targetDir: string): "workspace" | "user" {
  const normalized = targetDir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return normalized === "user" || normalized.startsWith("user/") ? "user" : "workspace";
}

interface FileTreeTabProps {
  envId: string | null;
  onPreviewFile: (path: string) => void;
  onReferenceFile: (path: string, name: string) => void;
  onFilesChanged: (change: WorkspaceFilesChange) => void;
  headerActions?: ReactNode;
}

/** 文件树装配：读取与事件、上传、交互和写操作分别由各自 hook 管理。 */
export function FileTreeTab({
  envId,
  onPreviewFile,
  onReferenceFile,
  onFilesChanged,
  headerActions,
}: FileTreeTabProps) {
  const { t } = useTranslation(MACHINE_NS);
  const treeDataRef = useRef<ParsedFileNode[]>([]);
  const [treeVersion, setTreeVersion] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const searchQueryRef = useRef(searchQuery);
  searchQueryRef.current = searchQuery;
  const [expandedPaths, setExpandedPaths] = useState<string[]>([]);
  const [searchExpandedPaths, setSearchExpandedPaths] = useState<string[]>([]);
  const [stale, setStale] = useState(false);
  const [download, setDownload] = useState<{ path: string; isDir: boolean; error: boolean } | null>(null);
  const downloadControllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => downloadControllerRef.current?.abort(), []);

  const applyTree = useCallback((paths: string[], mtimes?: Record<string, number>) => {
    const sorted = [...paths].sort((a, b) => (mtimes?.[b] ?? 0) - (mtimes?.[a] ?? 0));
    treeDataRef.current = parsePathsToTree(sorted);
    const search = searchQueryRef.current.trim().toLocaleLowerCase();
    if (search) setSearchExpandedPaths(collectDirectoryPaths(filterFileTree(treeDataRef.current, search)));
    setStale(false);
    setTreeVersion((version) => version + 1);
  }, []);

  const { loading, refresh: refreshTree } = useRequest(() => unwrap(fsApi.tree(envId!)), {
    ready: !!envId,
    refreshDeps: [envId],
    onSuccess: (data) => applyTree(data?.paths ?? [], data?.mtimes),
    onError: (error) => {
      console.error("Failed to load file tree:", error);
      setStale(true);
    },
  });
  const handleEventsUnavailable = useCallback((error: unknown) => {
    console.error("Failed to revalidate file tree:", error);
    setStale(true);
  }, []);
  useFileTreeEvents({ envId, applyTree, onUnavailable: handleEventsUnavailable });

  const uploadTargetRef = useRef<string | undefined>(undefined);
  const handleUploadError = useCallback((message: string) => toast.error(message), []);
  const uploads = useFileUploads({
    envId,
    targetDir: undefined,
    getTargetDir: () => uploadTargetRef.current,
    onUploaded: refreshTree,
    onError: handleUploadError,
  });
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const visibleTree = filterFileTree(treeDataRef.current, normalizedSearch);
  const sections = splitFileTreeSections(visibleTree);
  const expandedIds = normalizedSearch ? searchExpandedPaths : expandedPaths;
  const visiblePaths = [
    ...getVisibleFileTreePaths(sections.workspace, expandedIds),
    ...getVisibleFileTreePaths(sections.user, expandedIds),
  ];

  const operations = useFileTreeOperations({
    envId,
    enabled: !stale,
    getTree: () => treeDataRef.current,
    onChanged: onFilesChanged,
    onSelectionChange: (paths) => interactions.setSelectedPaths(paths),
    refreshTree,
  });
  const interactions = useFileTreeInteractions({
    envId,
    searchQuery,
    treeVersion,
    getTree: () => treeDataRef.current,
    visiblePaths,
    enabled: !!envId && !stale && !operations.busy,
    onPreviewFile,
    moveToDirectory: operations.moveToDirectory,
    uploadDroppedFiles: uploads.uploadDroppedFiles,
  });
  const input = useFileTreeInputDialog(operations, interactions.closeContextMenu);

  function handleSearchChange(query: string) {
    setSearchQuery(query);
    setSearchExpandedPaths(
      collectDirectoryPaths(filterFileTree(treeDataRef.current, query.trim().toLocaleLowerCase())),
    );
  }
  function handleToggle(path: string, expanded: boolean) {
    const update = (paths: string[]) =>
      expanded ? (paths.includes(path) ? paths : [...paths, path]) : paths.filter((item) => item !== path);
    if (normalizedSearch) setSearchExpandedPaths(update);
    else setExpandedPaths(update);
  }
  function handleReference() {
    const menu = interactions.contextMenu;
    if (!menu) return;
    onReferenceFile(menu.path, menu.path.split("/").pop() ?? menu.path);
    interactions.closeContextMenu();
  }

  const handleDownload = useCallback(
    async (nodePath: string, isDir: boolean) => {
      if (!envId) return;
      downloadControllerRef.current?.abort();
      const controller = new AbortController();
      downloadControllerRef.current = controller;
      setDownload({ path: nodePath, isDir, error: false });
      try {
        const blob = await downloadWorkspacePath(envId, nodePath, isDir, controller.signal);
        if (controller.signal.aborted) return;
        const blobUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        try {
          anchor.href = blobUrl;
          anchor.download = isDir
            ? `${nodePath.split("/").filter(Boolean).pop() ?? "download"}.zip`
            : (nodePath.split("/").pop() ?? "file");
          document.body.appendChild(anchor);
          anchor.click();
        } finally {
          anchor.remove();
          URL.revokeObjectURL(blobUrl);
        }
        setDownload(null);
      } catch (error) {
        if (controller.signal.aborted) return;
        setDownload({ path: nodePath, isDir, error: true });
        console.error("Download failed:", error);
        toast.error(error instanceof Error && error.message ? error.message : t("fileTree.downloadFailed"));
      } finally {
        if (downloadControllerRef.current === controller) downloadControllerRef.current = null;
      }
    },
    [envId, t],
  );

  const isEmpty = !loading && treeDataRef.current.length === 0;
  return (
    <>
      <FileTreeView
        canMutate={!!envId && !stale && !operations.busy}
        headerActions={headerActions}
        loading={loading && treeDataRef.current.length === 0}
        stale={stale}
        uploading={uploads.uploading}
        uploadProgress={uploads.uploadProgress?.percent}
        uploadSaving={uploads.uploadProgress?.saving}
        uploadSection={uploads.uploadProgress ? resolveUploadSection(uploads.uploadProgress.targetDir) : undefined}
        dragOver={interactions.dragOver}
        dropTarget={interactions.dropTarget}
        selectedPaths={interactions.selectedPaths}
        searchQuery={searchQuery}
        normalizedSearch={normalizedSearch}
        treeVersion={treeVersion}
        showTree={!!envId && !(isEmpty && !stale)}
        hasSearchResults={sections.workspace.length > 0 || sections.user.length > 0}
        workspaceHasNodes={sections.workspace.length > 0}
        userHasNodes={sections.user.length > 0}
        expandedIds={expandedIds}
        workspaceNodes={sections.workspace}
        userNodes={sections.user}
        contextMenu={interactions.contextMenu}
        deleteConfirm={operations.deleteConfirm}
        deleting={operations.deleting}
        download={download}
        fileInputRef={uploads.fileInputRef}
        folderInputRef={uploads.folderInputRef}
        onSelect={interactions.handleSelect}
        onSelectionChange={interactions.setSelectedPaths}
        onClearSelection={interactions.clearSelection}
        onToggle={handleToggle}
        onSearchChange={handleSearchChange}
        onRefresh={refreshTree}
        onUploadClick={(target) => {
          uploadTargetRef.current = target;
          uploads.fileInputRef.current?.click();
        }}
        onFolderUploadClick={(target) => {
          uploadTargetRef.current = target;
          uploads.folderInputRef.current?.click();
        }}
        onFileInputChange={uploads.handleFileInputChange}
        onFolderInputChange={uploads.handleFolderInputChange}
        onDragStart={interactions.handleDragStart}
        onDragEnd={interactions.handleDragEnd}
        onDragOver={interactions.handleDragOver}
        onDragEnter={interactions.handleDragEnter}
        onDragLeave={interactions.handleDragLeave}
        onDrop={interactions.handleDrop}
        onContextMenu={interactions.handleContextMenu}
        onReference={handleReference}
        onDownload={handleDownload}
        onRenameRequest={(path, name) => input.open("rename", path, name)}
        onMoveRequest={(path) => input.open("move", path, path)}
        onDeleteRequest={(path) => {
          operations.requestDelete(interactions.contextMenu?.paths ?? [path]);
          interactions.closeContextMenu();
        }}
        onNewFile={(path) => input.open("newFile", path)}
        onNewFolder={(path) => input.open("newFolder", path)}
        onCloseDelete={operations.closeDelete}
        onConfirmDelete={() => {
          void operations.confirmDelete();
        }}
      />
      {input.dialog}
    </>
  );
}
