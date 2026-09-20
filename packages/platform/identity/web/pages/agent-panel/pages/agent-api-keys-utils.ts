import type { ApiKeyInfo } from "@/src/api/api-keys";
import { ApiError } from "@/src/api/request";

/**
 * 将创建 API key 的错误转换为用户可理解的提示文案。
 */
export function getApiKeyCreateErrorMessage(err: unknown, t: (key: string) => string): string {
  if (err instanceof ApiError && err.code === "DUPLICATE_API_KEY_NAME") {
    return t("toast.duplicateName");
  }
  return t("toast.createFailed");
}

/** Filter only fields exposed by the API key list contract. */
export function filterApiKeys(keys: ApiKeyInfo[], query: string): ApiKeyInfo[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return keys;
  return keys.filter(
    (key) => key.name.toLocaleLowerCase().includes(normalized) || key.prefix.toLocaleLowerCase().includes(normalized),
  );
}

/** Format flexible backend dates without assuming whether the response uses ISO or timestamps. */
export function formatApiKeyDate(value: number | string | null, locale: string, emptyLabel: string): string {
  if (value === null || value === "") return emptyLabel;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return emptyLabel;
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(date);
}
