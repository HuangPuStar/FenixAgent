/**
 * 仅放行已知诊断字段（归一化后的下划线形式）。
 * 不能用 bytes/type/size 这类通用后缀放行：tokenBytes、passwordSize 同样会命中，
 * 等于给裸密钥留了旁路。
 */
const DIAGNOSTIC_KEYS = new Set([
  "payload_bytes",
  "payload_type",
  "payload_size",
  "payload_count",
  "payload_length",
  "payload_duration_ms",
  "body_size",
  "content_length",
  "query_duration_ms",
  "token_count",
  "error_count",
  "retry_delay_ms",
]);

/** 紧凑形式让 PAYLOADBYTES/TOKENCOUNT 这类无分隔符写法仍按同一诊断字段处理。 */
const DIAGNOSTIC_KEYS_COMPACT = new Set([...DIAGNOSTIC_KEYS].map((key) => key.replaceAll("_", "")));

/**
 * 白名单未命中时按包含匹配兜底：复数（prompts/payloads）与紧凑拼接（TOKENBYTES）
 * 都没有 `_` 边界，按词段匹配会漏；这里用去分隔符后的形式恢复旧实现的包含语义。
 */
const SENSITIVE_CONTAINS =
  /(?:authorization|cookie|credential|password|passwd|pwd|passphrase|secret|token|apikey|(?:access|account|private|signing|encryption|sharedaccess)key|prompt|completion|payload|bodies|body|param|query|statement|sql|dsn|args|content|connectionstring|(?:database|redis|mongo(?:db)?|mysql|postgres(?:ql)?|amqp|rabbitmq)(?:url|uri))/;

/** 按字段名包含的敏感词识别；白名单内的诊断计数不能被当成正文。 */
export function isSensitiveLogKey(key: string): boolean {
  const normalized = key
    // 先拆 camelCase 与缩写边界（DBPassword → DB_Password），再统一分隔符。
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  if (!normalized) return false;
  const compact = normalized.replaceAll("_", "");
  if (DIAGNOSTIC_KEYS.has(normalized) || DIAGNOSTIC_KEYS_COMPACT.has(compact)) return false;
  return SENSITIVE_CONTAINS.test(compact);
}

/** 自由文本只保留有界诊断信息；凭据、URL 查询与连接串必须在所有输出分流前去除。 */
export function sanitizeLogText(value: string, limit = 2048): string {
  const clean = value
    .replace(/(?:postgres(?:ql)?|redis|rediss):\/\/[^\s"'<>]+/gi, "[REDACTED_CONNECTION]")
    // 只认 postgres/redis 会漏掉其它 scheme 的 user:password@，凭据不能靠 scheme 白名单兜底。
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/(https?:\/\/)(?:[^\s/@]+@)?([^\s/?#]+)([^\s?#]*)(?:\?[^\s#]*)?(?:#[^\s]*)?/gi, "$1$2$3")
    // 密钥占位符只应存在于配置；保留标记说明这里曾有引用，但不输出环境变量名。
    .replace(
      /\{env:[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_KEY)[A-Z0-9_]*\}/gi,
      "[REDACTED_ENV_REF]",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=_\-.]+/gi, "$1 [REDACTED]")
    .replace(/((?:set-cookie|cookie)\s*[=:]\s*)[^\n]+/gi, "$1[REDACTED]")
    .replace(
      /((?:authorization|proxy-authorization|token|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|pwd|passphrase|secret|client[_-]?secret|api[_-]?key|apikey|(?:access|account|private|secret|signing|shared[_-]?access)_?key|credential|connection[_-]?string|dsn|cookie)["']?\s*[=:]\s*["']?)[^\s"',;]+/gi,
      "$1[REDACTED]",
    )
    // 形如 RCS_SECRET_* / LANGFUSE_SECRET_KEY 的环境变量赋值与明文密钥等价。
    .replace(
      /(\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*)[^\s"',;]+/g,
      "$1[REDACTED]",
    );
  return clean.length > limit ? `${clean.slice(0, limit)}…[truncated:${clean.length}]` : clean;
}

/** 限制递归、字段数和数组长度；Error 只序列化可诊断字段，不展开驱动附带的 SQL 与参数。 */
export function sanitizeLogValue(value: unknown, key = "", depth = 0, seen = new WeakSet<object>()): unknown {
  if (isSensitiveLogKey(key)) return "[REDACTED]";
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
