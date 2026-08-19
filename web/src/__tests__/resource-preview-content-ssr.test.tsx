import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";

import { getFileCategory, ResourcePreviewContent } from "../../components/knowledge/ResourcePreviewContent";
import i18n from "../i18n";
import type { KnowledgeResourceInfo } from "../types/knowledge";

function resource(sourceName: string): KnowledgeResourceInfo {
  return {
    id: "resource-id",
    knowledgeBaseId: "knowledge-base-id",
    sourceName,
    sourceType: "upload",
    sourcePath: null,
    remoteId: null,
    status: "ready",
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function renderPreview(sourceName: string) {
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ResourcePreviewContent, { resource: resource(sourceName), kbId: "knowledge-base-id" }),
    ),
  );
}

describe("ResourcePreviewContent 服务端渲染", () => {
  // 文件扩展名必须被归入正确的预览策略，未知类型才安全地走下载降级。
  test("按扩展名归类可预览与未知文件", () => {
    expect(getFileCategory("manual.PDF")).toBe("pdf");
    expect(getFileCategory("diagram.svg")).toBe("image");
    expect(getFileCategory("notes.markdown")).toBe("markdown");
    expect(getFileCategory("data.csv")).toBe("spreadsheet");
    expect(getFileCategory("recording.webm")).toBe("video");
    expect(getFileCategory("archive.bin")).toBe("other");
  });

  // 视频预览必须提供 media source 的正确 MIME 类型，避免浏览器以错误解码器播放。
  test("视频文件渲染对应 MIME 的媒体源", () => {
    const html = renderPreview("walkthrough.webm");

    expect(html).toContain("<video");
    expect(html).toContain('src="/web/knowledgeBases/knowledge-base-id/resources/resource-id/file"');
    expect(html).toContain('type="video/webm"');
    expect(html).toContain('preload="metadata"');
  });

  // Markdown 和纯文本在服务端尚未取得内容时必须展示受控错误，不渲染不可信内容。
  test("文本型文件初始状态展示加载失败占位", () => {
    const markdown = renderPreview("readme.md");
    const text = renderPreview("runtime.log");

    expect(markdown).toContain("preview.loadError");
    expect(text).toContain("preview.loadError");
    expect(markdown).not.toContain("<pre");
    expect(text).not.toContain("<pre");
  });

  // Office 文件转换结果未知时应保持转换中状态，不能过早回退为不安全的文档嵌入。
  test("Office 文件初始状态展示转换进度", () => {
    const html = renderPreview("proposal.docx");

    expect(html).toContain("preview.converting");
    expect(html).toContain("animate-spin");
    expect(html).not.toContain("srcDoc=");
  });

  // PDF 预览应保留资源标题并隐藏浏览器侧栏，避免展示无关导航。
  test("PDF 文件渲染受限的内嵌预览", () => {
    const html = renderPreview("guide.pdf");

    expect(html).toContain('title="guide.pdf"');
    expect(html).toContain("/web/knowledgeBases/knowledge-base-id/resources/resource-id/file#navpanes=0");
  });

  // 图片预览仅输出资源 URL 与描述文本，不经过 HTML 内容注入。
  test("图片文件渲染带替代文本的图片预览", () => {
    const html = renderPreview("architecture.png");

    expect(html).toContain('<img src="/web/knowledgeBases/knowledge-base-id/resources/resource-id/file"');
    expect(html).toContain('alt="architecture.png"');
  });

  // HTML 内容尚未在服务端加载时应显示加载失败占位，不渲染不受信任的 srcDoc。
  test("HTML 文件初始状态展示安全错误占位", () => {
    const html = renderPreview("untrusted.html");

    expect(html).toContain("preview.loadError");
    expect(html).not.toContain("srcDoc=");
  });

  // 表格解析依赖客户端副作用，服务端初始渲染应保持加载状态而不发起网络请求。
  test("表格文件初始状态展示加载指示器", () => {
    const html = renderPreview("report.csv");

    expect(html).toContain("animate-spin");
    expect(html).not.toContain("<table");
  });

  // 未支持格式只能提供带 noreferrer 的下载链接，防止新窗口获得 opener 访问权。
  test("未知文件提供安全下载降级", () => {
    const html = renderPreview("payload.bin");

    expect(html).toContain("preview.unsupported");
    expect(html).toContain('download="payload.bin"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });
});
