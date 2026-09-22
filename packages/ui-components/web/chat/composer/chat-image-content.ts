import type { ImageContent, UserMessageImage } from "../types";
import { blobToBase64, type CompressImage } from "./composer-file-processing";

/**
 * 将 composer 中已持有的图片转换为 ACP `ImageContent`，必要时做二次压缩。
 *
 * 来源：复制自 `packages/agent-runtime/web/components/chat/chat-image-content.ts`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
 * 纯化改动点：
 * - `@fenix/chat-channel` 的 `ImageContent` 改为从包内 `../types` 导入（不引 @fenix/*）。
 * - `browser-image-compression` 改为注入点 `compress`：未注入时直接返回原图内容；
 *   需要与源一致的二次压缩时，宿主传 `(file) => imageCompression(file, IMAGE_COMPRESSION_OPTIONS)`。
 * - 与 `composer-file-processing.ts` 共享压缩参数与 base64 编码（源文件间重复定义收敛为一份）。
 */

/** 超过该体积的图片在发送前做二次压缩（源实现的内联阈值）。 */
const IMAGE_COMPRESSION_THRESHOLD_BYTES = 2 * 1024 * 1024;

/** base64 → Blob（源实现逐字保留）。 */
function base64ToBlob(image: UserMessageImage): Blob {
  const binary = atob(image.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: image.mimeType });
}

/** 将 composer 图片转换为 ACP ImageContent，并在必要时做二次压缩。 */
export async function prepareImageContent(image: UserMessageImage, compress?: CompressImage): Promise<ImageContent> {
  const source = base64ToBlob(image);
  if (source.size <= IMAGE_COMPRESSION_THRESHOLD_BYTES || !compress) {
    return { type: "image", mimeType: image.mimeType, data: image.data };
  }

  const file = new File([source], "image.jpg", { type: source.type });
  const compressed = await compress(file);
  return { type: "image", mimeType: "image/jpeg", data: await blobToBase64(compressed) };
}
