import type { ImageContent } from "@fenix/chat-channel";
import imageCompression from "browser-image-compression";
import type { UserMessageImage } from "../../src/lib/types";

const IMAGE_COMPRESSION_OPTIONS = {
  maxSizeMB: 2,
  maxWidthOrHeight: 2048,
  useWebWorker: true,
  fileType: "image/jpeg" as const,
};

function base64ToBlob(image: UserMessageImage): Blob {
  const binary = atob(image.data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: image.mimeType });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result ?? "");
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
}

/** 将 composer 图片转换为 ACP ImageContent，并在必要时做二次压缩。 */
export async function prepareImageContent(image: UserMessageImage): Promise<ImageContent> {
  const source = base64ToBlob(image);
  if (source.size <= 2 * 1024 * 1024) {
    return { type: "image", mimeType: image.mimeType, data: image.data };
  }

  const file = new File([source], "image.jpg", { type: source.type });
  const compressed = await imageCompression(file, IMAGE_COMPRESSION_OPTIONS);
  return { type: "image", mimeType: "image/jpeg", data: await blobToBase64(compressed) };
}
