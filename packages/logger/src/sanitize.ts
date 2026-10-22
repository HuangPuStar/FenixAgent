const SENSITIVE_KEY =
  /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|connectionstring|database[-_]?url|redis[-_]?url|prompt|completion|payload|body|params|query|statement|cmdArgs|content)/i;

/** 自由文本只保留有界诊断信息；凭据、URL 查询与连接串必须在所有输出分流前去除。 */
export function sanitizeLogText(value: string, limit = 2048): string {
  const clean = value
    .replace(/(?:postgres(?:ql)?|redis|rediss):\/\/[^\s"'<>]+/gi, "[REDACTED_CONNECTION]")
    .replace(/(https?:\/\/)(?:[^\s/@]+@)?([^\s/?#]+)([^\s?#]*)(?:\?[^\s#]*)?(?:#[^\s]*)?/gi, "$1$2$3")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=_\-.]+/gi, "$1 [REDACTED]")
    .replace(/((?:set-cookie|cookie)\s*[=:]\s*)[^\n]+/gi, "$1[REDACTED]")
    .replace(
      /((?:token|password|secret|api[_-]?key|cookie|authorization)["']?\s*[=:]\s*["']?)[^\s"',;]+/gi,
      "$1[REDACTED]",
    );
  return clean.length > limit ? `${clean.slice(0, limit)}…[truncated:${clean.length}]` : clean;
}

/** 限制递归、字段数和数组长度；Error 只序列化可诊断字段，不展开驱动附带的 SQL 与参数。 */
export function sanitizeLogValue(value: unknown, key = "", depth = 0, seen = new WeakSet<object>()): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string")
    return sanitizeLogText(value, key === "msg" || key === "message" || key === "stack" ? 8192 : 2048);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return;
  if (typeof value !== "object") return sanitizeLogText(String(value));
  if (seen.has(value)) return "[Circular]";
  if (depth >= 5) return "[DepthLimit]";
  seen.add(value);
  if (value instanceof Error) {
    const dbError = value.name === "DrizzleQueryError" || "query" in value || "params" in value;
    return {
      type: value.name,
      message: dbError ? "Database operation failed" : sanitizeLogText(value.message),
      stack: dbError ? undefined : sanitizeLogText(value.stack ?? "", 8192),
      code:
        "code" in value && typeof value.code === "string" && /^[A-Z0-9_]{1,32}$/.test(value.code)
          ? value.code
          : undefined,
    };
  }
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => sanitizeLogValue(item, "", depth + 1, seen));
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 32)
      .map(([name, item]) => [name.slice(0, 128), sanitizeLogValue(item, name, depth + 1, seen)]),
  );
}
