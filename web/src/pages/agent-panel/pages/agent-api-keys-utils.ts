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
