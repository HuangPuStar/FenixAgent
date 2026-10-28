import { CloudDriveError, type CloudDriveFailureKind } from "../client/cloud-drive-error";

/**
 * Facade 动作的结果信封。
 *
 * Facade 是应用层，不返回 HTTP 数字：`kind` 是传输中立的分类，「哪一类对应哪个状态码」这张表只在
 * 协议层出现一次（`routes/web/cloud-drive-response`）。这与 knowledge 的 `KnowledgeResult` 同口径。
 */

/** 失败结果：`code` / `message` 是准备直接返回前端的文案，`kind` 供协议层选状态码。 */
export interface CloudDriveFailure {
  readonly kind: CloudDriveFailureKind;
  readonly code: string;
  readonly message: string;
}

export type CloudDriveResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: CloudDriveFailure };

export function cloudDriveOk<T>(data: T): CloudDriveResult<T> {
  return { ok: true, data };
}

export function cloudDriveFail<T = never>(
  kind: CloudDriveFailureKind,
  code: string,
  message: string,
): CloudDriveResult<T> {
  return { ok: false, error: { kind, code, message } };
}

/** 把出站错误收敛成失败结果；未知异常按上游失败处理（不把内部堆栈带到前端）。 */
export function cloudDriveFailureFrom(error: unknown): CloudDriveFailure {
  if (error instanceof CloudDriveError) {
    return { kind: error.kind, code: error.code, message: error.message };
  }
  return { kind: "upstream", code: "CLOUD_DRIVE_UPSTREAM_ERROR", message: "CloudDrive 调用失败" };
}
