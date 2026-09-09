import { useRequest } from "ahooks";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { downloadWorkspacePath, fsApi } from "@/src/api/fs";
import { unwrap } from "@/src/api/request";
import { NS } from "../../i18n";
import { FileTreeInputDialog } from "./file-tree-input-dialog";
import {
  collectDirectoryPaths,
  filterFileTree,
  findFileNode,
  type ParsedFileNode,
  parsePathsToTree,
  splitFileTreeSections,
} from "./file-tree-model";
import { FileTreeView } from "./file-tree-view";
import { useFileTreeEvents } from "./use-file-tree-events";
import { useFileUploads } from "./use-file-uploads";

export function isValidFileTreeBasename(value: string) {
  const trimmed = value.trim();
  return !!trimmed && !trimmed.includes("\0") && !trimmed.includes("/") && trimmed !== "." && trimmed !== "..";
}

export function isValidFileTreeMovePath(value: string) {
  const trimmed = value.trim();
  return !!trimmed && !trimmed.includes("\0");
}

interface FileTreeTabProps {
  envId: string | null;
  onPreviewFile: (path: string) => void;
  onReferenceFile: (path: string, name: string) => void;
}

export interface FileTreeTabHandle {
  uploadFiles: (files: File[], onProgress?: (percent: number) => void) => Promise<void>;
}

