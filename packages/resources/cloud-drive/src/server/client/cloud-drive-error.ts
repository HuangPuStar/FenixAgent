/**
 * CloudDrive 出站调用的错误分类。
 *
 * 分类值是**传输中立**的：`kind` 描述这次调用属于哪一类失败，具体 HTTP 状态码由协议层
 * （`routes/web/cloud-drive-response`）唯一映射。上游 `{error:{code,message,details}}` 只在
 * 本文件解释一次，路由与 Facade 都不再解析上游 body。
 *
 * 安全约束：`message` 是准备直接返回前端的文案，绝不拼接上游 message/details、URL、master key
 * 或下载票据；诊断信息只留在 `upstreamStatus` / `upstreamCode` / `cause` 上。
 */

/** 失败分类；与协议层状态码的对应关系见 `routes/web/cloud-drive-response.ts`。 */
export type CloudDriveFailureKind =
  | "invalid"
  | "not-configured"
  | "not-found"
  | "conflict"
  | "payload-too-large"
  | "unavailable"
  | "rate-limited"
  | "unprocessable"
  | "gone"
  | "upstream";

/** 上游明确属于「冲突」的 code；`OPERATION_PENDING` 也归此类（请求未被受理，重试前需先收敛前序操作）。 */
const CONFLICT_CODES = new Set(["PATH_CONFLICT", "VERSION_CONFLICT", "IDEMPOTENCY_CONFLICT", "OPERATION_PENDING"]);

/** 配额与单文件上限：两者都表达「文件放不进去」，统一 413。 */
const TOO_LARGE_CODES = new Set(["QUOTA_EXCEEDED", "UPLOAD_TOO_LARGE"]);

/** 依赖不可用：可以退避重试，但先要排除部署配置问题。 */
const UNAVAILABLE_CODES = new Set(["DEPENDENCY_UNAVAILABLE", "SPACE_PROVISIONER_UNAVAILABLE"]);

/** 用户输入不合法：上游用 422 表达，不能显示成「上游故障」。 */
const UNPROCESSABLE_CODES = new Set(["INVALID_ARGUMENT", "INVALID_PATH"]);

/** CloudDrive 调用失败；`kind` 由协议层原样映射成 HTTP 状态。 */
export class CloudDriveError extends Error {
  constructor(
    readonly kind: CloudDriveFailureKind,
    readonly code: string,
    message: string,
    readonly options: {
      readonly cause?: unknown;
      readonly upstreamStatus?: number;
      readonly upstreamCode?: string;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "CloudDriveError";
  }

  /** 上游 HTTP 状态；仅用于日志与排查。 */
  get upstreamStatus(): number | undefined {
    return this.options.upstreamStatus;
  }

  /** 上游业务 code；仅用于日志与排查。 */
  get upstreamCode(): string | undefined {
    return this.options.upstreamCode;
  }
}

/** 未配置 CloudDrive（缺失基址或 master key）。 */
export function notConfiguredError(): CloudDriveError {
  return new CloudDriveError("not-configured", "CLOUD_DRIVE_NOT_CONFIGURED", "CloudDrive 未配置");
}

/** 输入不合法；`message` 必须是不含内部细节的固定文案。 */
export function invalidRequestError(code: string, message: string): CloudDriveError {
  return new CloudDriveError("invalid", code, message);
}

/** 上游返回了无法识别的成功响应（字段缺失、非 JSON、HEAD 缺 offset 等）。 */
export function invalidResponseError(cause?: unknown): CloudDriveError {
  return new CloudDriveError("upstream", "CLOUD_DRIVE_UPSTREAM_ERROR", "CloudDrive 返回了无法识别的响应", {
    cause,
  });
}

/** 网络不可达或超时；两者都可退避重试。 */
export function transportError(cause: unknown, timedOut: boolean): CloudDriveError {
  return timedOut
    ? new CloudDriveError("unavailable", "CLOUD_DRIVE_TIMEOUT", "CloudDrive 请求超时", { cause })
    : new CloudDriveError("unavailable", "CLOUD_DRIVE_UNAVAILABLE", "CloudDrive 无法访问", { cause });
}

/** 从上游错误信封里取 `error.code`；形状不符时返回空串。 */
function readUpstreamCode(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return "";
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

/**
 * 把上游非 2xx 响应解释成 {@link CloudDriveError}。
 *
 * 判定顺序刻意如此：
 * 1. 401/403 先判——这类响应几乎总是 master key / 来源网段 / scope 的部署问题，必须与用户会话失效
 *    彻底隔离，因此统一 502 且不暴露上游 code 与 message；
 * 2. 之后按业务 code 判（CloudDrive 的 422 可能同时承载 `QUOTA_EXCEEDED` 与 `INVALID_ARGUMENT`，
 *    只看状态码会丢失语义）；
 * 3. 最后按 HTTP 状态兜底（404/409/413/503 本身就是稳定的语义）。
 */
export function upstreamError(status: number, payload: unknown): CloudDriveError {
  const upstreamCode = readUpstreamCode(payload);
  const details = { upstreamStatus: status, upstreamCode: upstreamCode || undefined };

  if (status === 401 || status === 403) {
    return new CloudDriveError("upstream", "CLOUD_DRIVE_UPSTREAM_ERROR", "CloudDrive 拒绝了服务端调用", details);
  }
  if (upstreamCode === "NOT_FOUND" || status === 404) {
    return new CloudDriveError("not-found", "NOT_FOUND", "文件不存在或无权访问", details);
  }
  if (CONFLICT_CODES.has(upstreamCode) || status === 409) {
    return new CloudDriveError("conflict", "CLOUD_DRIVE_CONFLICT", "目标已存在或文件已变化，请刷新后重试", details);
  }
  if (TOO_LARGE_CODES.has(upstreamCode) || status === 413) {
    return new CloudDriveError(
      "payload-too-large",
      "CLOUD_DRIVE_PAYLOAD_TOO_LARGE",
      "配额不足或文件超过大小限制",
      details,
    );
  }
  if (UNAVAILABLE_CODES.has(upstreamCode) || status === 503) {
    return new CloudDriveError("unavailable", "CLOUD_DRIVE_UNAVAILABLE", "CloudDrive 暂不可用，请稍后重试", details);
  }
  if (upstreamCode === "RATE_LIMITED" || status === 429) {
    return new CloudDriveError(
      "rate-limited",
      "CLOUD_DRIVE_RATE_LIMITED",
      "CloudDrive 请求过于频繁，请稍后重试",
      details,
    );
  }
  if (UNPROCESSABLE_CODES.has(upstreamCode) || status === 422) {
    return new CloudDriveError("unprocessable", "CLOUD_DRIVE_INVALID_INPUT", "请求参数不合法", details);
  }
  return new CloudDriveError("upstream", "CLOUD_DRIVE_UPSTREAM_ERROR", "CloudDrive 调用失败", details);
}
