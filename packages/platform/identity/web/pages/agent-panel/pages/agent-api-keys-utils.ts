import { copyDialogTextToClipboard } from "@fenix/ui-components/lib/clipboard";
import { ApiError } from "@fenix/web-runtime/api/request";
import type { ApiKeyInfo } from "../../../api/api-keys";

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

/**
 * 复制新建 API Key 的明文，返回**真实结果**（调用方据此给成功/失败反馈，不能静默）。
 *
 * 安全上下文（HTTPS / localhost）走统一剪贴板原语，最稳；非安全上下文（HTTP）下 `navigator.clipboard`
 * 是宿主 polyfill（隐藏 textarea + execCommand），它在**本页的模态对话框里会因焦点陷阱复制失败**，
 * 故共用弹窗剪贴板原语，直接退回「选中框内 `<code>` 再 execCommand」的方式——不移动焦点，
 * 也按真实结果回传。
 *
 * @param value 密钥明文。
 * @param codeElement 展示该密钥的 `<code>` 元素，降级路径选中它的内容。
 */
export async function copyApiKeyValue(value: string, codeElement: HTMLElement | null): Promise<boolean> {
  return copyDialogTextToClipboard(value, codeElement);
}