export const FileTreeTab = forwardRef<FileTreeTabHandle, FileTreeTabProps>(function FileTreeTab(
  { envId, onPreviewFile, onReferenceFile },
  ref,
) {
  const { t } = useTranslation(NS.COMPONENTS);
  const treeDataRef = useRef<ParsedFileNode[]>([]);
  const [treeVersion, setTreeVersion] = useState(0);
  const [, setSelectedDir] = useState<string | undefined>(undefined);
  const [searchQuery, setSearchQuery] = useState("");
  const expandedIdsRef = useRef<Set<string>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = useState<{ path: string; name: string } | null>(null);
  const [inputDialog, setInputDialog] = useState<{
    kind: "rename" | "move" | "newFile" | "newFolder";
    path: string;
    value: string;
    error?: string;
  } | null>(null);
  // 加载失败时保留旧树并展示过期横幅（文件服务不可用 ≠ 空目录，docs/arch/12-files.md §7.3）
  const [stale, setStale] = useState(false);
  const [download, setDownload] = useState<{ path: string; isDir: boolean; error: boolean } | null>(null);
  const downloadControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // 环境变化时取消旧连接；读取 envId 保证 effect 与当前环境生命周期绑定。
    if (envId === null && downloadControllerRef.current === null) return;
    downloadControllerRef.current?.abort();
    downloadControllerRef.current = null;
    setDownload(null);
  }, [envId]);

  useEffect(() => () => downloadControllerRef.current?.abort(), []);

  // 用最新树数据替换当前树：加载/重校验共用，成功后同时清除过期横幅
  const applyTree = useCallback((paths: string[], mtimes?: Record<string, number>) => {
    // 按文件修改时间倒序排列（最新上传的在前）
    const sorted = [...paths].sort((a, b) => (mtimes?.[b] ?? 0) - (mtimes?.[a] ?? 0));
    treeDataRef.current = parsePathsToTree(sorted);
    setStale(false);
    setTreeVersion((v) => v + 1);
  }, []);

  // ── 文件树加载 ──
  const { loading, refresh: refreshTree } = useRequest(() => unwrap(fsApi.tree(envId!)), {
    ready: !!envId,
    onSuccess: (data) => {
      applyTree(data?.paths ?? [], data?.mtimes);
    },
    onError: (err) => {
      console.error("Failed to load file tree:", err);
      // 失败不清空旧树：断连/降级期间继续展示上次数据 + 过期横幅，禁止渲染为空目录
      setStale(true);
    },
  });

  const handleUploadError = useCallback((message: string) => toast.error(message), []);
  const uploadTargetRef = useRef<string | undefined>(undefined);
  const { fileInputRef, folderInputRef, uploading, uploadFiles, handleFileInputChange, handleFolderInputChange } =
    useFileUploads({
      envId,
      targetDir: undefined,
      getTargetDir: () => uploadTargetRef.current,
      t,
      onUploaded: refreshTree,
      onError: handleUploadError,
    });

  useImperativeHandle(ref, () => ({ uploadFiles }), [uploadFiles]);

  // ── 重命名 ──
  const { run: runRename, loading: renaming } = useRequest(
    (oldPath: string, newName: string) => {
      const parentDir = oldPath.includes("/") ? oldPath.substring(0, oldPath.lastIndexOf("/")) : "";
      const newPath = parentDir ? `${parentDir}/${newName}` : newName;
      return unwrap(fsApi.rename(envId!, oldPath, newPath));
    },
    {
      manual: true,
      onSuccess: () => {
        setInputDialog(null);
        refreshTree();
      },
      onError: (err) => {
        console.error("Rename failed:", err);
        toast.error(err.message || t("fileTree.renameFailed"));
      },
    },
  );

  // 移动使用完整目标路径；路径合法性、workspace 越界与 symlink 防护仍由服务端统一校验。
  const { run: runMove, loading: moving } = useRequest(
    (oldPath: string, newPath: string) => unwrap(fsApi.rename(envId!, oldPath, newPath)),
    {
      manual: true,
      onSuccess: () => {
        setInputDialog(null);
        refreshTree();
      },
      onError: (err) => {
        console.error("Move failed:", err);
        toast.error(err.message || t("fileTree.moveFailed"));
      },
    },
  );

  // ── 删除 ──
  const { run: runDelete, loading: deleting } = useRequest(
    (path: string) => unwrap(fsApi.batchDelete(envId!, [path])),
    {
      manual: true,
      onSuccess: (data) => {
        const failed = (data as { failed?: Array<{ path: string; error: string }> } | undefined)?.failed;
        if (failed && failed.length > 0) {
          toast.error(failed[0].error || t("fileTree.contextMenu.delete"));
          return;
        }
        setDeleteConfirm(null);
        refreshTree();
      },
      onError: (err) => {
        console.error("Delete failed:", err);
        toast.error(t("fileTree.contextMenu.delete"));
      },
    },
  );

  // ── 创建目录 ──
  const { run: runMkdir, loading: makingDirectory } = useRequest((path: string) => unwrap(fsApi.mkdir(envId!, path)), {
    manual: true,
    onSuccess: () => {
      setInputDialog(null);
      refreshTree();
    },
    onError: (err) => {
      console.error("Mkdir failed:", err);
      toast.error(err.message || t("fileTree.mkdirFailed"));
    },
  });

  // ── 创建新文件 ──
  const { run: runNewFile, loading: makingFile } = useRequest(
    (path: string) => unwrap(fsApi.writeFile(envId!, path, "")),
    {
      manual: true,
      onSuccess: () => {
        setInputDialog(null);
        refreshTree();
      },
      onError: (err) => {
        console.error("New file failed:", err);
        toast.error(err.message || t("fileTree.newFileFailed"));
      },
    },
  );

  const handleEventsUnavailable = useCallback((error: unknown) => {
    console.error("Failed to revalidate file tree:", error);
    setStale(true);
  }, []);

  useFileTreeEvents({ envId, applyTree, onUnavailable: handleEventsUnavailable });

  // 从缓存的 ParsedNode 树中查找指定路径的子节点
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const visibleTree = filterFileTree(treeDataRef.current, normalizedSearch);
  const visibleSections = splitFileTreeSections(visibleTree);

  // treeVersion 变化时 Arborist 重新挂载，通过 initialOpenState 恢复展开状态
  const handleToggle = useCallback((nodeId: string, expanded: boolean) => {
    if (expanded) {
      expandedIdsRef.current.add(nodeId);
      // 展开目录时同步更新上传目标，使点击 chevron 和点击行展开行为一致
      const parsed = findFileNode(treeDataRef.current, nodeId);
      if (parsed?.isDir) {
        setSelectedDir(nodeId);
      }
    } else {
      expandedIdsRef.current.delete(nodeId);
    }
  }, []);

  /** 单击：目录选中，可预览文件触发预览，二进制文件忽略 */
  const handleSelect = useCallback(
    (parsed: ParsedFileNode) => {
      const nodeId = parsed.path;
      if (parsed.isDir) {
        setSelectedDir(nodeId);
      } else {
        const parentDir = nodeId.substring(0, nodeId.lastIndexOf("/"));
        setSelectedDir(parentDir || undefined);
        // office/binary 忽略分类检查，统一交给 @open-file-viewer 插件链处理
        onPreviewFile(nodeId);
      }
    },
    [onPreviewFile],
  );

  // 右键菜单
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    path: string;
    isDir: boolean;
  } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const target = (e.target as HTMLElement).closest("[data-tree-item]");
    if (!target) return;
    const nodeEl = target as HTMLElement;
    const nodeId = nodeEl.getAttribute("data-node-id");
    if (!nodeId) return;
    const node = findFileNode(treeDataRef.current, nodeId);
    setContextMenu({ x: e.clientX, y: e.clientY, path: nodeId, isDir: node?.isDir ?? false });
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [contextMenu]);

  const handleReference = useCallback(() => {
    if (!contextMenu) return;
    const name = contextMenu.path.split("/").pop() || contextMenu.path;
    onReferenceFile(contextMenu.path, name);
    setContextMenu(null);
  }, [contextMenu, onReferenceFile]);

  // 拖拽上传
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (dragCounterRef.current === 1) setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, targetDir?: string) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setDragOver(false);
      if (!e.dataTransfer) return;
      const files = Array.from(e.dataTransfer.files);
      void uploadFiles(files, undefined, undefined, targetDir);
    },
    [uploadFiles],
  );

  const handleUploadClick = useCallback(
    (targetDir?: string) => {
      uploadTargetRef.current = targetDir;
      fileInputRef.current?.click();
    },
    [fileInputRef],
  );
  const handleFolderUploadClick = useCallback(
    (targetDir?: string) => {
      uploadTargetRef.current = targetDir;
      folderInputRef.current?.click();
    },
    [folderInputRef],
  );

  // 下载由 API 层统一构造 URL 和解析错误；新请求会取消旧请求，卸载时也会释放连接。
  const handleDownload = useCallback(
    async (nodePath: string, isDir: boolean) => {
      if (!envId) return;
      downloadControllerRef.current?.abort();
      const controller = new AbortController();
      downloadControllerRef.current = controller;
      setDownload({ path: nodePath, isDir, error: false });
      try {
        const blob = await downloadWorkspacePath(envId, nodePath, isDir, controller.signal);
        const blobUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        try {
          anchor.href = blobUrl;
          anchor.download = isDir
            ? `${nodePath.split("/").filter(Boolean).pop() || "download"}.zip`
            : nodePath.split("/").pop() || "file";
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
        toast.error(error instanceof Error && error.message ? error.message : t("fileTree.downloadFailed"));
      } finally {
        if (downloadControllerRef.current === controller) downloadControllerRef.current = null;
      }
    },
    [envId, t],
  );

  const isEmpty = !loading && treeDataRef.current.length === 0;
  const hasSearchResults = visibleSections.workspace.length > 0 || visibleSections.user.length > 0;
  const expandedIds = normalizedSearch ? collectDirectoryPaths(visibleTree) : [...expandedIdsRef.current];
  const showTree = !!envId && !(isEmpty && !stale);
  const isDirectory = useCallback((path: string) => findFileNode(treeDataRef.current, path)?.isDir ?? false, []);

  const openInputDialog = useCallback((kind: "rename" | "move" | "newFile" | "newFolder", path: string, value = "") => {
    setInputDialog({ kind, path, value });
    setContextMenu(null);
  }, []);

  const handleInputSubmit = useCallback(() => {
    if (!inputDialog) return;
    const value = inputDialog.value;
    const isBasename = inputDialog.kind !== "move";
    const invalid =
      value.trim().length === 0 || (isBasename ? !isValidFileTreeBasename(value) : !isValidFileTreeMovePath(value));
    if (invalid) {
      setInputDialog((current) =>
        current ? { ...current, error: t(`fileTree.dialog.${isBasename ? "invalidName" : "invalidPath"}`) } : null,
      );
      return;
    }

    if (inputDialog.kind === "rename") runRename(inputDialog.path, value);
    else if (inputDialog.kind === "move") runMove(inputDialog.path, value);
    else if (inputDialog.kind === "newFile") runNewFile(`${inputDialog.path}/${value}`);
    else runMkdir(`${inputDialog.path}/${value}`);
  }, [inputDialog, runMkdir, runMove, runNewFile, runRename, t]);

  const dialogKind = inputDialog?.kind;
  const dialogSubmitting = renaming || moving || makingFile || makingDirectory;
  const dialogTitle = dialogKind ? t(`fileTree.dialog.${dialogKind}Title`) : "";
  const dialogDescription = dialogKind ? t(`fileTree.dialog.${dialogKind}Description`) : "";

  return (
    <>
      <FileTreeView
        envId={envId}
        loading={loading && treeDataRef.current.length === 0}
        stale={stale}
        uploading={uploading}
        dragOver={dragOver}
        searchQuery={searchQuery}
        normalizedSearch={normalizedSearch}
        treeVersion={treeVersion}
        showTree={showTree}
        hasSearchResults={hasSearchResults}
        workspaceHasNodes={visibleSections.workspace.length > 0}
        userHasNodes={visibleSections.user.length > 0}
        expandedIds={expandedIds}
        workspaceNodes={visibleSections.workspace}
        userNodes={visibleSections.user}
        contextMenu={contextMenu}
        deleteConfirm={deleteConfirm}
        deleting={deleting}
        download={download}
        fileInputRef={fileInputRef}
        folderInputRef={folderInputRef}
        onSelect={handleSelect}
        onToggle={handleToggle}
        onSearchChange={setSearchQuery}
        onRefresh={refreshTree}
        onUploadClick={handleUploadClick}
        onFolderUploadClick={handleFolderUploadClick}
        onFileInputChange={handleFileInputChange}
        onFolderInputChange={handleFolderInputChange}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onContextMenu={handleContextMenu}
        isDirectory={isDirectory}
        onOpen={onPreviewFile}
        onReference={handleReference}
        onDownload={handleDownload}
        onRenameRequest={(path, name) => openInputDialog("rename", path, name)}
        onMoveRequest={(path) => openInputDialog("move", path, path)}
        onDeleteRequest={(path, name) => {
          setDeleteConfirm({ path, name });
          setContextMenu(null);
        }}
        onNewFile={(path) => openInputDialog("newFile", path)}
        onNewFolder={(path) => openInputDialog("newFolder", path)}
        onCloseDelete={() => setDeleteConfirm(null)}
        onConfirmDelete={() => deleteConfirm && runDelete(deleteConfirm.path)}
      />
      <FileTreeInputDialog
        open={inputDialog !== null}
        title={dialogTitle}
        description={dialogDescription}
        value={inputDialog?.value ?? ""}
        error={inputDialog?.error}
        submitting={dialogSubmitting}
        confirmLabel={t("fileTree.dialog.confirm")}
        cancelLabel={t("confirmDialog.cancel")}
        onValueChange={(value) =>
          setInputDialog((current) => (current ? { ...current, value, error: undefined } : null))
        }
        onOpenChange={(open) => !open && !dialogSubmitting && setInputDialog(null)}
        onSubmit={handleInputSubmit}
      />
    </>
  );
});
