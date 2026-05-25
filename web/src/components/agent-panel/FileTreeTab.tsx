import { FileTree, useFileTree, useFileTreeSelection } from "@pierre/trees/react";
import { Eye, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fileApi, userFileApi } from "@/src/api/sdk";
import { FileTreeContextMenu } from "./FileTreeContextMenu";

interface FileTreeTabProps {
  envId: string | null;
  onPreviewFile: (path: string) => void;
  onReferenceFile: (path: string, name: string) => void;
}

export function FileTreeTab({ envId, onPreviewFile, onReferenceFile }: FileTreeTabProps) {
  const { t } = useTranslation("components");
  const [loading, setLoading] = useState(false);
  const [hasPaths, setHasPaths] = useState(false);

  const { model } = useFileTree({
    paths: [],
    initialExpansion: "open",
    icons: "standard",
  });

  // 加载文件树
  const loadTree = useCallback(async () => {
    if (!envId) return;
    setLoading(true);
    const { data, error: err } = await userFileApi.tree({ id: envId });
    if (err) {
      console.error("Failed to load file tree:", err);
      setHasPaths(false);
    } else {
      const newPaths = data?.paths ?? [];
      setHasPaths(newPaths.length > 0);
      model.resetPaths(newPaths);
    }
    setLoading(false);
  }, [envId, model]);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  const selectedPaths = useFileTreeSelection(model);

  // 点击预览按钮
  const handlePreviewSelected = useCallback(() => {
    const filePath = selectedPaths.find((p) => !p.endsWith("/"));
    if (filePath) onPreviewFile(filePath);
  }, [selectedPaths, onPreviewFile]);

  // 右键菜单（通过 @pierre/trees 内置 contextMenu 机制）
  const handleRename = useCallback(
    async (path: string) => {
      const currentName = path.endsWith("/") ? path.slice(0, -1).split("/").pop() : path.split("/").pop();
      const newName = window.prompt(t("fileTree.contextMenu.rename"), currentName);
      if (!newName || newName === currentName) return;
      const parentDir = path.endsWith("/") ? path.slice(0, -1) : path.substring(0, path.lastIndexOf("/"));
      const newPath = parentDir ? `${parentDir}/${newName}` : newName;
      const { error: renameErr } = await userFileApi.rename({ id: envId! }, { oldPath: path, newPath });
      if (renameErr) {
        console.error("Rename failed:", renameErr);
      } else {
        await loadTree();
      }
    },
    [envId, loadTree, t],
  );

  const handleDelete = useCallback(
    async (path: string) => {
      if (!window.confirm(`${t("fileTree.contextMenu.delete")}: ${path}?`)) return;
      const { error: deleteErr } = await userFileApi.batchDelete({ id: envId! }, { paths: [path] });
      if (deleteErr) {
        console.error("Delete failed:", deleteErr);
      } else {
        await loadTree();
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
      const { error: mkdirErr } = await userFileApi.mkdir({ id: envId! }, { path: fullPath });
      if (mkdirErr) {
        console.error("Mkdir failed:", mkdirErr);
      } else {
        await loadTree();
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
        await fileApi.upload({ id: envId, path: targetSubdir.replace(/^user\/?/, "") }, formData);
        await loadTree();
      } catch (err) {
        console.error("Upload failed:", err);
      }
    },
    [envId, loadTree],
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden h-full">
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
        <button
          type="button"
          onClick={handlePreviewSelected}
          disabled={!selectedPaths.some((p) => !p.endsWith("/"))}
          className="h-7 w-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-50 ml-auto"
          title={t("fileTree.preview.title")}
        >
          <Eye className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 文件树 */}
      <div className="flex-1 overflow-hidden" onDragOver={handleDragOver} onDrop={handleDrop}>
        {!envId || (!loading && !hasPaths) ? (
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
