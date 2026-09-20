import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { type ComposerFileInfo, getChatUploadPath, type UploadComposerFiles } from "./composer-file-processing";

/**
 * 处理操作系统文件拖入 → 上传 → 进度状态管理。
 *
 * 来源：复制自 `packages/agent-runtime/web/components/chat/useDragUpload.ts`。
 * 纯化改动点：
 * - `@/src/api/fs`（`uploadChatFiles` / `getChatUploadPath`）与 `envId` 改为注入的
 *   `uploadFiles` 回调；未注入时拖拽上传整体禁用（对应源实现 `if (!envId) return`）。
 * - 源上传结果缺失 `path` 时用 `getChatUploadPath(name)` 兜底的分支保留（该纯函数已随
 *   `composer-file-processing.ts` 内联进包内），只去掉对宿主 api 客户端的直接引用。
 * - 宿主 `FileInfo` 类型改为包内 `ComposerFileInfo`（字段结构一致）。
 */

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

export interface UseDragUploadOptions {
  /** 上传回调（宿主注入）；未提供时禁用拖拽上传 */
  uploadFiles?: UploadComposerFiles;
  /** 单文件上传成功后回调，传入文件引用（与文件选择器选中文件格式一致） */
  onUploaded: (file: ComposerFileInfo) => void;
  /** 上传失败时回调，传入错误信息和出错的文件名 */
  onError?: (message: string, fileName: string) => void;
  /** 禁用时跳过所有拖拽处理 */
  disabled?: boolean;
}

export interface UseDragUploadReturn {
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

export function useDragUpload({
  uploadFiles,
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
      if (!uploadFiles) return;

      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return;

      // 逐个文件上传
      const fileList = Array.from(files);
      for (const file of fileList) {
        // 跳过超大文件（源实现的提示文案是硬编码中文、没有 i18n key，此处逐字保留）
        if (file.size > MAX_FILE_SIZE) {
          console.warn(`[useDragUpload] 文件 ${file.name} 超过 100MB 限制，已跳过`);
          onError?.(`文件 ${file.name} 超过 100MB 限制，已跳过`, file.name);
          continue;
        }

        setUploadingCount((c) => c + 1);

        try {
          const uploaded = await uploadFiles([file]);
          const uploadedFile = uploaded[0];
          if (mountedRef.current) {
            // 服务端返回 workspace 相对路径（如 `user/foo.txt`），@./ 引用直接使用。
            onUploaded({
              name: uploadedFile?.name ?? file.name,
              path: uploadedFile?.path ?? getChatUploadPath(uploadedFile?.name ?? file.name),
              type: "file" as const,
              size: file.size,
              modifiedAt: Date.now(),
            });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : `文件 ${file.name} 上传失败`;
          onError?.(message, file.name);
        } finally {
          setUploadingCount((c) => c - 1);
        }
      }
    },
    [disabled, uploadFiles, onUploaded, onError],
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
