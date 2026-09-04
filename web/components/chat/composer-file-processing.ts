import imageCompression from "browser-image-compression";
import { uploadChatFiles } from "../../src/api/fs";
import type { FileAttachment, UserMessageImage } from "../../src/lib/types";

const IMAGE_COMPRESSION_OPTIONS = {
  maxSizeMB: 2,
  maxWidthOrHeight: 2048,
  useWebWorker: true,
  fileType: "image/jpeg" as const,
};

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** 将图片压缩为 ACP 可直接发送的 base64 内容。 */
export async function processImageFiles(files: File[]): Promise<UserMessageImage[]> {
  const results: UserMessageImage[] = [];

  for (const file of files) {
    try {
      let blob: Blob = file;
      let mimeType = file.type;
      if (file.size > 2 * 1024 * 1024) {
        blob = await imageCompression(file, IMAGE_COMPRESSION_OPTIONS);
        mimeType = "image/jpeg";
      }

      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = String(reader.result ?? "");
          const commaIndex = result.indexOf(",");
          resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
        };
        reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
        reader.readAsDataURL(blob);
      });
      results.push({ mimeType, data: base64 });
    } catch (error) {
      console.error("Failed to process image:", error);
    }
  }

  return results;
}

/** 校验并上传普通附件，返回 workspace 相对路径。 */
export async function uploadComposerFiles(workspaceId: string, files: File[]): Promise<FileAttachment[]> {
  if (files.some((file) => file.size > MAX_UPLOAD_BYTES)) {
    throw new Error("chatComposer.fileTooLarge");
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_UPLOAD_BYTES) {
    throw new Error("chatComposer.filesTooLarge");
  }

  const uploaded = await uploadChatFiles(workspaceId, files);
  return uploaded.files.map(({ name, path }) => ({ name, path }));
}
