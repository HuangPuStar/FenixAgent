import { createHash } from "node:crypto";
import { AppError } from "@fenix/platform-sdk";
import { type FileOpResult, getFileCapabilities } from "../transport/file-ws-port";
import { FileServiceError, type UploadFailureDetails } from "./file-types";
/** Refuse new semantics on old runtimes instead of silently dropping save conditions. */
export function assertContentCapability(machineId: string, overwrite = false): void {
  const capabilities = getFileCapabilities(machineId);
  if (!capabilities.contentVersion || (overwrite && !capabilities.uploadOverwrite))
    throw new AppError("远程运行时不支持内容版本保存，请升级运行时", "file_service_unavailable", 503);
}
/** Verify the advertised snapshot identity against the actual bytes received. */
export function verifySnapshot(content: Uint8Array, version: unknown): void {
  if (typeof version !== "string" || createHash("sha256").update(content).digest("hex") !== version)
    throw new AppError("远程文件快照版本无效，请升级运行时", "remote_response_invalid", 503);
}

/** Translate typed machine failures while retaining only safe protocol diagnostics. */
export function throwContentResponseError(result: FileOpResult): never {
  const mapping = {
    not_found: ["not_found", 404, "文件不存在"],
    version_conflict: ["version_conflict", 409, "文件内容或类型已变化，请刷新后重试"],
    path_conflict: ["path_conflict", 409, "目标文件或目录已存在"],
    validation_error: ["validation_error", 400, "文件保存参数无效"],
    payload_too_large: ["payload_too_large", 413, "单文件上限 92MB"],
  } as const;
  const error = mapping[result.errorCode as keyof typeof mapping];
  if (!error)
    throw new FileServiceError(
      "远程文件服务不可用，请稍后重试",
      "file_service_unavailable",
      503,
      undefined,
      result.details as UploadFailureDetails | undefined,
    );
  throw new FileServiceError(
    error[2],
    error[0],
    error[1],
    undefined,
    result.details as UploadFailureDetails | undefined,
  );
}
