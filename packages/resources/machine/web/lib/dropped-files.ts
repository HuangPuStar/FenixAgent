/** 一次拖拽的完整文件集合，相对路径包含顶层目录名且与 files 一一对应。 */
export interface DroppedFiles {
  files: File[];
  relativePaths: string[];
}

/** 拖拽开始时确定的上传目标，空字符串明确代表workspace根目录。 */
export interface DroppedUpload extends DroppedFiles {
  targetDir: string;
}

/** 在异步目录遍历前快照目标，避免同一环境内切换目录改变此次drop的落点。 */
export async function collectDroppedUpload(
  dataTransfer: Pick<DataTransfer, "items" | "files">,
  getTargetDir: () => string,
): Promise<DroppedUpload> {
  const targetDir = getTargetDir();
  return { ...(await collectDroppedFiles(dataTransfer)), targetDir };
}

interface DropEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  file?: (success: (file: File) => void, failure: (error: DOMException) => void) => void;
  createReader?: () => {
    readEntries: (success: (entries: DropEntry[]) => void, failure: (error: DOMException) => void) => void;
  };
}

/** 同步获取 drop 条目后递归读取目录，持续 readEntries 到空批次，避免浏览器只返回前100项。 */
export async function collectDroppedFiles(dataTransfer: Pick<DataTransfer, "items" | "files">): Promise<DroppedFiles> {
  const items = Array.from(dataTransfer.items ?? []).filter((item) => item.kind === "file");
  const roots = items.map((item) => ({ entry: item.webkitGetAsEntry?.(), file: item.getAsFile() }));
  const fallbackFiles = Array.from(dataTransfer.files);
  const result: DroppedFiles = { files: [], relativePaths: [] };
  const append = (file: File, path: string) => {
    result.files.push(file);
    result.relativePaths.push(path);
  };
  const walk = async (entry: DropEntry, path: string): Promise<void> => {
    if (entry.isFile && entry.file) {
      append(await new Promise<File>((resolveFile, rejectFile) => entry.file?.(resolveFile, rejectFile)), path);
      return;
    }
    if (!entry.isDirectory || !entry.createReader) throw new Error("Unsupported dropped file entry");
    const reader = entry.createReader();
    for (;;) {
      const children = await new Promise<DropEntry[]>((resolveEntries, rejectEntries) => {
        reader.readEntries(resolveEntries, rejectEntries);
      });
      if (children.length === 0) return;
      for (const child of children) await walk(child, `${path}/${child.name}`);
    }
  };
  if (roots.length === 0) {
    for (const file of fallbackFiles) append(file, file.webkitRelativePath || file.name);
  } else {
    for (const root of roots) {
      if (root.entry) await walk(root.entry, root.entry.name);
      else if (root.file) append(root.file, root.file.webkitRelativePath || root.file.name);
    }
  }
  return result;
}
