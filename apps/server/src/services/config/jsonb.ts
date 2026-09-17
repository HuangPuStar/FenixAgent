/**
 * jsonb.ts — jsonb 列的安全读写工具。
 *
 * 问题：旧代码在写入 jsonb 列前手动 JSON.stringify，Drizzle 又自动序列化一次，
 * 导致数据库中存储双重编码的 JSON 字符串。新代码已移除手动 stringify。
 *
 * 此工具提供：
 * - parseJsonb<T>：读取时兼容旧双重编码和新正确编码
 */

/** 安全解析 jsonb 值，兼容旧双重编码（string）和 Drizzle 自动解析（object） */
export function parseJsonb<T = unknown>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      // 处理双重编码：外层解析后仍可能是字符串
      if (typeof parsed === "string") {
        try {
          return JSON.parse(parsed) as T;
        } catch {
          return null;
        }
      }
      return parsed as T;
    } catch {
      return null;
    }
  }
  // Drizzle 已自动解析为对象/数组
  return value as T;
}

/** 安全解析 jsonb 值，解析失败时返回 fallback */
export function parseJsonbOr<T>(value: unknown, fallback: T): T {
  const result = parseJsonb<T>(value);
  return result ?? fallback;
}
