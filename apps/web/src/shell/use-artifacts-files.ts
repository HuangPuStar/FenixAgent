import type { ChangedFile } from "@fenix/ui-components/chat/lib/extract-changed-files";
import {
  ARTIFACTS_PREVIEW_FILE_EVENT,
  getArtifactsPreviewFileDetail,
} from "@fenix/web-runtime/lib/artifacts-preview-events";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDragCounter } from "@/src/hooks/use-drag-counter";
import type { FileTreeTabHandle } from "../components/agent-panel/FileTreeTab";
import { normalizeToUserPath } from "../components/agent-panel/preview/utils";

/** 打开文件 tab 的 LRU 上限：超出时丢弃最旧（数组末尾）的，与 FileTabsBar 的 MAX_VISIBLE_TABS 解耦 */
const MAX_OPEN_FILES = 8;

interface UseArtifactsFilesOptions {
  envId: string | null;
  changedFiles?: ChangedFile[];
  /** 当前是否停留在 Files 模式；离开 Files 后 diff 只累计角标，不打断当前浏览 */
  isFilesMode: boolean;
  /**
   * 切到 Files 模式（模式态仍归面板壳持有）。预览事件监听只注册一次（依赖 `[envId]`），
   * 实现须保持稳定引用；本 hook 内部再经 ref 读取。
   */
  onEnterFilesMode: () => void;
}

/**
 * 输出面板 Files 区的状态编排：打开的 tab（LRU）、diff 角标、拖拽上传、跨面板事件。
 *
 * 从 `ArtifactsPanel.tsx` 拆出（§4.7）。角标的累加开关原本是与 `topMode` 一一对应的独立 ref，
 * 这里改成由 `isFilesMode` 派生：进入 Files 即清零，只有离开 Files 时才累计（写入点与模式切换
 * 完全同步，行为不变，且不再需要壳把内部标记透传进来）。
 */
export function useArtifactsFiles({
  envId,
  changedFiles = [],
  isFilesMode,
  onEnterFilesMode,
}: UseArtifactsFilesOptions) {
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [pendingDiffCount, setPendingDiffCount] = useState(0);

  const openFile = useCallback((path: string) => {
    setOpenFiles((prev) => {
      const filtered = prev.filter((p) => p !== path);
      return [path, ...filtered].slice(0, MAX_OPEN_FILES);
    });
    setActiveFile(path);
  }, []);

  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;

  const enterFilesModeRef = useRef(onEnterFilesMode);
  enterFilesModeRef.current = onEnterFilesMode;

  // 预览事件：工具卡片的「预览」按钮 → 切到 Files 并打开对应文件
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = getArtifactsPreviewFileDetail(event, envId);
      if (!detail) return;
      setPendingDiffCount(0);
      enterFilesModeRef.current();
      openFileRef.current(normalizeToUserPath(detail.path));
    };
    window.addEventListener(ARTIFACTS_PREVIEW_FILE_EVENT, handler);
    return () => window.removeEventListener(ARTIFACTS_PREVIEW_FILE_EVENT, handler);
  }, [envId]);

  // 进入 Files 模式即清零角标（原实现写在模式切换处，含 agent 切换回 Files 的路径）
  useEffect(() => {
    if (isFilesMode) setPendingDiffCount(0);
  }, [isFilesMode]);

  const normalizedChangedFiles = useMemo<ChangedFile[]>(
    () => changedFiles.map((f) => ({ ...f, path: normalizeToUserPath(f.path) })),
    [changedFiles],
  );

  // changedFiles 变化时：仅统计增量并更新 pendingDiffCount 角标，
  // 不再自动打开文件 tab（文件预览改为用户手动点击工具卡片的预览按钮触发）
  const prevChangedPathsRef = useRef<string[]>([]);
  useEffect(() => {
    const paths = normalizedChangedFiles.map((f) => f.path);
    if (paths.length === 0) return;

    // 计算增量：只统计本次新增的文件，避免总数被累加放大
    const prevPaths = prevChangedPathsRef.current;
    const newPaths = paths.filter((p) => !prevPaths.includes(p));
    prevChangedPathsRef.current = paths;

    if (!isFilesMode && newPaths.length > 0) {
      setPendingDiffCount((n) => n + newPaths.length);
    }
  }, [normalizedChangedFiles, isFilesMode]);

  const handleCloseFile = useCallback((path: string) => {
    setOpenFiles((prev) => {
      const next = prev.filter((p) => p !== path);
      setActiveFile((cur) => {
        if (cur !== path) return cur;
        const closedIdx = prev.indexOf(path);
        const fallback = next[closedIdx] ?? next[closedIdx - 1] ?? null;
        return fallback ?? null;
      });
      return next;
    });
  }, []);

  const handleReferenceFile = useCallback(
    (path: string, name: string) => {
      window.dispatchEvent(
        new window.CustomEvent("file-tree:reference", {
          detail: { path, name, envId },
        }),
      );
    },
    [envId],
  );

  // 拖拽上传：进入/离开计数与遮罩态由 useDragCounter 统一维护（与文件树同一份实现）
  const { isDragging, handleDragEnter, handleDragOver, handleDragLeave, resetDragCounter } = useDragCounter();
  const fileTreeRef = useRef<FileTreeTabHandle>(null);
  const pendingUploadRef = useRef<File[]>([]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      resetDragCounter();

      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;

      setPendingDiffCount(0);

      if (isFilesMode) {
        // 已在 Files 模式：FileTreeTab 已挂载，直接上传
        fileTreeRef.current?.uploadFiles(files);
      } else {
        // 非 Files 模式：暂存文件，切到 Files 后由 useEffect 触发上传
        pendingUploadRef.current = files;
        enterFilesModeRef.current();
      }
    },
    [resetDragCounter, isFilesMode],
  );

  useEffect(() => {
    if (isFilesMode && pendingUploadRef.current.length > 0) {
      const files = pendingUploadRef.current;
      pendingUploadRef.current = [];
      fileTreeRef.current?.uploadFiles(files);
    }
  }, [isFilesMode]);

  return {
    openFiles,
    activeFile,
    setActiveFile,
    openFile,
    pendingDiffCount,
    normalizedChangedFiles,
    handleCloseFile,
    handleReferenceFile,
    isDragging,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    fileTreeRef,
  };
}
