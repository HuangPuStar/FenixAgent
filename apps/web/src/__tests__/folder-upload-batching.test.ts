import { describe, expect, test } from "bun:test";
import { MAX_UPLOAD_BATCH_SIZE_BYTES, uploadFiles } from "../api/fs";
import { createUploadBatches } from "../components/agent-panel/use-file-uploads";

describe("目录上传分批", () => {
  test("大目录按字节分批且保持相对路径与同名文件对应", () => {
    const files = [
      new File([new Uint8Array(12)], "same.txt"),
      new File([new Uint8Array(MAX_UPLOAD_BATCH_SIZE_BYTES - 12)], "same.txt"),
      new File([new Uint8Array(1)], "特殊 #?.txt"),
    ];
    const relativePaths = ["root/a/same.txt", "root/b/same.txt", "root/中文/特殊 #?.txt"];

    const batches = createUploadBatches(files, relativePaths);

    expect(batches).toHaveLength(2);
    expect(batches[0]?.files).toEqual(files.slice(0, 2));
    expect(batches[0]?.relativePaths).toEqual(relativePaths.slice(0, 2));
    expect(batches[1]?.files).toEqual(files.slice(2));
    expect(batches[1]?.relativePaths).toEqual(relativePaths.slice(2));
  });

  test("单文件超过分批阈值时独占批次而不被丢弃", () => {
    const large = new File([new Uint8Array(MAX_UPLOAD_BATCH_SIZE_BYTES + 1)], "large.bin");
    const small = new File(["ok"], "small.txt");

    const batches = createUploadBatches([large, small], ["folder/large.bin", "folder/small.txt"]);

    expect(batches.map((batch) => batch.files.map((file) => file.name))).toEqual([["large.bin"], ["small.txt"]]);
    expect(batches.map((batch) => batch.relativePaths)).toEqual([["folder/large.bin"], ["folder/small.txt"]]);
  });

  test("XHR 对预先 aborted signal 不发送请求且只清理一次 listener", async () => {
    const originalXhr = globalThis.XMLHttpRequest;
    let sends = 0;
    let removes = 0;
    class FakeXhr {
      upload = {};
      responseText = "";
      status = 0;
      timeout = 0;
      withCredentials = false;
      onabort: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      abort() {
        this.onabort?.();
      }
      send() {
        sends++;
      }
    }
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
    const controller = new AbortController();
    controller.abort();
    const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
      removes++;
      return originalRemove(...args);
    }) as AbortSignal["removeEventListener"];

    try {
      await expect(
        uploadFiles("env-1", [new File(["x"], "x.txt")], {
          signal: controller.signal,
          onProgress: () => {},
        }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(sends).toBe(0);
      expect(removes).toBe(1);
    } finally {
      globalThis.XMLHttpRequest = originalXhr;
    }
  });
});
