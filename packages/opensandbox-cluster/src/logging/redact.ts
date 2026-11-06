import { isSensitiveLogKey, sanitizeLogValue } from "@fenix/logger/sanitize";

/** Apply the shared credential rules plus opaque sandbox input and deployment secret masking. */
export function redactLogValue(value: unknown, secrets: readonly string[]): unknown {
  const masks = [...new Set(secrets.filter(Boolean).flatMap((secret) => [secret, encodeURIComponent(secret)]))];
  const mask = (text: string) => {
    for (const secret of masks) text = text.replaceAll(secret, "[REDACTED]");
    return text;
  };
  const seen = new WeakSet<object>();
  const visit = (item: unknown, key = "", depth = 0): unknown => {
    if (isSensitiveLogKey(key) || /^(?:env|environment|metadata|entrypoint|command|stdin)$/i.test(key))
      return "[REDACTED]";
    if (typeof item === "string") return mask(item);
    if (!item || typeof item !== "object") return item;
    if (seen.has(item)) return "[Circular]";
    if (depth >= 5) return "[DepthLimit]";
    seen.add(item);
    if (item instanceof Error) {
      // Mask before the shared Error serializer truncates message and stack; retain its DB-error rules.
      const copy = new Error(mask(item.message));
      copy.name = mask(item.name);
      copy.stack = mask(item.stack ?? "");
      if ("query" in item) Object.assign(copy, { query: "[REDACTED]" });
      if ("params" in item) Object.assign(copy, { params: [] });
      if ("code" in item && typeof item.code === "string") Object.assign(copy, { code: mask(item.code) });
      return copy;
    }
    if (Array.isArray(item)) return item.slice(0, 32).map((entry) => visit(entry, "", depth + 1));
    return Object.fromEntries(
      Object.entries(item)
        .slice(0, 32)
        .map(([name, entry]) => [mask(name), visit(entry, name, depth + 1)]),
    );
  };
  return sanitizeLogValue(visit(value));
}
