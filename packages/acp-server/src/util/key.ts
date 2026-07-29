// packages/acp-server/src/yjs-snapshot-key.ts
// 稳定序列化 key 函数 — 递归处理 Map、数组、普通对象，按 key 排序，用 JSON.stringify 输出。
// 用于 Yjs snapshot 去重：同一 key 表示 UI 语义未变，跳过重渲染通知。

/**
 * 对任意 JSON-like 值（含 Map、Array、object）做稳定序列化。
 *
 * 规则：
 * - 原始类型（string/number/boolean/null）→ 直接用 JSON.stringify
 * - Array → 递归序列化每个元素
 * - Map → 按 key 排序后序列化 entries
 * - 普通对象 → 按 key 排序后序列化
 * - undefined → "undefined"（与 null 区分）
 */
export function stableKey(value: unknown): string {
  return _stableKey(value);
}

function _stableKey(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";

  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") {
    return JSON.stringify(value);
  }

  // Map: 按 key 排序，递归处理 value
  if (value instanceof Map) {
    const keys = [...value.keys()].sort();
    const parts = keys.map((k) => {
      const sk = typeof k === "string" ? JSON.stringify(k) : _stableKey(k);
      const sv = _stableKey(value.get(k));
      return `${sk}:${sv}`;
    });
    return `Map(${parts.join(",")})`;
  }

  // Array
  if (Array.isArray(value)) {
    const parts = value.map((v) => _stableKey(v));
    return `[${parts.join(",")}]`;
  }

  // Plain object: 按 key 排序
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const parts = keys.map((k) => {
      const sv = _stableKey((value as Record<string, unknown>)[k]);
      return `${JSON.stringify(k)}:${sv}`;
    });
    return `{${parts.join(",")}}`;
  }

  // Fallback: 其他类型（如 symbol、function 不会出现在 snapshot 中）
  return String(value);
}
