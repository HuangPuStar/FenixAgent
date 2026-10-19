import type { TFunction } from "i18next";
import { type ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MAX_UPLOAD_BATCH_SIZE_BYTES, MAX_UPLOAD_SIZE_BYTES, uploadFiles as uploadWorkspaceFiles } from "../api/fs";
import { MACHINE_NS } from "../i18n/namespace";
import { collectDroppedUpload } from "../lib/dropped-files";
import { getFileOperationErrorMessage } from "../lib/file-operation-errors";

/**
 * workspace 文件上传的唯一前端入口（容量校验、按字节分批、进度、幂等 opId）。
 *
 * 归属：随文件域客户端一起落 `@fenix/resource-machine`（台账 `ce-standards-todo.md` D2，2026-09-24
 * 由宿主 `apps/web/src/shell/artifacts/use-file-uploads.ts` 迁入，该簇 2026-09-28 归位到
 * `apps/web/src/pages/agent-panel/artifacts/`、本文件不在其中）。文案改由本包命名空间自持
 * （键的最终所在地 = 包的 owner），调用方不再注入 `t`——旧签名要求调用方传同 NS 的 `t`，
 * 迁包后那是跨包隐式契约。
 */
const MAX_FILE_UPLOAD_SIZE_LABEL = `${MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)}MB`;

interface UseFileUploadsOptions {
  envId: string | null;
  targetDir?: string;
  getTargetDir?: () => string | undefined;
  onUploaded: () => void;
  onError: (message: string) => void;
}

function validateFiles(files: File[], t: TFunction<typeof MACHINE_NS>): string | null {
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
export function useFileUploads({ envId, targetDir, getTargetDir, onUploaded, onError }: UseFileUploadsOptions) {
  const { t } = useTranslation(MACHINE_NS);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ percent: number; saving: boolean } | null>(null);
  const uploadControllerRef = useRef<AbortController | null>(null);
  const envIdRef = useRef(envId);

  useEffect(() => {
    if (envIdRef.current !== envId) uploadControllerRef.current?.abort();
    envIdRef.current = envId;
  }, [envId]);
  useEffect(
    () => () => {
      envIdRef.current = null;
      uploadControllerRef.current?.abort();
    },
    [],
  );

  const uploadFiles = useCallback(
    async (
      files: File[],
      onProgress?: (percent: number) => void,
      relativePaths?: string[],
      targetDirOverride?: string,
    ) => {
      if (!envId || files.length === 0) return;
      const uploadTargetDir =
        targetDirOverride !== undefined ? targetDirOverride : (getTargetDir?.() ?? targetDir ?? "");
      const validationError = validateFiles(files, t);
      if (validationError) {
        onError(validationError);
        return;
      }

      const controller = new AbortController();
      uploadControllerRef.current?.abort();
      uploadControllerRef.current = controller;
      setUploading(true);
      setUploadProgress({ percent: 0, saving: false });
      try {
        const batches = createUploadBatches(files, relativePaths);
        const totalSize = Math.max(
          1,
          files.reduce((sum, file) => sum + file.size, 0),
        );
        let uploadedSize = 0;
        for (const batch of batches) {
          if (controller.signal.aborted) return;
          setUploadProgress({ percent: Math.round((uploadedSize / totalSize) * 100), saving: false });
          await uploadWorkspaceFiles(envId, batch.files, {
            targetDir: uploadTargetDir,
            relativePaths: batch.relativePaths,
            signal: controller.signal,
            onProgress: (percent) => {
              if (uploadControllerRef.current !== controller || controller.signal.aborted) return;
              const overall = Math.round(((uploadedSize + (batch.size * percent) / 100) / totalSize) * 100);
              // XHR 只确认浏览器到主服务的字节传输；落盘结果以 HTTP 响应为准。
              setUploadProgress({ percent: overall, saving: percent === 100 });
              onProgress?.(overall);
            },
          });
          uploadedSize += batch.size;
        }
        if (envIdRef.current === envId) onUploaded();
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        // 上屏的失败原因取服务端 message（`uploadWorkspaceFiles` 抛的 `ApiError.message` 即错误信封原文），
        // 只有 `path_conflict` 这类稳定码换成字典文案、message 为空时才退回 `fileTree.uploadFailed`；
        // 「部分文件可能已上传、确切数量未知」这句必须继续跟在失败原因后面。
        console.error("Workspace upload failed:", error);
        onError(
          t("fileTree.uploadPartialIndeterminate", {
            message: getFileOperationErrorMessage(error, t, t("fileTree.uploadFailed")),
          }),
        );
        if (envIdRef.current === envId) onUploaded();
      } finally {
        if (uploadControllerRef.current === controller) {
          uploadControllerRef.current = null;
          setUploading(false);
          setUploadProgress(null);
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

  const uploadDroppedFiles = useCallback(
    async (dataTransfer: DataTransfer, targetDirOverride?: string) => {
      const droppedEnvironment = envId;
      try {
        const dropped = await collectDroppedUpload(dataTransfer, () =>
          targetDirOverride !== undefined ? targetDirOverride : (getTargetDir?.() ?? targetDir ?? ""),
        );
        if (envIdRef.current !== droppedEnvironment) return;
        await uploadFiles(dropped.files, undefined, dropped.relativePaths, dropped.targetDir);
      } catch (error) {
        console.error("Reading dropped workspace files failed:", error);
        if (envIdRef.current === droppedEnvironment) onError(t("fileTree.uploadFailed"));
      }
    },
    [envId, getTargetDir, onError, t, targetDir, uploadFiles],
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
    uploadProgress,
    uploadFiles,
    uploadDroppedFiles,
    handleFileInputChange,
    handleFolderInputChange,
  };
}
