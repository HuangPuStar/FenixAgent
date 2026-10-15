import { describe, expect, test } from "bun:test";

const {
  classifyFile,
  decodePreviewText,
  getPreviewMimeType,
  isDocumentCategory,
  isLatexExtension,
  isMarkdownExtension,
  loadByteAccuratePreviewSource,
  PREVIEW_MAX_DOCUMENT_BYTES,
  PreviewSourceError,
  shouldLoadPreviewAsBlob,
  shouldRenderDocumentContent,
} = await import("../components/preview/preview-source");

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

describe("文档类（markdown / LaTeX）分类", () => {
  // `.tex` 必须自成一类：@open-file-viewer 只把它当 Prism 高亮的源码，结构渲染由包内 LaTeX 分支承担
  test("tex / latex / ltx 归类为 latex，不再落到 code", () => {
    expect(classifyFile("user/paper.tex")).toBe("latex");
    expect(classifyFile("user/paper.latex")).toBe("latex");
    expect(classifyFile("user/paper.ltx")).toBe("latex");
  });

  // 分类口径要与扩展名判定函数一致：预览器的插件匹配复用同一份清单
  test("扩展名判定与分类同源", () => {
    expect(isLatexExtension("TEX")).toBe(true);
    expect(isLatexExtension("txt")).toBe(false);
    expect(isMarkdownExtension("Markdown")).toBe(true);
    expect(isMarkdownExtension("tex")).toBe(false);
    expect(isDocumentCategory(classifyFile("user/a.md"))).toBe(true);
    expect(isDocumentCategory(classifyFile("user/a.tex"))).toBe(true);
    expect(isDocumentCategory(classifyFile("user/a.ts"))).toBe(false);
  });

  // 文档类也要按 Blob 加载：大小上限与空文件判定都基于响应原始字节数
  test("文档类按 Blob 加载，字节数在渲染前可用", () => {
    expect(shouldLoadPreviewAsBlob("user/a.md")).toBe(true);
    expect(shouldLoadPreviewAsBlob("user/a.tex")).toBe(true);
  });

  // 上限是「不超过即渲染」：边界值本身仍走渲染，避免 off-by-one 把刚好达标的文档降级成源码
  test("字节上限按闭区间判定", () => {
    expect(shouldRenderDocumentContent(0)).toBe(true);
    expect(shouldRenderDocumentContent(PREVIEW_MAX_DOCUMENT_BYTES)).toBe(true);
    expect(shouldRenderDocumentContent(PREVIEW_MAX_DOCUMENT_BYTES + 1)).toBe(false);
  });
});

describe("文档正文解码（按 BOM 分流）", () => {
  // BOM 落在正文里会渲染成零宽字符，UTF-8 文档必须剥掉
  test("UTF-8 BOM 被剥掉", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("\\section{标题}")]);

    expect(await decodePreviewText(new Blob([bytes]))).toBe("\\section{标题}");
  });

  // Windows 记事本另存的 .tex 是 UTF-16LE：按 UTF-8 解会整篇乱码
  test("UTF-16LE 文本按双字节解码", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65]);

    expect(await decodePreviewText(new Blob([bytes]))).toBe("中文");
  });

  // UTF-16BE 的 BOM 相反，字节序也要跟着换，否则两个字会被拆成乱码
  test("UTF-16BE 文本按双字节解码", async () => {
    const bytes = new Uint8Array([0xfe, 0xff, 0x4e, 0x2d, 0x65, 0x87]);

    expect(await decodePreviewText(new Blob([bytes]))).toBe("中文");
  });
});
