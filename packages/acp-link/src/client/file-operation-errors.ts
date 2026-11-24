/** A typed execution failure carried over file-ws. */
export interface FileOpResult {
  type: "file_op_result";
  request_id: string;
  status: "ok" | "error";
  data?: unknown;
  error?: string;
  error_code?:
    | "payload_too_large"
    | "operation_timeout"
    | "unsafe_symlink"
    | "busy"
    | "path_conflict"
    | "version_conflict"
    | "validation_error"
    | "not_found"
    | "file_service_unavailable";
  status_code?: 400 | 404 | 409 | 413 | 429 | 503;
}
/** File-ws execution error with optional partial upload receipt. */
export class FileOpError extends Error {
  constructor(
    message: string,
    readonly errorCode: NonNullable<FileOpResult["error_code"]>,
    readonly statusCode: NonNullable<FileOpResult["status_code"]>,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "FileOpError";
  }
}
/** Narrow native filesystem failures without losing diagnostics. */
export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
/** Convert shared secure-file failures to wire errors at the execution boundary. */
export function mapContentError(error: unknown): FileOpError {
  if (error instanceof FileOpError) return error;
  if (error instanceof Error && error.name === "AbortError")
    return new FileOpError("File operation cancelled", "operation_timeout", 503);
  const code = isErrnoException(error) ? error.code : undefined;
  if (code === "VERSION_CONFLICT")
    return new FileOpError("File content or target type has changed", "version_conflict", 409);
  if (code === "EEXIST" || code === "ENOTEMPTY") return new FileOpError("Target already exists", "path_conflict", 409);
  if (code === "EINVAL" || code === "OPERATION_CONFLICT")
    return new FileOpError("Invalid upload parameters or operation ID", "validation_error", 400);
  if (code === "ENOENT") return new FileOpError("File not found", "not_found", 404);
  if (code === "EFBIG") return new FileOpError("File exceeds 92MB limit", "payload_too_large", 413);
  if (code === "ELOOP" || code === "ENOTDIR")
    return new FileOpError("Upload target contains a symbolic link", "unsafe_symlink", 503);
  if (error instanceof TypeError) return new FileOpError("Unsupported text encoding", "validation_error", 400);
  console.error("File content operation failed", error);
  return new FileOpError("File service unavailable", "file_service_unavailable", 503);
}
