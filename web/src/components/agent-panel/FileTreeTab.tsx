import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, Search } from "lucide-react";
import { FileTree, useFileTree, useFileTreeSearch } from "@pierre/trees/react";
import { fetchUpload } from "../../api/client";
import { FileTreeContextMenu } from "./FileTreeContextMenu";

interface FileTreeTabProps {
  envId: string | null;
  onPreviewFile: (path: string) => void;
  onReferenceFile: (path: string, name: string) => void;
}

export function FileTreeTab({ envId, onPreviewFile, onReferenceFile }: FileTreeTabProps) {
  const { t } = useTranslation("components");
  const [paths, setPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const { model } = useFileTree({
    paths,
    search: true,
    fileTreeSearchMode: "hide-non-matches",
    initialExpandedPaths: [],
    icons: "standard",
  });

  const search = useFileTreeSearch(model);

  // 加载文件树
  const loadTree = useCallback(async () => {
    if (!envId) return;
    setLoading(true);
    try {
      const res = await fetch(`/web/environments/${envId}/user-file/tree`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const newPaths = data.paths ?? [];
      setPaths(newPaths);
      model.resetPaths(newPaths);
    } catch (err) {
      console.error("Failed to load file tree:", err);
    } finally {
      setLoading(false);
    }
  }, [envId, model]);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  // 双击 → 预览
  const handleDoubleClick = useCallback(
    (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const row = target.closest('[data-path]');
      if (!row) return;
      const path = row.getAttribute("data-path");
      if (!path || path.endsWith("/")) return;
      onPreviewFile(path);
    },
    [onPreviewFile],
  );

  useEffect(() => {
    const host = model.getFileTreeContainer();
    if (!host) return;
    host.addEventListener("dblclick", handleDoubleClick);
    return () => host.removeEventListener("dblclick", handleDoubleClick);
  }, [model, handleDoubleClick]);

  // 右键菜单（通过 @pierre/trees 内置 contextMenu 机制）
  const handleRename = useCallback(
    async (path: string) => {
      const currentName = path.endsWith("/") ? path.slice(0, -1).split("/").pop() : path.split("/").pop();
      const newName = window.prompt(t("fileTree.contextMenu.rename"), currentName);
      if (!newName || newName === currentName) return;
      const parentDir = path.endsWith("/")
        ? path.slice(0, -1)
        : path.substring(0, path.lastIndexOf("/"));
      const newPath = parentDir ? `${parentDir}/${newName}` : newName;
      try {
        const res = await fetch(`/web/environments/${envId}/user-file/rename`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ oldPath: path, newPath }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadTree();
      } catch (err) {
        console.error("Rename failed:", err);
      }
    },
    [envId, loadTree, t],
  );

  const handleDelete = useCallback(
    async (path: string) => {
      if (!window.confirm(`${t("fileTree.contextMenu.delete")}: ${path}?`)) return;
      try {
        const res = await fetch(`/web/environments/${envId}/user-file/batch`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ paths: [path] }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadTree();
      } catch (err) {
        console.error("Delete failed:", err);
      }
    },
    [envId, loadTree, t],
  );

  const handleNewFolder = useCallback(
    async (parentPath: string) => {
      const name = window.prompt(t("fileTree.contextMenu.newFolderName"));
      if (!name) return;
      const cleanParent = parentPath.endsWith("/") ? parentPath.slice(0, -1) : parentPath;
      const fullPath = cleanParent ? `${cleanParent}/${name}` : name;
      try {
        const res = await fetch(`/web/environments/${envId}/user-file/mkdir`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ path: fullPath }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadTree();
      } catch (err) {
        console.error("Mkdir failed:", err);
      }
    },
    [envId, loadTree, t],
  );

  const handleReference = useCallback(
    (path: string) => {
      const name = path.split("/").pop() || path;
      const cleanPath = path.endsWith("/") ? path.slice(0, -1) : path;
      onReferenceFile(cleanPath, name);
    },
    [onReferenceFile],
  );

  // 拖拽上传（从系统拖文件到树上）
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

      // 拖拽的目标目录（默认 user 根）
      let targetSubdir = "user";
      const dataTransfer = e.dataTransfer;
      // 检查是否有 @pierre/trees 拖拽的路径数据
      const treePath = dataTransfer.getData("application/pierre-tree-path");
      if (treePath) {
        const dirPath = treePath.endsWith("/") ? treePath : `${treePath}/`;
        targetSubdir = `user/${dirPath}`;
      }

      try {
        const formData = new FormData();
        for (const file of files) {
          formData.append("files", file);
        }
        await fetchUpload(
          `/web/environments/${envId}/user/${targetSubdir.replace(/^user\/?/, "")}`,
          formData,
        );
        await loadTree();
      } catch (err) {
        console.error("Upload failed:", err);
      }
    },
    [envId, loadTree],
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border flex-shrink-0">
        <button
          type="button"
          onClick={loadTree}
          disabled={loading || !envId}
          className="h-7 w-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-50"
          title={t("fileTree.refresh")}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
        <div className="flex-1 relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-muted pointer-events-none" />
          <input
            value={search.value}
            onChange={(e) => search.setValue(e.target.value)}
            placeholder={t("filePicker.searchPlaceholder")}
            className="w-full h-7 pl-7 pr-2 rounded-md border border-border bg-surface-2 text-xs text-text-primary placeholder:text-text-muted outline-none focus:border-brand/50"
          />
        </div>
      </div>

      {/* 文件树 */}
      <div
        className="flex-1 overflow-hidden"
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {!envId || (paths.length === 0 && !loading) ? (
          <div className="p-4 text-center text-sm text-text-muted">{t("fileTree.emptyState")}</div>
        ) : (
          <FileTree
            model={model}
            className="h-full w-full"
            renderContextMenu={(item, context) => (
              <FileTreeContextMenu
                item={item}
                context={context}
                onRename={handleRename}
                onDelete={handleDelete}
                onNewFolder={handleNewFolder}
                onReference={handleReference}
              />
            )}
          />
        )}
      </div>
    </div>
  );
}
