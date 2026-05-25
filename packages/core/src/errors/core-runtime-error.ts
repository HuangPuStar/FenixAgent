/**
 * Core 编排层统一使用的错误码。
 */
export type CoreRuntimeErrorCode =
  | "DUPLICATE_ENGINE_PLUGIN"
  | "PLUGIN_NOT_FOUND"
  | "DUPLICATE_CORE_NODE"
  | "NODE_NOT_FOUND"
  | "NODE_OFFLINE"
  | "ENGINE_NOT_SUPPORTED"
  | "INSTANCE_ALREADY_EXISTS"
  | "INSTANCE_NOT_FOUND"
  | "INVALID_INSTANCE_STATE";

/**
 * Core 层具名运行时错误。
 */
export class CoreRuntimeError extends Error {
  /** 供调用方稳定断言的错误码。 */
  readonly code: CoreRuntimeErrorCode;
  /** 便于日志和上层处理器使用的结构化上下文。 */
  readonly details?: Record<string, unknown>;

  /**
   * 创建一条带错误码和附加上下文的 core 运行时错误。
   */
  constructor(code: CoreRuntimeErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CoreRuntimeError";
    this.code = code;
    this.details = details;
  }
}

/**
 * 判断给定异常是否为 core 运行时错误。
 */
export function isCoreRuntimeError(error: unknown): error is CoreRuntimeError {
  return error instanceof CoreRuntimeError;
}

/**
 * 创建一条带统一结构的 core 运行时错误。
 */
export function createCoreRuntimeError(
  code: CoreRuntimeErrorCode,
  message: string,
  details?: Record<string, unknown>,
): CoreRuntimeError {
  return new CoreRuntimeError(code, message, details);
}
