/**
 * 跨包错误分类法：携带稳定错误码与 HTTP 状态的 `AppError` 及其子类。
 *
 * 为什么必须由平台契约包提供，而不是各包自持：宿主的全局错误处理器（`apps/server/src/plugins/error-handler.ts`）
 * 按 `instanceof AppError` 决定对外状态码，它只认识自己导入的那个类。若资源包各自定义错误类，宿主就必须
 * 逐个认识每个包的每个类才能正确映射；而复制一份定义会让 `instanceof` 静默失败（同名不同类），错误会
 * 从 403/404 退化成 500 内部错误——这类故障不会在编译期暴露。
 *
 * 使用边界：
 * - 只有需要跨越模块边界、并由协议边界（route 或全局错误处理器）映射成 HTTP 响应的错误才用本分类法；
 *   模块内部的领域失败应使用模块自己的错误类型，不要为了复用状态码而包装成 `AppError`。
 * - `code` 是稳定的对外错误码，调用方据此分支；`message` 是给人看的描述，不是契约。
 * - `statusCode` 是默认映射，最终响应状态由错误处理器与 route 本地映射决定。
 * - 与同目录 `../resource/errors.ts` 的 `ResourceAccessDeniedError` 刻意分开：后者是授权实现抛出的
 *   拒绝信号，由资源 Facade 在边界上映射成本层的 `ForbiddenError` 后再进入协议层。两者形状相同但
 *   职责不同——把授权拒绝直接当作应用级错误抛出，会让基础设施故障与权限问题在调用方无法区分。
 */

/**
 * 应用错误基类：稳定错误码 + 默认 HTTP 状态。
 *
 * 继承 `Error` 并显式设置 `name`，保证序列化与日志中能区分具体子类；HTTP 映射依赖 `instanceof`，
 * 因此子类必须真实继承而不是复制字段。
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** 请求参数或请求体不合法（默认 400）。 */
export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR", 400);
    this.name = "ValidationError";
  }
}

/** 目标资源不存在（默认 404）。 */
export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, "NOT_FOUND", 404);
    this.name = "NotFoundError";
  }
}

/** 主体无权执行该动作（默认 403）。 */
export class ForbiddenError extends AppError {
  constructor(message: string) {
    super(message, "FORBIDDEN", 403);
    this.name = "ForbiddenError";
  }
}

/** 目标资源已存在或状态冲突（默认 409，错误码沿用历史值 `ALREADY_EXISTS`）。 */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, "ALREADY_EXISTS", 409);
    this.name = "ConflictError";
  }
}
