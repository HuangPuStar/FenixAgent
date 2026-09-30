import { afterEach, describe, expect, mock, test } from "bun:test";
import { ApiError } from "@fenix/web-runtime/api/request";
import { createInstance } from "i18next";
import { uploadFiles } from "../api/fs";
import { MACHINE_NS, machineResources } from "../i18n";
import { getFileOperationErrorMessage } from "../lib/file-operation-errors";

const originalFetch = globalThis.fetch;
const originalXhr = globalThis.XMLHttpRequest;
const i18n = createInstance();
await i18n.init({ lng: "zh", ns: [MACHINE_NS], resources: { zh: { [MACHINE_NS]: machineResources.zh } } });
const translate = i18n.getFixedT("zh", MACHINE_NS);

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.XMLHttpRequest = originalXhr;
});

describe("文件冲突反馈", () => {
  // 带进度的XHR上传必须同样保留冲突code，不能因不同传输方式显示泛化失败。
  test("进度上传 ApiError 保留冲突 code", async () => {
    class ConflictXhr {
      upload = {};
      status = 409;
      responseText = JSON.stringify({ error: { code: "path_conflict", message: "private internal path" } });
      onload: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      abort() {}
      send() {
        this.onload?.();
      }
    }
    globalThis.XMLHttpRequest = ConflictXhr as unknown as typeof XMLHttpRequest;
    await expect(
      uploadFiles("environment", [new File(["replacement"], "same.txt")], { onProgress: () => {} }),
    ).rejects.toMatchObject({ code: "path_conflict" });
  });

  // 实际请求解包应保留409信封中的稳定code，让上传、重命名和移动显示冲突文案。
  test("上传 ApiError 保留冲突 code 并映射双语反馈", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            error: { type: "path_conflict", code: "path_conflict", message: "private internal path" },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
    );
    let uploadError: unknown;
    try {
      await uploadFiles("environment", [new File(["replacement"], "same.txt")]);
    } catch (error) {
      uploadError = error;
    }
    expect(uploadError).toBeInstanceOf(ApiError);
    expect(uploadError).toMatchObject({ code: "path_conflict" });
    expect(getFileOperationErrorMessage(uploadError, translate, "上传失败")).toBe(
      machineResources.zh.fileTree.pathConflict,
    );
    expect(getFileOperationErrorMessage(uploadError, translate, "重命名失败")).toBe(
      machineResources.zh.fileTree.pathConflict,
    );
    expect(getFileOperationErrorMessage(uploadError, translate, "移动失败")).toBe(
      machineResources.zh.fileTree.pathConflict,
    );
    expect(machineResources.zh.fileTree.pathConflict).toContain("原内容未覆盖");
    expect(machineResources.en.fileTree.pathConflict).toContain("not overwritten");
  });

  // 非冲突错误继续使用操作自己的稳定文案，不能将任意后端message当成冲突反馈。
  test("非冲突错误保持通用失败文案", () => {
    expect(getFileOperationErrorMessage(new ApiError("internal failure", "SERVER_ERROR"), translate, "上传失败")).toBe(
      "上传失败",
    );
    expect(getFileOperationErrorMessage(new Error("path_conflict"), translate, "移动失败")).toBe("移动失败");
  });
});
