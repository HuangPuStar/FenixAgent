/**
 * Config 路由共享工具函数。
 * 所有 /web/config/* 路由统一使用这些函数构建响应和处理验证。
 */

/** 统一成功响应 */
export function configSuccess<T>(data: T) {
  return { success: true as const, data };
}

/** 统一错误响应 */
export function configError(code: string, message: string, data?: unknown) {
  return { success: false as const, error: { code, message }, ...(data !== undefined ? { data } : {}) };
}

/** NOT_FOUND 快捷方式 */
export function configNotFound(resource: string) {
  return configError("NOT_FOUND", resource);
}

/** VALIDATION_ERROR 快捷方式 */
export function configValidationError(message: string) {
  return configError("VALIDATION_ERROR", message);
}

/** 通用资源名校验：1-64 字符，Unicode 字母、数字和单连字符 */
export function isValidResourceName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length >= 1 &&
    name.length <= 64 &&
    !name.includes("--") &&
    /^[\p{L}0-9][\p{L}0-9 \-]*[\p{L}0-9]$|^[\p{L}0-9]$/u.test(name)
  );
}

/** 从 apiKey 字段生成 keyHint：短 key 或空 key 统一返回固定 7 位掩码。 */
export function toKeyHint(apiKey: string | undefined | null): string | null {
  const realKey = resolveApiKey(apiKey);
  if (!realKey || realKey.length < 4) return "*******";
  return `***${realKey.slice(-4)}`;
}

/** 解析 apiKey：明文直接返回，{env:XXX} 引用尝试环境变量 */
export function resolveApiKey(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const envMatch = raw.match(/^\{env:(.+)\}$/);
  return envMatch ? (process.env[envMatch[1]] ?? null) : raw;
}

/** JSONB 安全序列化 */
export function safeJsonStringify(value: unknown): string | undefined {
  return value != null ? JSON.stringify(value) : undefined;
}

/** JSONB 安全反序列化 */
export function safeJsonParse<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
