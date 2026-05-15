/** 自定义错误基类，所有业务错误继承此类 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly type: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** 400 — 请求参数验证失败 */
export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, "VALIDATION_ERROR");
    this.name = "ValidationError";
  }
}

/** 404 — 资源不存在 */
export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(id ? `${resource} '${id}' not found` : `${resource} not found`, 404, "NOT_FOUND");
    this.name = "NotFoundError";
  }
}

/** 409 — 资源冲突（已存在） */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "CONFLICT");
    this.name = "ConflictError";
  }
}

/** 403 — 操作被禁止 */
export class ForbiddenError extends AppError {
  constructor(message: string) {
    super(message, 403, "FORBIDDEN");
    this.name = "ForbiddenError";
  }
}

/** 将 AppError 转换为 Elysia 错误响应 */
export function toErrorResponse(error: unknown): { status: number; body: { error: { type: string; message: string } } } {
  if (error instanceof AppError) {
    return {
      status: error.statusCode,
      body: { error: { type: error.type, message: error.message } },
    };
  }
  const message = error instanceof Error ? error.message : "Internal Server Error";
  return {
    status: 500,
    body: { error: { type: "INTERNAL_ERROR", message } },
  };
}
