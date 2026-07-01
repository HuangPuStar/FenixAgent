import { useRequest } from "ahooks";
import { FileX, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { fileApi } from "@/src/api/files";
import { unwrap } from "@/src/api/request";
import { NS } from "../../i18n";
import { BinaryInfoPreview } from "./preview/BinaryInfoPreview";
import { CodePreview } from "./preview/CodePreview";
import { HtmlPreview } from "./preview/HtmlPreview";
import { ImagePreview } from "./preview/ImagePreview";
import { MarkdownPreview } from "./preview/MarkdownPreview";
import { PdfPreview } from "./preview/PdfPreview";
import { TablePreview } from "./preview/TablePreview";
import { classifyFile, formatFileSize } from "./preview/utils";

interface PreviewTabProps {
  envId: string | null;
  filePath: string | null;
}

export function PreviewTab({ envId, filePath }: PreviewTabProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const category = filePath ? classifyFile(filePath) : null;

  // 图片、PDF、表格、HTML 直接由子组件通过 URL 处理，不需要 readFile API
  const skipApi = category === "image" || category === "pdf" || category === "table" || category === "html";
  const needsApi = !!(envId && filePath && category && !skipApi);

  const {
    data: fileData,
    loading,
    error,
  } = useRequest(() => unwrap(fileApi.readFile(envId!, filePath!)), {
    ready: needsApi,
    refreshDeps: [envId, filePath],
  });

  // 从 API 响应中提取内容；skipApi 类型的 content 为 null
  const content: string | null = skipApi || typeof fileData?.content !== "string" ? null : fileData.content;
  // 文件名优先使用 API 返回的 name，skipApi 类型从路径提取
  const fileName: string | null = skipApi
    ? filePath
      ? (filePath.split("/").pop() ?? filePath)
      : null
    : (fileData?.name ?? (filePath ? (filePath.split("/").pop() ?? filePath) : null));
  const fileSize: number | undefined = skipApi ? undefined : fileData?.size;

  // 非 binary 且无文本内容时视为不支持预览
  const apiFailed = !!error || (needsApi && fileData && category !== "binary" && typeof fileData.content !== "string");

  return (
    <div className="flex-1 overflow-hidden flex flex-col h-full">
      <div className="flex-1 overflow-auto flex flex-col">
        {loading && (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
          </div>
        )}
        {/* 加载失败：展示"暂不支持预览"卡片 */}
        {!loading && apiFailed && fileName && (
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="flex flex-col items-center gap-3 max-w-xs text-center">
              <div className="w-16 h-16 rounded-xl bg-surface-2 flex items-center justify-center">
                <FileX className="h-8 w-8 text-text-muted" />
              </div>
              <p className="text-sm font-medium text-text-primary break-all">{fileName}</p>
              {fileSize !== undefined && <span className="text-xs text-text-muted">{formatFileSize(fileSize)}</span>}
              <p className="text-xs text-text-muted mt-1">{t("fileTree.preview.unsupportedType")}</p>
            </div>
          </div>
        )}
        {!loading && !error && !filePath && !fileName && (
          <div className="p-4 text-center text-sm text-text-muted">{t("fileTree.preview.noFileSelected")}</div>
        )}
        {!loading && !error && category === "code" && content !== null && (
          <CodePreview content={content} filePath={filePath!} />
        )}
        {!loading && !error && category === "markdown" && content !== null && <MarkdownPreview content={content} />}
        {!loading && !error && category === "image" && envId && <ImagePreview envId={envId} filePath={filePath!} />}
        {!loading && !error && category === "html" && envId && <HtmlPreview envId={envId} filePath={filePath!} />}
        {!loading && !error && category === "pdf" && envId && <PdfPreview envId={envId} filePath={filePath!} />}
        {!loading && !error && category === "table" && envId && (
          <TablePreview envId={envId} filePath={filePath!} content={content} />
        )}
        {!loading && !error && category === "binary" && <BinaryInfoPreview filePath={filePath!} fileSize={fileSize} />}
      </div>
    </div>
  );
}
