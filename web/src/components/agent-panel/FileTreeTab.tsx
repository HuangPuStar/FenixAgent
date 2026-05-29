import { Download, File, FilePlus, Folder, FolderOpen, RefreshCw, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { NodeState, TreeNodeData } from "@/components/ui/tree";
import { Tree } from "@/components/ui/tree";
import { fileApi, userFileApi } from "@/src/api/sdk";
import { NS } from "../../i18n";

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

export function FileTreeTab({ envId, onPreviewFile, onReferenceFile }: FileTreeTabProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const treeDataRef = useRef<ParsedNode[]>([]);
  const [selectedDir, setSelectedDir] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadTree = useCallback(async () => {
    if (!envId) return;
    setLoading(true);
    const { data, error: err } = await userFileApi.tree({ id: envId });
    if (err) {
      console.error("Failed to load file tree:", err);
      treeDataRef.current = [];
    } else {
      const paths = data?.paths ?? [];
      treeDataRef.current = parsePathsToTree(paths);
    }
    setLoading(false);
    setRefreshKey((k) => k + 1);
  }, [envId]);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

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

  const handleSelect = useCallback(
    (nodeId: string | null, node: TreeNodeData) => {
      if (!nodeId) return;
      const parsed = findNodeByPath(treeDataRef.current, nodeId);
      if (parsed?.isDir) {
        setSelectedDir(nodeId);
      } else {
        const parentDir = nodeId.substring(0, nodeId.lastIndexOf("/"));
        setSelectedDir(parentDir || null);
        setSelectedFile(nodeId);
      }
      if (node.hasChildren === false || node.hasChildren === undefined) {
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

  const handleRename = useCallback(async () => {
    if (!contextMenu || !envId) return;
    const currentName = contextMenu.path.split("/").pop() ?? "";
    const newName = window.prompt(t("fileTree.contextMenu.rename"), currentName);
    if (!newName || newName === currentName) return;
    const parentDir = contextMenu.path.substring(0, contextMenu.path.lastIndexOf("/"));
    const newPath = parentDir ? `${parentDir}/${newName}` : newName;
    const { error: renameErr } = await userFileApi.rename({ id: envId }, { oldPath: contextMenu.path, newPath });
    if (renameErr) {
      console.error("Rename failed:", renameErr);
    } else {
      loadTree();
    }
    setContextMenu(null);
  }, [contextMenu, envId, loadTree, t]);

  const handleDelete = useCallback(async () => {
    if (!contextMenu || !envId) return;
    if (!window.confirm(`${t("fileTree.contextMenu.delete")}: ${contextMenu.path}?`)) return;
    const { error: deleteErr } = await userFileApi.batchDelete({ id: envId }, { paths: [contextMenu.path] });
    if (deleteErr) {
      console.error("Delete failed:", deleteErr);
    } else {
      loadTree();
    }
    setContextMenu(null);
  }, [contextMenu, envId, loadTree, t]);

  const handleNewFolder = useCallback(async () => {
    if (!contextMenu || !envId) return;
    const name = window.prompt(t("fileTree.contextMenu.newFolderName"));
    if (!name) return;
    const fullPath = `${contextMenu.path}/${name}`;
    const { error: mkdirErr } = await userFileApi.mkdir({ id: envId }, { path: fullPath });
    if (mkdirErr) {
      console.error("Mkdir failed:", mkdirErr);
    } else {
      loadTree();
    }
    setContextMenu(null);
  }, [contextMenu, envId, loadTree, t]);

  const handleReference = useCallback(() => {
    if (!contextMenu) return;
    const name = contextMenu.path.split("/").pop() || contextMenu.path;
    onReferenceFile(contextMenu.path, name);
    setContextMenu(null);
  }, [contextMenu, onReferenceFile]);

  // 拖拽上传
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      if (!envId) return;
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      const targetSubdir = selectedDir || "user";
      try {
        const formData = new FormData();
        for (const file of files) {
          formData.append("files", file);
        }
        await fileApi.upload({ id: envId, path: targetSubdir }, formData);
        toast.success(t("fileTree.uploadSuccess", { count: files.length }));
        await loadTree();
      } catch {
        toast.error(t("fileTree.uploadFailed"));
      }
    },
    [envId, selectedDir, loadTree, t],
  );

  // 按钮上传
  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!envId) return;
      const files = e.target.files;
      if (!files || files.length === 0) return;

      setUploading(true);
      try {
        const targetDir = selectedDir || "user";
        const formData = new FormData();
        for (const file of Array.from(files)) {
          formData.append("files", file);
        }
        const { error: uploadErr } = await fileApi.upload({ id: envId, path: targetDir }, formData);
        if (uploadErr) {
          toast.error(t("fileTree.uploadFailed"));
        } else {
          toast.success(t("fileTree.uploadSuccess", { count: files.length }));
          await loadTree();
        }
      } catch {
        toast.error(t("fileTree.uploadFailed"));
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [envId, selectedDir, loadTree, t],
  );

  // 下载
  const handleDownload = useCallback(async () => {
    if (!envId || !selectedFile) return;
    try {
      const url = `/web/environments/${envId}/user/${selectedFile}?preview=true`;
      const a = document.createElement("a");
      a.href = url;
      a.download = selectedFile.split("/").pop() || "file";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch {
      toast.error(t("fileTree.downloadFailed"));
    }
  }, [envId, selectedFile, t]);

  // 新建空文件
  const handleNewFile = useCallback(async () => {
    if (!envId) return;
    const name = window.prompt(t("fileTree.newFileName"));
    if (!name) return;
    const parentDir = selectedDir || "user";
    const fullPath = `${parentDir}/${name}`;
    const { error: writeErr } = await fileApi.writeFile({ id: envId, path: fullPath }, { content: "" });
    if (writeErr) {
      console.error("New file failed:", writeErr);
    } else {
      await loadTree();
    }
  }, [envId, selectedDir, loadTree, t]);

  // 自定义 label：目录用 FolderOpen 图标，文件用 File 图标（通过 icon prop 已处理）
  // 但目录展开时切换为 FolderOpen
  const renderLabel = useCallback((node: TreeNodeData, state: NodeState) => {
    // 查找节点判断是否为目录
    const parsed = findNodeByPath(treeDataRef.current, node.id);
    const isDir = parsed?.isDir ?? false;

    const IconComp = isDir ? (state.expanded ? FolderOpen : Folder) : File;

    return (
      <span className="flex items-center gap-1.5">
        <IconComp className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <span className="truncate">{node.label}</span>
      </span>
    );
  }, []);

  const isEmpty = !loading && treeDataRef.current.length === 0;

  return (
    <div className="flex-1 flex flex-col overflow-hidden h-full">
      {/* 工具栏 */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border flex-shrink-0">
        <button
          type="button"
          onClick={loadTree}
          disabled={loading || !envId}
          className="h-7 w-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-50"
          title={t("fileTree.refresh")}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
        <button
          type="button"
          onClick={handleUploadClick}
          disabled={uploading || !envId}
          className="h-7 w-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-50"
          title={t("fileTree.upload")}
        >
          <Upload className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={handleDownload}
          disabled={!selectedFile || !envId}
          className="h-7 w-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-50"
          title={t("fileTree.download")}
        >
          <Download className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={handleNewFile}
          disabled={!envId}
          className="h-7 w-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-50"
          title={t("fileTree.newFile")}
        >
          <FilePlus className="h-3.5 w-3.5" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={handleFileInputChange}
        />
      </div>

      {/* 文件树 */}
      <div
        className="flex-1 overflow-auto"
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onContextMenu={handleContextMenu}
      >
        {!envId || isEmpty ? (
          <div className="p-4 text-center text-sm text-text-muted">{t("fileTree.emptyState")}</div>
        ) : (
          <Tree key={refreshKey} getChildren={getChildren} onSelect={handleSelect} renderLabel={renderLabel} />
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
              onClick={handleRename}
            >
              {t("fileTree.contextMenu.rename")}
            </button>
          )}
          <button
            type="button"
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors text-status-error hover:bg-status-error/10"
            onClick={handleDelete}
          >
            {t("fileTree.contextMenu.delete")}
          </button>
          {contextMenu.isDir && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors text-text-primary hover:bg-surface-2"
              onClick={handleNewFolder}
            >
              {t("fileTree.contextMenu.newFolder")}
            </button>
          )}
          {contextMenu.isDir && (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors text-text-primary hover:bg-surface-2"
              onClick={() => {
                if (!envId) return;
                const name = window.prompt(t("fileTree.newFileName"));
                if (!name) return;
                const fullPath = `${contextMenu.path}/${name}`;
                fileApi.writeFile({ id: envId, path: fullPath }, { content: "" }).then(({ error: writeErr }) => {
                  if (writeErr) console.error("New file failed:", writeErr);
                  else loadTree();
                });
                setContextMenu(null);
              }}
            >
              {t("fileTree.newFile")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// 辅助函数：在解析树中查找指定路径的节点
function findNodeByPath(nodes: ParsedNode[], path: string): ParsedNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    const found = findNodeByPath(node.children, path);
    if (found) return found;
  }
  return null;
}
