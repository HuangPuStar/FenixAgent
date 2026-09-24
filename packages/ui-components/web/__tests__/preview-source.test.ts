import { describe, expect, test } from "bun:test";

const { getPreviewMimeType, loadByteAccuratePreviewSource, PreviewSourceError, shouldLoadPreviewAsBlob } = await import(
  "../components/preview/preview-source"
);

// 本文件是 `preview-source.ts` 的唯一守护：这些用例原先挂在宿主
// `apps/web/src/__tests__/preview-utils-normalize.test.ts`，而被测实现两处各有一份逐字副本
// （宿主 `agent-panel/preview/utils.ts` 与包内本模块）。宿主副本删除后，用例随实现归位到 owner 侧，
// 避免出现「宿主用例守护包内实现」的跨边界守护。

describe("getPreviewMimeType — 特殊文件名仍按扩展名识别", () => {
  // open-file-viewer 会把 # 当成 URL fragment，显式 MIME 可避免 #123.txt 被判定为未知格式
  test("# 开头的 txt 文件返回文本 MIME", () => {
    expect(getPreviewMimeType("user/#123.txt")).toBe("text/plain");
  });

  // 非文本文件不强行覆盖 MIME，继续由预览组件按扩展名和响应类型识别
  test("非文本文件不返回覆盖 MIME", () => {
    expect(getPreviewMimeType("user/image.png")).toBeUndefined();
  });
});

describe("文本预览源 — 保留响应的真实字节大小", () => {
  // 文本插件对 URL 会回退使用字符数；文本文件必须转为 Blob，让 size 保留 UTF-8 原始字节数
  test("UTF-8 中文文本使用 Blob 字节大小而非字符数", async () => {
    const content = "中".repeat(1000);
    const fetchPreview = async () => new Response(content, { headers: { "Content-Type": "text/plain" } });

    const source = await loadByteAccuratePreviewSource("/preview/chinese.txt", fetchPreview);

    expect(source).toBeInstanceOf(Blob);
    expect((source as Blob).size).toBe(3000);
    expect((source as Blob).size).not.toBe(content.length);
  });

  // UTF-16 响应必须保留 BOM 和双字节编码，避免解码后按 4 个字符显示为 4 B
  test("UTF-16 文本使用原始响应字节大小", async () => {
    const bytes = Uint8Array.from([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65, 0x4b, 0x6d, 0xd5, 0x8b]);
    const fetchPreview = async () => new Response(bytes, { headers: { "Content-Type": "text/plain" } });

    const source = await loadByteAccuratePreviewSource("/preview/utf16.txt", fetchPreview);

    expect(source).toBeInstanceOf(Blob);
    expect((source as Blob).size).toBe(bytes.byteLength);
  });

  // 仅文本类型改为 Blob；依赖原始 URL 的 PDF、HTML 和媒体预览保持现有加载链路
  test("只为文本预览加载 Blob", () => {
    expect(shouldLoadPreviewAsBlob("user/a.txt")).toBe(true);
    expect(shouldLoadPreviewAsBlob("user/a.md")).toBe(true);
    expect(shouldLoadPreviewAsBlob("user/a.html")).toBe(false);
    expect(shouldLoadPreviewAsBlob("user/a.pdf")).toBe(false);
  });

  // 非成功响应必须在进入预览器前显式失败，否则错误页会被当作文件内容展示
  test("非成功响应直接抛错而不是把错误页当作内容", async () => {
    const fetchPreview = async () => new Response("nope", { status: 404 });

    await expect(loadByteAccuratePreviewSource("/preview/missing.txt", fetchPreview)).rejects.toThrow();
  });

  // 失败必须是**结构化**错误：调用方要按状态码取字典文案（界面文案归调用方，纯逻辑模块不 import i18n）
  test("非成功响应抛带状态码的 PreviewSourceError", async () => {
    const fetchPreview = async () => new Response("nope", { status: 500 });

    const error = await loadByteAccuratePreviewSource("/preview/boom.txt", fetchPreview).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PreviewSourceError);
    expect((error as PreviewSourceError).status).toBe(500);
    // 消息是英文技术串，只供日志；界面文案由调用方按 status 取（不得把这条 message 直接上屏）
    expect((error as PreviewSourceError).message).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
