import type { TFunction } from "i18next";
import { type ChangeEvent, useCallback, useRef, useState } from "react";
import { buildUploadUrl, MAX_UPLOAD_SIZE_BYTES } from "@/src/api/fs";
import { UPLOAD_TIMEOUT_MS } from "@/src/api/request";
import { randomUUID } from "@/src/lib/utils";
import { appendUploadFileNames, MAX_FILE_UPLOAD_SIZE_LABEL } from "./file-tree-model";

interface UseFileUploadsOptions {
  envId: string | null;
  targetDir?: string;
  t: TFunction<"components">;
  onUploaded: () => void;
  onError: (message: string) => void;
}

function formatUploadSize(size: number): string {
  return size > 1024 * 1024 * 1024
    ? `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`
    : `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function validateFiles(files: File[], t: TFunction<"components">): string | null {
  const oversized = files.find((file) => file.size > MAX_UPLOAD_SIZE_BYTES);
  if (oversized) {
    return t("filePicker.fileTooLarge", { name: oversized.name, max: MAX_FILE_UPLOAD_SIZE_LABEL });
  }
  const total = files.reduce((sum, file) => sum + file.size, 0);
  return total > MAX_UPLOAD_SIZE_BYTES
    ? t("filePicker.totalTooLarge", {
        total: formatUploadSize(total),
        max: MAX_FILE_UPLOAD_SIZE_LABEL,
      })
    : null;
}

/**
 * 文件/文件夹上传的唯一前端入口。目标目录仍是 workspace 相对路径，服务端负责词法校验、
 * realpath 越界防护与权限判断；这里仅提供容量校验、进度和幂等 opId。
 */
export function useFileUploads({ envId, targetDir, t, onUploaded, onError }: UseFileUploadsOptions) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const uploadFiles = useCallback(
    async (files: File[], onProgress?: (percent: number) => void, relativePaths?: string[]) => {
      if (!envId || files.length === 0) return;
      const validationError = validateFiles(files, t);
      if (validationError) {
        onError(validationError);
        return;
      }

      const formData = new FormData();
      for (const file of files) formData.append("files", file);
      appendUploadFileNames(formData, files);
      if (relativePaths) formData.append("relativePaths", JSON.stringify(relativePaths));

      setUploading(true);
      try {
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
          };
          xhr.onload = () =>
            xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed: ${xhr.status}`));
          xhr.onerror = () => reject(new Error("Upload network error"));
          xhr.timeout = UPLOAD_TIMEOUT_MS;
          xhr.ontimeout = () => reject(new Error("Upload timeout"));
          xhr.open("POST", buildUploadUrl(envId, targetDir));
          xhr.withCredentials = true;
          xhr.setRequestHeader("x-file-op-id", randomUUID());
          xhr.send(formData);
        });
        onUploaded();
      } catch (error) {
        onError(error instanceof Error ? error.message : t("fileTree.uploadFailed"));
      } finally {
        setUploading(false);
      }
    },
    [envId, onError, onUploaded, t, targetDir],
  );

  const handleFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      void uploadFiles(files);
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
