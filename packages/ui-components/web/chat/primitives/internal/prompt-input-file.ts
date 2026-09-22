/**
 * prompt-input 内部模块：附件 blob URL → data URL 转换。
 *
 * 仅供 `web/chat/primitives/prompt-input.tsx` 使用，不属于公开 API。
 * 拆分为独立模块的原因：原实现单文件超过 500 行红线；该函数为纯函数，不依赖组件状态。
 * 保留 blob URL 兜底路径，因为浏览器扩展环境下 fetch(blob:) 可能失败。
 */

/**
 * `Blob` / `File` → data URL；读取失败（`reader.onerror`）回传 `null`。
 *
 * 直读原始 File 与「先 fetch(blobUrl) 再读 blob」两条路径共用同一个读取体
 * （2026-09-22 库内去重：原为两处逐字重复的 `new Promise` + `FileReader` 块，
 * 唯一差异是最后 `readAsDataURL` 的入参）。日志文案与失败口径保持不变。
 */
function readAsDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      console.log("[PromptInput] FileReader complete, result length:", (reader.result as string)?.length);
      resolve(reader.result as string);
    };
    reader.onerror = () => {
      console.error("[PromptInput] FileReader error:", reader.error);
      resolve(null);
    };
    reader.readAsDataURL(blob);
  });
}

// Convert file to data URL, preferring direct File reading over blob URL fetch
// This is critical for Chrome extensions where fetch(blobUrl) may fail
export const convertToDataUrl = async (url: string, file?: File): Promise<string | null> => {
  // If we have the original File object, use FileReader directly
  // This is more reliable than fetch(blobUrl) in Chrome extensions
  if (file) {
    console.log("[PromptInput] Reading file directly with FileReader...");
    return readAsDataUrl(file);
  }

  // Fallback: try to fetch the blob URL (works in regular web pages)
  try {
    console.log("[PromptInput] Converting blob URL to data URL via fetch...");
    const response = await fetch(url);
    if (!response.ok) {
      console.error("[PromptInput] Fetch failed:", response.status, response.statusText);
      return null;
    }
    const blob = await response.blob();
    console.log("[PromptInput] Blob fetched, size:", blob.size, "type:", blob.type);
    return readAsDataUrl(blob);
  } catch (error) {
    console.error("[PromptInput] convertToDataUrl error:", error);
    return null;
  }
};
