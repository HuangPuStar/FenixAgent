import { expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import type { PreviewContext, PreviewPlugin } from "@open-file-viewer/core";
import { Window } from "happy-dom";
import { pdfPreviewPlugin } from "../components/preview/pdf-plugin";
import { shouldLoadPreviewAsBlob } from "../components/preview/preview-source";

const win = initializeHappyDomWindow(new Window());
function context(): PreviewContext {
  return {
    host: win.document.createElement("div") as unknown as HTMLElement,
    viewport: win.document.createElement("div") as unknown as HTMLElement,
    file: {
      source: new Blob(["pdf"], { type: "application/pdf" }),
      name: "sample.pdf",
      extension: "pdf",
      mimeType: "application/pdf",
    },
    size: { width: 800, height: 600 },
    options: {
      fit: "width",
      fallback: "inline",
      zoom: 1,
      messages: {
        loading: "",
        unsupportedTitle: "",
        downloadTitle: "",
        downloadFile: "",
        file: "",
        unnamedFile: "",
        format: "",
        mime: "",
        size: "",
        source: "",
        unknown: "",
        undeclared: "",
        remoteUrl: "",
        localFile: "",
      },
    },
    setLoading: () => {},
    setError: () => {},
  };
}

// PDF 字节必须走宿主注入的文件读取，不能让新解析器直接请求领域 API。
test("loads PDF through the existing byte-accurate preview source", () => {
  expect(shouldLoadPreviewAsBlob("user/中文.pdf")).toBe(true);
  expect(shouldLoadPreviewAsBlob("user/page.html")).toBe(false);
});

// 未打开 PDF 前不加载解析器，避免影响其他文件和聊天首屏。
test("defers PDF runtime loading until a matching PDF is rendered", async () => {
  let loads = 0;
  const implementation: PreviewPlugin = { name: "pdf", match: () => true, render: () => ({ destroy() {} }) };
  const plugin = pdfPreviewPlugin(async () => {
    loads++;
    return implementation;
  });
  expect(await plugin.match({ ...context().file, extension: "txt", mimeType: "text/plain" })).toBe(false);
  expect(loads).toBe(0);
  await plugin.render(context());
  expect(loads).toBe(1);
});

// 在解析器加载完成前切走文件，迟到的解析器不能继续挂载或持有文档。
test("does not mount a PDF runtime after preview disposal", async () => {
  let finish!: (plugin: PreviewPlugin) => void;
  let renders = 0;
  const plugin = pdfPreviewPlugin(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const instance = await plugin.render(context());
  instance.destroy();
  finish({
    name: "pdf",
    match: () => true,
    render: () => {
      renders++;
      return { destroy() {} };
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(renders).toBe(0);
});

// 加载失败必须暴露给现有错误重试流程，不能一直显示空白或加载中。
test("reports a failed PDF runtime without leaving loading active", async () => {
  const errors: unknown[] = [],
    loading: boolean[] = [];
  const ctx = context();
  ctx.setError = (error) => errors.push(error);
  ctx.setLoading = (value) => loading.push(value);
  const plugin = pdfPreviewPlugin(async () => {
    throw new Error("PDF runtime unavailable");
  });
  await plugin.render(ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(errors).toHaveLength(1);
  expect(loading.at(-1)).toBe(false);
});

// 已开始创建查看器但尚未完成时切走文件，迟到的实例必须立即销毁。
test("destroys a late PDF instance after an in-flight mount is disposed", async () => {
  let finish!: (instance: { destroy: () => void }) => void;
  let destroyed = 0;
  const plugin = pdfPreviewPlugin(async () => ({
    name: "pdf",
    match: () => true,
    render: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  }));
  const instance = await plugin.render(context());
  await Promise.resolve();
  instance.destroy();
  finish({
    destroy: () => {
      destroyed++;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(destroyed).toBe(1);
});
