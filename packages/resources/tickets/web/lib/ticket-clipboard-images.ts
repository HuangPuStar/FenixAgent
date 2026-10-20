/**
 * 评论框粘贴图片的提取与命名（附件除「选择文件」之外的第二个入口）。
 *
 * **为什么不复用 `@fenix/ui-components` chat composer 的同名能力**：那边服务于「写进 workspace 的相对
 * 路径」——改名是为防 `fs.writeFile` 对同名文件**静默覆盖**，且带 base64 内联与压缩通路；这里服务于附件
 * 上传——上游每次上传都新建 asset（不存在覆盖），改名的理由是**恢复核对**按「文件名 + 字节数」认领唯一
 * 结果（同名同大小的多条匹配只能转 `needs_review`），并让用户在附件列表里看出粘贴时间。两套的扩展名策略
 * 与失败面会各自演进；chat 侧的读剪贴板函数也未导出，等到第三个用例出现再考虑上移。
 */

/** 页内递增序号（模块级，跨多次粘贴累加；重置时机 = 页面重新加载）。 */
let pastedImageSequence = 0;

/**
 * 读取剪贴板里的图片文件。
 *
 * 两个来源都要看：`clipboardData.files` 并非所有来源都填充——从网页「复制图片」、从 Office 文档或某些
 * 截图工具粘贴时，图片只出现在 `clipboardData.items`（`kind === "file"`）；只看 `files` 会让这类粘贴
 * 静默变成「什么都没发生」。用下标遍历而不依赖 `DataTransferItemList` 的迭代器（`lib.dom.iterable`）。
 *
 * 只收 `image/*`：非图片内容（纯文本、HTML、普通文件）必须留给浏览器默认粘贴行为，由调用方保证不
 * `preventDefault`。
 */
export function readPastedImageFiles(clipboard: DataTransfer): File[] {
  const fromFiles: File[] = [];
  const files = clipboard.files;
  for (let index = 0; index < (files?.length ?? 0); index += 1) {
    const file = files[index];
    if (file?.type.startsWith("image/")) fromFiles.push(file);
  }
  if (fromFiles.length > 0) return fromFiles;

  const fromItems: File[] = [];
  const items = clipboard.items;
  for (let index = 0; index < (items?.length ?? 0); index += 1) {
    const item = items[index];
    if (item?.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file !== null) fromItems.push(file);
  }
  return fromItems;
}

/** 可读的本地时间戳 `yyyyMMdd-HHmmss`（粘贴图片名的时间部分）。 */
export function formatPastedImageStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const datePart = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${datePart}-${timePart}`;
}

/** 6 位 base36 随机后缀：序号只保证同一页面内唯一，跨标签页（序号从头开始）靠它避开撞名。 */
function createRandomSuffix(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, "0");
}

/** 保留图片扩展名：优先原文件名的扩展名（用户可辨识），否则按 MIME 子类型，取不到退回 `png`。 */
function pastedImageExtension(file: File): string {
  const dotIndex = file.name.lastIndexOf(".");
  const fromName =
    dotIndex > 0
      ? file.name
          .slice(dotIndex + 1)
          .replace(/[^a-z0-9]/gi, "")
          .toLowerCase()
      : "";
  if (fromName.length > 0) return fromName;
  const fromType = file.type
    .slice(file.type.indexOf("/") + 1)
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  return fromType.length > 0 ? fromType : "png";
}

/**
 * 生成粘贴图片的附件名：`pasted-image-<yyyyMMdd>-<HHmmss>-<序号>-<随机>.<ext>`。
 *
 * 三段各自解决什么：时间戳可读可排序（用户要在附件列表里认出「什么时候粘的」）；页内序号对「同一秒内
 * 连续粘贴 / 同一批多张」给确定性保证；随机后缀兜跨页面撞名。`now` 可注入：测试据此断言格式而不依赖
 * 真实时钟。
 */
export function createPastedImageName(file: File, now: Date = new Date()): string {
  pastedImageSequence += 1;
  return `pasted-image-${formatPastedImageStamp(now)}-${pastedImageSequence}-${createRandomSuffix()}.${pastedImageExtension(file)}`;
}

/**
 * 把粘贴的图片换成带唯一名的副本（不改原对象；`type` 与 `lastModified` 原样保留）。
 *
 * 一律改名而不是「只在没有名字时补名」：剪贴板图片默认都叫 `image.png`，只补无名的那种挡不住最主要的
 * 重名场景，而重名正是恢复核对最怕的输入。
 */
export function renamePastedImage(file: File, now: Date = new Date()): File {
  return new File([file], createPastedImageName(file, now), { type: file.type, lastModified: file.lastModified });
}
