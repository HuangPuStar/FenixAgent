import "./ResourcePreviewContent.css";

import { getFileExtension } from "@fenix/ui-components/components/file-icon-helper";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { kbApi } from "../../api/knowledge-bases";
import { sanitizeRichHtml } from "../../lib/sanitize-html";
import type { KnowledgeResourceInfo } from "../../types/knowledge";
import { getFileCategory, getVideoMimeType } from "./resource-preview-model";
import {
  MarkdownSkeleton,
  PreviewPlaceholder,
  TextSkeleton,
  UnsupportedPreview,
} from "./resource-preview-placeholders";
import { SpreadsheetPreview } from "./spreadsheet-preview";
import { useResourcePreview } from "./use-resource-preview";

interface ResourcePreviewContentProps {
  /** 要预览的知识库资源 */
  resource: KnowledgeResourceInfo;
  /** 知识库 ID，用于构造文件 URL */
  kbId: string;
}

/**
 * 可复用的文档预览内容组件（§3.5 三层拆分里的第三层：渲染）。
 *
 * 从 ResourcePreviewDialog 中提取，支持 PDF/图片/视频/Markdown/文本/HTML/Excel(表格)/Office 预览。
 * 不包含外层 Dialog/Sheet 容器，仅渲染预览区域，可在 Dialog、Sheet 或全屏布局中复用。
 *
 * 预览策略：
 * - PDF/图片/视频：直接 URL 渲染
 * - Markdown/文本/HTML：经域模块读取内容后渲染
 * - 表格(xlsx/xls/csv)：用 xlsx 库前端解析为 HTML 表格
 * - Office(Word/PPT)：优先服务端 PDF 转换，不可用时 docx 用 mammoth，其余降级为下载
 *
 * 2026-09-23 §4.8 拆分后的分工：类别判据在 `resource-preview-model.ts`，正文取数与 Office 探测在
 * `use-resource-preview.ts`，骨架 / 失败占位 / 下载兜底在 `resource-preview-placeholders.tsx`，
 * 表格预览在 `spreadsheet-preview.tsx`；本文件只按 `category` 分发。
 */
export function ResourcePreviewContent({ resource, kbId }: ResourcePreviewContentProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);
  const category = getFileCategory(resource.sourceName);
  const fileUrl = kbApi.getFileUrl({ kbId, resourceId: resource.id });
  const pdfUrl = category === "office" ? kbApi.getPdfUrl({ kbId, resourceId: resource.id }) : "";

  const { fetchedContent, fetchLoading, fetchError, officeMode, officeLoading, docxHtml } = useResourcePreview({
    kbId,
    resourceId: resource.id,
    sourceName: resource.sourceName,
    category,
  });

  // ── 渲染各类型预览内容 ──
  const renderContent = () => {
    switch (category) {
      case "pdf":
        return (
          <iframe
            src={`${fileUrl}#navpanes=0`}
            title={resource.sourceName}
            className="w-full h-full min-h-0 rounded-md border border-border"
          />
        );

      case "video": {
        const ext = getFileExtension(resource.sourceName) || "mp4";
        return (
          <div className="flex-1 flex items-center justify-center bg-black/90 rounded-md p-4 min-h-0">
            <video controls preload="metadata" style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 8 }}>
              <source src={fileUrl} type={getVideoMimeType(ext)} />
            </video>
          </div>
        );
      }

      case "spreadsheet":
        return <SpreadsheetPreview kbId={kbId} resourceId={resource.id} filename={resource.sourceName} />;

      case "image":
        return (
          <div className="flex-1 flex items-center justify-center bg-slate-50 rounded-md p-4 min-h-0 overflow-auto">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={fileUrl}
              alt={resource.sourceName}
              className="max-w-full max-h-full object-contain rounded-lg shadow-md"
            />
          </div>
        );

      case "markdown":
        if (fetchLoading) return <MarkdownSkeleton />;
        if (fetchError || !fetchedContent) return <PreviewPlaceholder message={t("preview.loadError")} />;
        return (
          <div className="flex-1 overflow-auto p-6">
            <div className="resource-preview-content-markdown prose prose-sm max-w-none dark:prose-invert prose-headings:text-text-primary prose-p:text-text-primary prose-strong:text-text-primary prose-li:text-text-primary">
              {/* 输入是用户上传的知识库文件正文：走 rehype-sanitize 的 GitHub 默认 schema。
                  react-markdown 本身不渲染原始 HTML（未挂 rehype-raw），这里补的是第二道——
                  白名单外的标签（script / iframe / form / svg…）、危险协议与事件属性全部剥掉。 */}
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                {fetchedContent}
              </ReactMarkdown>
            </div>
          </div>
        );

      case "text":
        if (fetchLoading) return <TextSkeleton />;
        if (fetchError || !fetchedContent) return <PreviewPlaceholder message={t("preview.loadError")} />;
        return (
          <pre className="flex-1 overflow-auto m-0 p-4 bg-surface-2 text-text-primary text-xs font-mono whitespace-pre-wrap break-all rounded-md border border-border">
            {fetchedContent}
          </pre>
        );

      case "html":
        if (fetchLoading) return <TextSkeleton />;
        if (fetchError || !fetchedContent) return <PreviewPlaceholder message={t("preview.loadError")} />;
        return (
          <iframe
            srcDoc={fetchedContent}
            title={resource.sourceName}
            // 文件正文是用户上传的 UGC（§6.1：与 Agent / LLM 输出同等不可信），且 `srcdoc` 文档继承
            // 父页面源：再给 allow-same-origin 就等于把沙箱交给里面的脚本（可自行摘掉 sandbox 读宿主
            // DOM 与 sessionStorage）。保留 allow-scripts 让预览页自己的脚本仍能跑，但跑在 opaque origin。
            sandbox="allow-scripts"
            className="w-full h-full min-h-0 rounded-md border border-border bg-white"
          />
        );

      case "office": {
        // Office 文档：优先级 PDF 转换 > mammoth(docx) > 下载
        if (officeMode === "checking" || officeLoading) {
          return <Spinner variant="panel" size="lg" label={t("preview.converting")} />;
        }

        if (officeMode === "pdf") {
          return (
            <iframe
              src={`${pdfUrl}#navpanes=0`}
              title={resource.sourceName}
              className="w-full h-full min-h-0 rounded-md border border-border"
            />
          );
        }

        if (officeMode === "docxHtml" && docxHtml) {
          return (
            <div className="flex-1 overflow-auto p-6">
              <div
                className="resource-preview-content-docx prose prose-sm max-w-none dark:prose-invert"
                // Mammoth 的输出不是可信 HTML（docx 可携带任意标签与属性）：按来源取
                // `sanitizeRichHtml` 的显式白名单清洗后再注入（§6.1，白名单见 `../../lib/sanitize-html`）。
                // biome-ignore lint/security/noDangerouslySetInnerHtml: 同一行的 sanitizeRichHtml 已清洗（mammoth 输出不可直接注入）
                dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(docxHtml) }}
              />
            </div>
          );
        }

        // fallback：PDF 转换不可用且非 Word 文档（或 mammoth 也失败）
        return <UnsupportedPreview fileUrl={fileUrl} filename={resource.sourceName} />;
      }

      default:
        return <UnsupportedPreview fileUrl={fileUrl} filename={resource.sourceName} />;
    }
  };

  return <div className="flex flex-col h-full min-h-0">{renderContent()}</div>;
}
