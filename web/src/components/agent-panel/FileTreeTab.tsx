import { useRequest } from "ahooks";
import { Download, Folder, FolderInput, FolderOpen, FolderTree, RefreshCw, Trash2, Upload } from "lucide-react";
import { forwardRef, type ReactNode, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { NodeState, TreeNodeData } from "@/components/ui/tree";
import { Tree } from "@/components/ui/tree";
import { fsApi } from "@/src/api/fs";
import { ApiError, unwrap } from "@/src/api/request";
import { FileTypeIcon } from "@/src/components/file-icon-helper";
import { NS } from "../../i18n";
import { buildPreviewUrl, encodePathSegment } from "./preview/utils";

interface FileTreeTabProps {
  envId: string | null;
  onPreviewFile: (path: string) => void;
  onReferenceFile: (path: string, name: string) => void;
}

// 扁平路径 → 层级结构解析
interface ParsedNode {
  name: string;
  path: string;
  isDir: boolean;
  children: ParsedNode[];
}

function parsePathsToTree(paths: string[]): ParsedNode[] {
  const root: ParsedNode[] = [];

  for (const rawPath of paths) {
    const isDir = rawPath.endsWith("/");
    const cleanPath = isDir ? rawPath.slice(0, -1) : rawPath;
    const parts = cleanPath.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const thisIsDir = isLast ? isDir : true;
      const thisPath = parts.slice(0, i + 1).join("/");

      let existing = current.find((n) => n.name === part);
      if (!existing) {
        existing = { name: part, path: thisPath, isDir: thisIsDir, children: [] };
        current.push(existing);
      }
      current = existing.children;
    }
  }

  // 排序：目录在前，文件在后，各自按名字排序
  const sortNodes = (nodes: ParsedNode[]): ParsedNode[] => {
    return nodes
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((n) => ({ ...n, children: sortNodes(n.children) }));
  };

  return sortNodes(root);
}

function parsedToTreeNodeData(node: ParsedNode): TreeNodeData {
  return {
    id: node.path,
    label: node.name,
    hasChildren: node.isDir && node.children.length > 0,
  };
}

