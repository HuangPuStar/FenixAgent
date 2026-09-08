import type { TFunction } from "i18next";
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { MAX_UPLOAD_BATCH_SIZE_BYTES, MAX_UPLOAD_SIZE_BYTES, uploadFiles as uploadWorkspaceFiles } from "@/src/api/fs";
import { MAX_FILE_UPLOAD_SIZE_LABEL } from "./file-tree-model";

interface UseFileUploadsOptions {
  envId: string | null;
  targetDir?: string;
  getTargetDir?: () => string | undefined;
  t: TFunction<"components">;
  onUploaded: () => void;
  onError: (message: string) => void;
}

function validateFiles(files: File[], t: TFunction<"components">): string | null {
  const oversized = files.find((file) => file.size > MAX_UPLOAD_SIZE_BYTES);
  if (oversized) {
    return t("filePicker.fileTooLarge", { name: oversized.name, max: MAX_FILE_UPLOAD_SIZE_LABEL });
  }
  return null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

interface UploadBatch {
  files: File[];
  relativePaths?: string[];
  size: number;
}

/** 按总字节数切分，保留 files 与 relativePaths 的索引对应关系。 */
export function createUploadBatches(files: File[], relativePaths?: string[]): UploadBatch[] {
  const batches: UploadBatch[] = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    const last = batches.at(-1);
    if (!last || (last.size > 0 && last.size + file.size > MAX_UPLOAD_BATCH_SIZE_BYTES)) {
      batches.push({
        files: [file],
        relativePaths: relativePaths ? [relativePaths[index] ?? file.name] : undefined,
        size: file.size,
      });
      continue;
    }
    last.files.push(file);
    last.relativePaths?.push(relativePaths?.[index] ?? file.name);
    last.size += file.size;
  }
  return batches;
}

/**
 * 文件/文件夹上传的唯一前端入口。目标目录仍是 workspace 相对路径，服务端负责词法校验、
 * realpath 越界防护与权限判断；这里仅提供容量校验、进度和幂等 opId。
 */
export function useFileUploads({ envId, targetDir, getTargetDir, t, onUploaded, onError }: UseFileUploadsOptions) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const uploadControllerRef = useRef<AbortController | null>(null);
  const envIdRef = useRef(envId);

  useEffect(() => {
    if (envIdRef.current !== envId) uploadControllerRef.current?.abort();
    envIdRef.current = envId;
  }, [envId]);
  useEffect(() => () => uploadControllerRef.current?.abort(), []);

  const uploadFiles = useCallback(
    async (
      files: File[],
      onProgress?: (percent: number) => void,
      relativePaths?: string[],
      targetDirOverride?: string,
    ) => {
      if (!envId || files.length === 0) return;
      const validationError = validateFiles(files, t);
      if (validationError) {
        onError(validationError);
        return;
      }

      const controller = new AbortController();
      uploadControllerRef.current?.abort();
      uploadControllerRef.current = controller;
      setUploading(true);
      try {
        const batches = createUploadBatches(files, relativePaths);
        const totalSize = Math.max(
          1,
          files.reduce((sum, file) => sum + file.size, 0),
        );
        let uploadedSize = 0;
        for (const batch of batches) {
          await uploadWorkspaceFiles(envId, batch.files, {
            targetDir: targetDirOverride ?? getTargetDir?.() ?? targetDir,
            relativePaths: batch.relativePaths,
            signal: controller.signal,
            onProgress: onProgress
              ? (percent) => onProgress(Math.round(((uploadedSize + (batch.size * percent) / 100) / totalSize) * 100))
              : undefined,
          });
          uploadedSize += batch.size;
        }
        if (envIdRef.current === envId) onUploaded();
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        const message = error instanceof Error ? error.message : t("fileTree.uploadFailed");
        onError(t("fileTree.uploadPartialIndeterminate", { message }));
        if (envIdRef.current === envId) onUploaded();
      } finally {
        if (uploadControllerRef.current === controller) {
          uploadControllerRef.current = null;
          setUploading(false);
        }
      }
    },
    [envId, getTargetDir, onError, onUploaded, t, targetDir],
  );

  const handleFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      void uploadFiles(files, undefined, undefined, undefined);
    },
    [uploadFiles],
  );

  const handleFolderInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      const relativePaths = files.map((file) => file.webkitRelativePath || file.name);
      event.target.value = "";
      void uploadFiles(files, undefined, relativePaths);
    },
    [uploadFiles],
  );

  return {
    fileInputRef,
    folderInputRef,
    uploading,
    uploadFiles,
    handleFileInputChange,
    handleFolderInputChange,
  };
}
