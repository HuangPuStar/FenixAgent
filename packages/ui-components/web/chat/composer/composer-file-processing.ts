import type { FileAttachment, UserMessageImage } from "../types";

/**
 * 输入岛的文件处理：图片压缩为 ACP 可直接发送的 base64，普通附件上传为 workspace 相对路径。
 *
 * 来源：复制自 `packages/agent-runtime/web/components/chat/composer-file-processing.ts`。
 * 纯化改动点：
 * - `browser-image-compression` 与 `@/src/api/fs`（`uploadChatFiles`）改为注入点
 *   （`CompressImage` / `UploadComposerFiles`），包内不再持有网络与压缩依赖；
 *   压缩参数仍以 `IMAGE_COMPRESSION_OPTIONS` 原样导出，宿主按同一参数注入即可保持行为一致。
 * - `FileInfo`（宿主 `@/src/types`）包内 types.ts 暂无对应类型，按字段内联为 `ComposerFileInfo`。
 */

/** 图片压缩注入点：与源 `browser-image-compression` 的默认导出同签名。 */
export type CompressImage = (file: File) => Promise<Blob>;

/**
 * 文件上传注入点：把文件写入当前会话的 workspace，返回可被 `@./<path>` 引用的附件。
 *
 * 源实现为 `uploadChatFiles(envId, files)` 直连宿主 api 客户端，纯化后由宿主注入。
 */
export type UploadComposerFiles = (files: File[]) => Promise<FileAttachment[]>;

/**
 * 文件引用项（拖拽上传结果 / 文件选择器选中项）。
 *
 * 源实现用宿主 `@/src/types` 的 `FileInfo`；包内 `web/chat/types.ts` 当前未包含该类型，
 * 这里按字段内联（结构完全一致，宿主的 `FileInfo` 可直接传入）。集成阶段若把 `FileInfo`
 * 收敛进 `web/chat/types.ts`，本类型应改为复用并删除此定义。
 */
export interface ComposerFileInfo {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
  modifiedAt: number;
}

/**
 * 源 `browser-image-compression` 的压缩参数（逐字保留）。
 *
 * 宿主注入 `CompressImage` 时应原样使用，否则压缩后的体积/尺寸会与源实现不一致。
 */
export const IMAGE_COMPRESSION_OPTIONS = {
  maxSizeMB: 2,
  maxWidthOrHeight: 2048,
  useWebWorker: true,
  fileType: "image/jpeg" as const,
};

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Chat 上传文件的 workspace 目标目录（源 `@/src/api/fs.ts` 的 `CHAT_UPLOAD_DIRECTORY`）。 */
const CHAT_UPLOAD_DIRECTORY = "user";

/** 超过该体积的图片才走压缩（源实现的内联阈值）。 */
const IMAGE_COMPRESSION_THRESHOLD_BYTES = 2 * 1024 * 1024;

/**
 * 将文件名转换为 Chat 用户文件区域中的 workspace 相对路径。
 *
 * 复制自 `apps/web/src/api/fs.ts` 的 `getChatUploadPath`（纯路径拼接，无网络耦合）；
 * 供拖拽上传在上传回调未返回路径时兜底，与源行为一致。
 */
export function getChatUploadPath(fileName: string): string {
  return `${CHAT_UPLOAD_DIRECTORY}/${fileName}`;
}

/**
 * 将图片转为 ACP 可直接发送的 base64 内容。
 *
 * 纯化改动点：压缩改为可选注入的 `compress`。未注入时不压缩（直接按原文件编码），
 * 因此宿主需要与源一致的压缩行为时必须传入 `browser-image-compression`：
 * `(file) => imageCompression(file, IMAGE_COMPRESSION_OPTIONS)`。
 */
export async function processImageFiles(files: File[], compress?: CompressImage): Promise<UserMessageImage[]> {
  const results: UserMessageImage[] = [];

  for (const file of files) {
    try {
      let blob: Blob = file;
      let mimeType = file.type;
      if (file.size > IMAGE_COMPRESSION_THRESHOLD_BYTES && compress) {
        blob = await compress(file);
        mimeType = "image/jpeg";
      }

      const base64 = await blobToBase64(blob);
      results.push({ mimeType, data: base64 });
    } catch (error) {
      console.error("Failed to process image:", error);
    }
  }

  return results;
}

/**
 * 校验并上传普通附件，返回 workspace 相对路径。
 *
 * 体积校验（单个 / 合计 100 MB）保留在本函数，超限时抛出的 `Error.message` 是源命名空间
 * `components` 下的 i18n key（`chatComposer.fileTooLarge` / `chatComposer.filesTooLarge`），
 * 调用方需按包内前缀翻译为 `chat.components.chatComposer.*`。
 */
export async function uploadComposerFiles(files: File[], upload: UploadComposerFiles): Promise<FileAttachment[]> {
  if (files.some((file) => file.size > MAX_UPLOAD_BYTES)) {
    throw new Error("chatComposer.fileTooLarge");
  }
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_UPLOAD_BYTES) {
    throw new Error("chatComposer.filesTooLarge");
  }

  const uploaded = await upload(files);
  return uploaded.map(({ name, path }) => ({ name, path }));
}

/**
 * 把 Blob 编码为不含 data URL 前缀的 base64（ACP 协议要求裸 base64）。
 *
 * 包内共享：源 `composer-file-processing.ts` 与 `chat-image-content.ts` 各有一份逐字相同的
 * 实现，纯化时收敛为单一导出，避免两份 base64 编码逻辑漂移。
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
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
