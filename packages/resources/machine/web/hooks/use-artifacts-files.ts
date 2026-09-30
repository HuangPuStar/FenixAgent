import type { ChangedFile } from "@fenix/ui-components/chat/lib/extract-changed-files";
import {
  ARTIFACTS_PREVIEW_FILE_EVENT,
  getArtifactsPreviewFileDetail,
} from "@fenix/web-runtime/lib/artifacts-preview-events";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { FileTreeTabHandle } from "../components/FileTreeTab";
import { MACHINE_NS } from "../i18n/namespace";
import { collectDroppedUpload, type DroppedUpload } from "../lib/dropped-files";
import { normalizeToUserPath } from "../lib/normalize-to-user-path";
import { useDragCounter } from "./use-drag-counter";

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
 *
 * 归属（2026-09-24，台账 `ce-standards-todo.md` D2）：由宿主
 * `apps/web/src/shell/artifacts/use-artifacts-files.ts` 迁入（该簇 2026-09-28 归位到
 * `apps/web/src/pages/agent-panel/artifacts/`，本文件不在其中）；它的三条依赖（路径规范化、拖拽计数、
 * 文件树容器的命令句柄）都在本包内，因此改相对导入。宿主侧的 `ArtifactsPanel` 仍持有模式态，
 * 经 `onEnterFilesMode` 回调注入（模式切换是面板壳的职责，不属于文件域）。
 */
export function useArtifactsFiles({
  envId,
  changedFiles = [],
  isFilesMode,
  onEnterFilesMode,
}: UseArtifactsFilesOptions) {
  const { t } = useTranslation(MACHINE_NS);
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
  const pendingUploadRef = useRef<DroppedUpload | null>(null);
  const dropGenerationRef = useRef(0);
  const dropEnvironmentRef = useRef(envId);
  dropEnvironmentRef.current = envId;
  useEffect(
    () => () => {
      if (dropEnvironmentRef.current === envId) dropEnvironmentRef.current = null;
      dropGenerationRef.current++;
      pendingUploadRef.current = null;
    },
    [envId],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      resetDragCounter();

      if (!e.dataTransfer) return;
      const generation = ++dropGenerationRef.current;
      void collectDroppedUpload(e.dataTransfer, () => "")
        .then((dropped) => {
          if (
            generation !== dropGenerationRef.current ||
            envId !== dropEnvironmentRef.current ||
            dropped.files.length === 0
          )
            return;
          setPendingDiffCount(0);
          if (fileTreeRef.current)
            void fileTreeRef.current.uploadFiles(dropped.files, undefined, dropped.relativePaths, dropped.targetDir);
          else {
            pendingUploadRef.current = dropped;
            enterFilesModeRef.current();
          }
        })
        .catch((error: unknown) => {
          console.error("Reading dropped artifact files failed:", error);
          if (generation === dropGenerationRef.current && envId === dropEnvironmentRef.current)
            toast.error(t("fileTree.uploadFailed"));
        });
    },
    [envId, resetDragCounter, t],
  );

  useEffect(() => {
    if (isFilesMode && pendingUploadRef.current) {
      const dropped = pendingUploadRef.current;
      pendingUploadRef.current = null;
      void fileTreeRef.current?.uploadFiles(dropped.files, undefined, dropped.relativePaths, dropped.targetDir);
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
