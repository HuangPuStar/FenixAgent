import { createLogger } from "@fenix/logger";
import { AppError } from "@fenix/platform-sdk";
import { FileServiceError, type UploadFailureDetails } from "./file-types";

/** Preserve overwrite batch progress while mapping native execution failures. */
export function uploadFailure(error: unknown, details: UploadFailureDetails): FileServiceError {
  if (error instanceof FileServiceError)
    return new FileServiceError(error.message, error.type, error.statusCode, error.currentVersion, details);
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (code === "VERSION_CONFLICT")
    return new FileServiceError("文件内容或类型已变化，请刷新后重试", "version_conflict", 409, undefined, details);
  if (code === "EEXIST" || code === "ENOTEMPTY")
    return new FileServiceError("目标文件或目录已存在", "path_conflict", 409, undefined, details);
  if (code === "OPERATION_CONFLICT" || code === "EINVAL" || (error instanceof AppError && error.statusCode === 400))
    return new FileServiceError("文件保存条件或路径无效", "validation_error", 400, undefined, details);
  if (code === "EFBIG") return new FileServiceError("单文件上限 92MB", "payload_too_large", 413, undefined, details);
  createLogger("file-upload").error("覆盖上传执行失败", error instanceof Error ? error.message : String(error));
  return new FileServiceError("文件服务不可用，请稍后重试", "file_service_unavailable", 503, undefined, details);
}