/** 工具栏按钮：点击后压制 tooltip，鼠标真正离开再重新进入后才恢复 */
function ToolbarTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const suppressRef = useRef(false);

  return (
    <Tooltip
      open={open}
      onOpenChange={(v) => {
        if (suppressRef.current && v) return;
        setOpen(v);
      }}
    >
      <TooltipTrigger asChild>
        <span
          onPointerDown={() => {
            suppressRef.current = true;
            setOpen(false);
          }}
          onPointerEnter={() => {
            suppressRef.current = false;
          }}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export interface FileTreeTabHandle {
  uploadFiles: (files: File[], onProgress?: (percent: number) => void) => Promise<void>;
}

export const FileTreeTab = forwardRef<FileTreeTabHandle, FileTreeTabProps>(function FileTreeTab(
  { envId, onPreviewFile, onReferenceFile },
  ref,
) {
  const { t } = useTranslation(NS.COMPONENTS);
  const { t: tPanel } = useTranslation(NS.AGENT_PANEL);
  const treeDataRef = useRef<ParsedNode[]>([]);
  const [treeVersion, setTreeVersion] = useState(0);
  const [selectedDir, setSelectedDir] = useState<string | undefined>(undefined);
  const expandedIdsRef = useRef<Set<string>>(new Set());
  const [deleteConfirm, setDeleteConfirm] = useState<{ path: string; name: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // ── 文件树加载 ──
  const { loading, refresh: refreshTree } = useRequest(() => unwrap(fsApi.tree(envId!)), {
    ready: !!envId,
    onSuccess: (data) => {
      const paths = data?.paths ?? [];
      const mtimes = data?.mtimes ?? {};
      // 按文件修改时间倒序排列（最新上传的在前）
      const sorted = [...paths].sort((a, b) => (mtimes[b] ?? 0) - (mtimes[a] ?? 0));
      treeDataRef.current = parsePathsToTree(sorted);
      setTreeVersion((v) => v + 1);
    },
    onError: (err) => {
      console.error("Failed to load file tree:", err);
      treeDataRef.current = [];
      setTreeVersion((v) => v + 1);
    },
  });

  // ── 文件上传 ──
  const { run: runUpload, loading: uploading } = useRequest(
    (fd: FormData, targetDir?: string) => unwrap(fsApi.upload(envId!, fd, targetDir)),
    {
      manual: true,
      onSuccess: (data) => {
        toast.success(t("fileTree.uploadSuccess", { count: data.files?.length ?? 0 }));
        refreshTree();
      },
      onError: (err) => {
        if (err instanceof ApiError && (err as ApiError & { status?: number }).status === 413) {
          toast.error(t("filePicker.uploadTooLarge"));
        } else {
          toast.error(err.message || t("fileTree.uploadFailed"));
        }
      },
    },
  );

  // ── 重命名 ──
  const { run: runRename } = useRequest(
    (oldPath: string, newName: string) => {
      const parentDir = oldPath.includes("/") ? oldPath.substring(0, oldPath.lastIndexOf("/")) : "";
      const newPath = parentDir ? `${parentDir}/${newName}` : newName;
      return unwrap(fsApi.rename(envId!, oldPath, newPath));
    },
    {
      manual: true,
      onSuccess: () => refreshTree(),
      onError: (err) => console.error("Rename failed:", err),
    },
  );

  // ── 删除 ──
  const { run: runDelete } = useRequest((path: string) => unwrap(fsApi.batchDelete(envId!, [path])), {
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
  });

  // ── 创建目录 ──
  const { run: runMkdir } = useRequest((path: string) => unwrap(fsApi.mkdir(envId!, path)), {
    manual: true,
    onSuccess: () => refreshTree(),
    onError: (err) => console.error("Mkdir failed:", err),
  });

  // ── 创建新文件 ──
  const { run: runNewFile } = useRequest((path: string) => unwrap(fsApi.writeFile(envId!, path, "")), {
    manual: true,
    onSuccess: () => refreshTree(),
    onError: (err) => console.error("New file failed:", err),
  });

  useImperativeHandle(
    ref,
    () => ({
      uploadFiles: async (files: File[], onProgress?: (percent: number) => void) => {
        if (!envId || files.length === 0) return;

        // 客户端补齐总上传量校验（外部直接调 ref 方法时也需要）
        const maxSize = 100 * 1024 * 1024;
        const totalSize = files.reduce((sum, f) => sum + f.size, 0);
        if (totalSize > maxSize) {
          const sizeStr =
            totalSize > 1024 * 1024 * 1024
              ? `${(totalSize / (1024 * 1024 * 1024)).toFixed(1)} GB`
              : `${(totalSize / (1024 * 1024)).toFixed(1)} MB`;
          toast.error(t("filePicker.totalTooLarge", { total: sizeStr, max: "100MB" }));
          return;
        }

        const targetDir = selectedDir || "";
        const formData = new FormData();
        for (const file of files) {
          formData.append("files", file);
        }

        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          const url = targetDir ? `/web/environments/${envId}/fs/${targetDir}` : `/web/environments/${envId}/fs`;

          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable && onProgress) {
              onProgress(Math.round((e.loaded / e.total) * 100));
            }
          };

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve();
            } else {
              reject(new Error(`Upload failed: ${xhr.status}`));
            }
          };

          xhr.onerror = () => reject(new Error("Upload network error"));
          xhr.open("POST", url);
          xhr.withCredentials = true;
          xhr.send(formData);
        });

        refreshTree();
      },
    }),
    [envId, selectedDir, refreshTree, t],
  );

  // 从缓存的 ParsedNode 树中查找指定路径的子节点
  const findChildren = useCallback((parentPath: string | null): ParsedNode[] => {
    if (parentPath === null) return treeDataRef.current;

    const find = (nodes: ParsedNode[]): ParsedNode[] | null => {
      for (const node of nodes) {
        if (node.path === parentPath) return node.children;
        const found = find(node.children);
        if (found) return found;
      }
      return null;
    };

    return find(treeDataRef.current) ?? [];
  }, []);

  const getChildren = useCallback(
    async (parentId: string | null): Promise<TreeNodeData[]> => {
      const children = findChildren(parentId);
      return children.map(parsedToTreeNodeData);
    },
    [findChildren],
  );

  // treeVersion 变化时 Tree 重新挂载，通过 defaultExpandedIds 恢复展开状态
  const handleToggle = useCallback((nodeId: string, expanded: boolean) => {
    if (expanded) {
      expandedIdsRef.current.add(nodeId);
      // 展开目录时同步更新上传目标，使点击 chevron 和点击行展开行为一致
      const parsed = findNodeByPath(treeDataRef.current, nodeId);
      if (parsed?.isDir) {
        setSelectedDir(nodeId);
      }
    } else {
      expandedIdsRef.current.delete(nodeId);
    }
  }, []);

  /** 单击：目录选中，可预览文件触发预览，二进制文件忽略 */
  const handleSelect = useCallback(
    (nodeId: string | null, _node: TreeNodeData) => {
      if (!nodeId) return;
      const parsed = findNodeByPath(treeDataRef.current, nodeId);
      const isDir = parsed?.isDir ?? false;

      if (isDir) {
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
    const nodeId = nodeEl.querySelector("[data-node-id]")?.getAttribute("data-node-id");
    if (!nodeId) return;
    const node = findNodeByPath(treeDataRef.current, nodeId);
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
    (e: React.DragEvent) => {
      e.preventDefault();
      if (!envId || !e.dataTransfer) return;
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      // 客户端提前校验
      const maxSize = 100 * 1024 * 1024;
      for (const file of files) {
        if (file.size > maxSize) {
          toast.error(t("filePicker.fileTooLarge", { name: file.name, max: "100MB" }));
          return;
        }
      }

      // 校验总上传量
      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      if (totalSize > maxSize) {
        const sizeStr =
          totalSize > 1024 * 1024 * 1024
            ? `${(totalSize / (1024 * 1024 * 1024)).toFixed(1)} GB`
            : `${(totalSize / (1024 * 1024)).toFixed(1)} MB`;
        toast.error(t("filePicker.totalTooLarge", { total: sizeStr, max: "100MB" }));
        return;
      }

      const formData = new FormData();
      for (const file of files) {
        formData.append("files", file);
      }
      runUpload(formData, selectedDir);
    },
    [envId, runUpload, selectedDir, t],
  );

  // 按钮上传文件
  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // 按钮上传文件夹
  const handleFolderUploadClick = useCallback(() => {
    folderInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target?.files?.length) {
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }
      const files = Array.from(e.target.files);

      // 客户端提前校验单文件大小
      const maxSize = 100 * 1024 * 1024;
      for (const file of files) {
        if (file.size > maxSize) {
          toast.error(t("filePicker.fileTooLarge", { name: file.name, max: "100MB" }));
          if (fileInputRef.current) fileInputRef.current.value = "";
          return;
        }
      }

      // 校验总上传量
      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      if (totalSize > maxSize) {
        const sizeStr =
          totalSize > 1024 * 1024 * 1024
            ? `${(totalSize / (1024 * 1024 * 1024)).toFixed(1)} GB`
            : `${(totalSize / (1024 * 1024)).toFixed(1)} MB`;
        toast.error(t("filePicker.totalTooLarge", { total: sizeStr, max: "100MB" }));
        if (fileInputRef.current) fileInputRef.current.value = "";
        return;
      }

      const formData = new FormData();
      for (const file of files) {
        formData.append("files", file);
      }
      runUpload(formData, selectedDir);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [runUpload, selectedDir, t],
  );

  const handleFolderInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!e.target?.files?.length) {
        if (folderInputRef.current) folderInputRef.current.value = "";
        return;
      }
      const files = Array.from(e.target.files);

      // 客户端提前校验单文件大小
      const maxSize = 100 * 1024 * 1024;
      for (const file of files) {
        if (file.size > maxSize) {
          toast.error(t("filePicker.fileTooLarge", { name: file.name, max: "100MB" }));
          if (folderInputRef.current) folderInputRef.current.value = "";
          return;
        }
      }

      // 校验总上传量（文件夹上传最容易触发总量超限）
      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      if (totalSize > maxSize) {
        const sizeStr =
          totalSize > 1024 * 1024 * 1024
            ? `${(totalSize / (1024 * 1024 * 1024)).toFixed(1)} GB`
            : `${(totalSize / (1024 * 1024)).toFixed(1)} MB`;
        toast.error(t("filePicker.totalTooLarge", { total: sizeStr, max: "100MB" }));
        if (folderInputRef.current) folderInputRef.current.value = "";
        return;
      }

      // webkitRelativePath 保留了文件夹的相对路径结构
      const relativePaths = Array.from(files).map((f) => f.webkitRelativePath || f.name);
      const formData = new FormData();
      for (const file of files) {
        formData.append("files", file);
      }
      formData.append("relativePaths", JSON.stringify(relativePaths));
      runUpload(formData, selectedDir);
      if (folderInputRef.current) folderInputRef.current.value = "";
    },
    [runUpload, selectedDir, t],
  );

  // 下载：文件直接下载，目录打包为 zip
  // 使用 fetch + Blob 确保携带认证 cookie；<a download> 无法保证 credentials
  const handleDownload = useCallback(
    async (nodePath: string, isDir: boolean) => {
      if (!envId) return;
      try {
        let url: string;
        let fileName: string;

        if (isDir) {
          const dirName = nodePath.split("/").filter(Boolean).pop() || "download";
          url = `/web/environments/${envId}/fs/download-zip?path=${encodePathSegment(nodePath)}`;
          fileName = `${dirName}.zip`;
        } else {
          url = buildPreviewUrl(envId, nodePath);
          fileName = nodePath.split("/").pop() || "file";
        }

        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) {
          throw new Error(`Download failed: ${res.status}`);
        }
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      } catch {
        toast.error(t("fileTree.downloadFailed"));
      }
    },
    [envId, t],
  );

  // per-item 操作：下载 + 删除，hover 时显示
  const renderActions = useCallback(
    (node: TreeNodeData, _state: NodeState) => {
      const parsed = findNodeByPath(treeDataRef.current, node.id);
      const isDir = parsed?.isDir ?? false;

      return (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDownload(node.id, isDir);
                }}
                className="h-6 w-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary"
              >
                <Download className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{isDir ? t("fileTree.downloadZip") : t("fileTree.download")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteConfirm({ path: node.id, name: node.label });
                }}
                className="h-6 w-6 flex items-center justify-center rounded text-text-muted hover:text-status-error"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{t("fileTree.contextMenu.delete")}</TooltipContent>
          </Tooltip>
        </>
      );
    },
    [handleDownload, t],
  );

  // 自定义 label：目录用 Folder/FolderOpen 图标，文件用 react-file-icon 按扩展名渲染
  const renderLabel = useCallback((node: TreeNodeData, state: NodeState) => {
    const parsed = findNodeByPath(treeDataRef.current, node.id);
    const isDir = parsed?.isDir ?? false;

    // 目录保持 lucide 图标
    if (isDir) {
      const IconComp = state.expanded ? FolderOpen : Folder;
      return (
        <span className="flex items-center gap-1.5">
          <IconComp className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
          <span className="truncate" title={node.label}>
            {node.label}
          </span>
        </span>
      );
    }

    // 文件使用 react-file-icon 按扩展名显示不同图标
    // ml-6 补偿文件夹 chevron 占位，保持文件图标与文件夹图标左对齐
    return (
      <span className="flex items-center gap-1.5 ml-6">
        <span className="h-4 w-4 flex-shrink-0 inline-flex items-center justify-center">
          <FileTypeIcon filename={node.label ?? ""} />
        </span>
        <span className="truncate" title={node.label}>
          {node.label}
        </span>
      </span>
    );
  }, []);

  const isEmpty = !loading && treeDataRef.current.length === 0;

  return (
    <div className="flex-1 flex flex-col overflow-hidden h-full">
      {/* 标题栏 + 工具按钮合并为一行 */}
      <div className="flex items-center justify-between px-2 py-1.5 flex-shrink-0">
        <span className="text-base font-semibold text-text-primary flex items-center gap-1.5">
          <FolderTree className="h-4 w-4" />
          {tPanel("tabFiles")}
        </span>
        <div className="flex items-center gap-1">
          <ToolbarTip label={t("fileTree.refresh")}>
            <button
              type="button"
              onClick={refreshTree}
              disabled={loading || !envId}
              className="h-7 w-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          </ToolbarTip>
          <ToolbarTip label={t("fileTree.upload")}>
            <button
              type="button"
              onClick={handleUploadClick}
              disabled={uploading || !envId}
              className="h-7 w-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-50"
            >
              <Upload className="h-4 w-4" />
            </button>
          </ToolbarTip>
          <ToolbarTip label={t("fileTree.uploadFolder")}>
            <button
              type="button"
              onClick={handleFolderUploadClick}
              disabled={uploading || !envId}
              className="h-7 w-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-50"
            >
              <FolderInput className="h-4 w-4" />
            </button>
          </ToolbarTip>
          <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={handleFileInputChange} />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={handleFolderInputChange}
            // @ts-expect-error webkitdirectory is non-standard but widely supported
            webkitdirectory=""
            directory=""
          />
        </div>
      </div>

      {/* 文件树 */}
      <div
        className="flex-1 overflow-auto relative"
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onContextMenu={handleContextMenu}
      >
        {dragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-primary/10 border-2 border-dashed border-primary rounded-lg m-2 pointer-events-none">
            <span className="text-sm font-medium text-primary bg-surface-1 px-4 py-2 rounded-lg shadow">
              {t("fileTree.dropToUpload")}
            </span>
          </div>
        )}
        {!envId || isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 p-4">
            <Folder className="h-8 w-8 text-text-muted/40" />
            <p className="text-sm text-text-muted">{t("fileTree.emptyState")}</p>
            <p className="text-xs text-text-muted/60 text-center max-w-[200px]">{t("fileTree.emptyHint")}</p>
          </div>
        ) : (
          <Tree
            key={treeVersion}
            getChildren={getChildren}
            defaultExpandedIds={[...expandedIdsRef.current]}
            onSelect={handleSelect}
            onToggle={handleToggle}
            renderActions={renderActions}
            renderLabel={renderLabel}
          />
        )}
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          className="fixed rounded-lg border border-border bg-surface-1 p-1 shadow-lg min-w-[160px] z-50"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors text-text-primary hover:bg-surface-2"
            onClick={handleReference}
          >
            {t("fileTree.contextMenu.reference")}
          </button>
          {!contextMenu.isDir && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors text-text-primary hover:bg-surface-2"
              onClick={() => {
                const currentName = contextMenu.path.split("/").pop() ?? "";
                const newName = window.prompt(t("fileTree.contextMenu.rename"), currentName);
                if (!newName || newName === currentName) return;
                runRename(contextMenu.path, newName);
                setContextMenu(null);
              }}
            >
              {t("fileTree.contextMenu.rename")}
            </button>
          )}
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors text-status-error hover:bg-status-error/10"
            onClick={() => {
              setDeleteConfirm({
                path: contextMenu.path,
                name: contextMenu.path.split("/").pop() ?? contextMenu.path,
              });
              setContextMenu(null);
            }}
          >
            {t("fileTree.contextMenu.delete")}
          </button>
          {contextMenu.isDir && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors text-text-primary hover:bg-surface-2"
              onClick={() => {
                const name = window.prompt(t("fileTree.contextMenu.newFolderName"));
                if (!name) return;
                runMkdir(`${contextMenu.path}/${name}`);
                setContextMenu(null);
              }}
            >
              {t("fileTree.contextMenu.newFolder")}
            </button>
          )}
          {contextMenu.isDir && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors text-text-primary hover:bg-surface-2"
              onClick={() => {
                const name = window.prompt(t("fileTree.newFileName"));
                if (!name) return;
                runNewFile(`${contextMenu.path}/${name}`);
                setContextMenu(null);
              }}
            >
              {t("fileTree.newFile")}
            </button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={!!deleteConfirm}
        onOpenChange={(open) => {
          if (!open) setDeleteConfirm(null);
        }}
        title={t("fileTree.contextMenu.delete")}
        description={deleteConfirm?.name ?? ""}
        variant="destructive"
        onConfirm={() => deleteConfirm && runDelete(deleteConfirm.path)}
        confirmLabel={t("fileTree.contextMenu.delete")}
      />
    </div>
  );
});

// 辅助函数：在解析树中查找指定路径的节点
function findNodeByPath(nodes: ParsedNode[], path: string): ParsedNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    const found = findNodeByPath(node.children, path);
    if (found) return found;
  }
  return null;
}
