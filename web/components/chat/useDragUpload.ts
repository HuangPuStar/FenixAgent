import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { fileApi } from "../../src/api/files";
import type { FileInfo } from "../../src/types";

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

interface UseDragUploadOptions {
  /** 上传目标环境 ID */
  envId: string;
  /** 单文件上传成功后回调，传入 FileInfo（与 FilePickerPanel 选中文件格式一致） */
  onUploaded: (file: FileInfo) => void;
  /** 上传失败时回调，传入错误信息和出错的文件名 */
  onError?: (message: string, fileName: string) => void;
  /** 禁用时跳过所有拖拽处理 */
  disabled?: boolean;
}

interface UseDragUploadReturn {
  /** 是否有文件悬停在拖拽区域 */
  isDragOver: boolean;
  /** 是否有文件正在上传 */
  isUploading: boolean;
  /** 正在上传的文件数 */
  uploadingCount: number;
  handleDragOver: (e: DragEvent) => void;
  handleDragEnter: (e: DragEvent) => void;
  handleDragLeave: (e: DragEvent) => void;
  handleDrop: (e: DragEvent) => void;
}

/**
 * 处理操作系统文件拖入 → 上传 → 进度状态管理。
 * 上传行为与 FilePickerPanel 一致：走 fileApi.upload → workspace 目录。
 */
export function useDragUpload({
  envId,
  onUploaded,
  onError,
  disabled = false,
}: UseDragUploadOptions): UseDragUploadReturn {
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const dragCounterRef = useRef(0);
  const mountedRef = useRef(true);

  // 组件卸载标记，防止卸载后回调
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isUploading = uploadingCount > 0;

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragEnter = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      if (disabled) return;
      dragCounterRef.current += 1;
      if (dragCounterRef.current > 0) {
        setIsDragOver(true);
      }
    },
    [disabled],
  );

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    async (e: DragEvent) => {
      e.preventDefault();
      // 重置拖拽状态
      dragCounterRef.current = 0;
      setIsDragOver(false);

      if (disabled) return;
      if (!envId) return;

      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return;

      // 逐个文件上传
      const fileList = Array.from(files);
      for (const file of fileList) {
        // 跳过超大文件
        if (file.size > MAX_FILE_SIZE) {
          console.warn(`[useDragUpload] 文件 ${file.name} 超过 100MB 限制，已跳过`);
          onError?.(`文件 ${file.name} 超过 100MB 限制，已跳过`, file.name);
          continue;
        }

        setUploadingCount((c) => c + 1);

        const formData = new FormData();
        formData.append("files", file);
        const result = await fileApi.upload(envId, formData);
        console.log("[useDragUpload] 上传响应:", result);
        if (!result.success) {
          console.error(`[useDragUpload] 文件 ${file.name} 上传失败:`, result.error);
          onError?.(result.error?.message ?? `文件 ${file.name} 上传失败`, file.name);
        } else {
          // 优先取后端返回的文件信息，兜底用本地文件名构造路径
          const responseData = result.data as
            | { files?: Array<{ name: string; path: string; size: number }> }
            | undefined;
          const uploadedFile = responseData?.files?.[0];
          if (mountedRef.current) {
            // /fs 端点返回的是 workspace 相对路径，拖拽上传统一按 user/ 目录定位
            const name = uploadedFile?.name ?? file.name;
            const rawPath = uploadedFile?.path ?? name;
            const refPath = rawPath.startsWith("user/") ? rawPath : `user/${rawPath}`;
            console.log(`[useDragUpload] ${file.name} 上传成功, 回填路径: @./${refPath}`);
            onUploaded({
              name,
              path: refPath,
              type: "file" as const,
              size: uploadedFile?.size ?? file.size,
              modifiedAt: Date.now(),
            });
          }
        }
        setUploadingCount((c) => c - 1);
      }
    },
    [disabled, envId, onUploaded, onError],
  );

  return {
    isDragOver,
    isUploading,
    uploadingCount,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDrop,
  };
}
