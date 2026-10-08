import { describe, expect, test } from "bun:test";
import { buildUploadFormData } from "../api/fs";
import { collectDroppedFiles, collectDroppedUpload } from "../lib/dropped-files";

function fileEntry(file: File): FileSystemEntry {
  return {
    name: file.name,
    isFile: true,
    isDirectory: false,
    file: (success: (value: File) => void) => queueMicrotask(() => success(file)),
  } as unknown as FileSystemEntry;
}

function directoryEntry(name: string, batches: FileSystemEntry[][]): FileSystemEntry {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let batchIndex = 0;
      return { readEntries: (success: (entries: FileSystemEntry[]) => void) => success(batches[batchIndex++] ?? []) };
    },
  } as unknown as FileSystemEntry;
}

function transfer(entries: FileSystemEntry[], files: File[] = []): Pick<DataTransfer, "items" | "files"> {
  return {
    items: entries.map((entry, index) => ({
      kind: "file",
      webkitGetAsEntry: () => entry,
      getAsFile: () => files[index] ?? null,
    })) as unknown as DataTransferItemList,
    files: files as unknown as FileList,
  };
}

describe("目录拖拽上传", () => {
  // 同一环境在异步目录扫描中切换上传目录，既有drop仍必须使用开始时的目标。
  test("异步遍历期间目录切换不改变上传目标", async () => {
    let currentTarget = "first-directory";
    let targetReads = 0;
    const collected = collectDroppedUpload(
      transfer([directoryEntry("folder", [[fileEntry(new File(["bytes"], "a.txt"))]])]),
      () => {
        targetReads++;
        return currentTarget;
      },
    );
    currentTarget = "second-directory";
    expect(await collected).toMatchObject({ targetDir: "first-directory", relativePaths: ["folder/a.txt"] });
    expect(targetReads).toBe(1);
    const rootDrop = collectDroppedUpload(transfer([fileEntry(new File(["root"], "root.txt"))]), () => "");
    currentTarget = "third-directory";
    expect((await rootDrop).targetDir).toBe("");
  });

  // 拖入目录需递归读取所有批次和嵌套文件，并在multipart中保留完整相对路径与字节。
  test("递归目录跨批次收集文件并保留相对路径", async () => {
    const firstBatch = Array.from({ length: 100 }, (_, index) => fileEntry(new File([`${index}`], `${index}.txt`)));
    const nested = directoryEntry("nested", [[fileEntry(new File(["nested bytes"], "same.txt"))]]);
    const root = directoryEntry("root", [firstBatch, [nested, fileEntry(new File(["root bytes"], "same.txt"))]]);
    const dropped = await collectDroppedFiles(transfer([root]));
    expect(dropped.files).toHaveLength(102);
    expect(dropped.relativePaths.slice(-2)).toEqual(["root/nested/same.txt", "root/same.txt"]);
    const form = buildUploadFormData(dropped.files, dropped.relativePaths);
    expect(JSON.parse(String(form.get("relativePaths")))).toEqual(dropped.relativePaths);
    const uploaded = form.getAll("files") as File[];
    expect(await uploaded[100].text()).toBe("nested bytes");
    expect(await uploaded[101].text()).toBe("root bytes");
  });

  // drop事件结束后DataTransfer会失效，条目必须在首次异步等待前同步获取。
  test("事件数据清空不影响已捕获的目录条目", async () => {
    const data = transfer([directoryEntry("folder", [[fileEntry(new File(["bytes"], "a.txt"))]])]);
    const collected = collectDroppedFiles(data);
    data.items = [] as unknown as DataTransferItemList;
    data.files = [] as unknown as FileList;
    expect((await collected).relativePaths).toEqual(["folder/a.txt"]);
  });

  // 不支持目录Entry接口时普通文件仍沿用FileList，空目录不能作为伪文件上传。
  test("普通文件回退与空目录正确处理", async () => {
    const plain = new File(["plain"], "plain.txt");
    const dropped = await collectDroppedFiles(transfer([], [plain]));
    expect(dropped).toEqual({ files: [plain], relativePaths: ["plain.txt"] });
    expect(await collectDroppedFiles(transfer([directoryEntry("empty", [])]))).toEqual({
      files: [],
      relativePaths: [],
    });
  });

  // 目录读取失败必须拒绝整次收集，不能悄悄仅上传已收集的一部分文件。
  test("目录读取错误明确失败", async () => {
    const broken = {
      name: "broken",
      isDirectory: true,
      isFile: false,
      createReader: () => ({
        readEntries: (_success: (entries: FileSystemEntry[]) => void, failure: (error: DOMException) => void) => {
          failure(new DOMException("Denied", "NotReadableError"));
        },
      }),
    } as unknown as FileSystemEntry;
    await expect(collectDroppedFiles(transfer([broken]))).rejects.toMatchObject({ name: "NotReadableError" });
  });
});
