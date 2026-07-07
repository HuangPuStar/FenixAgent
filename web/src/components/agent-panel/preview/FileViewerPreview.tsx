import type { PreviewMessages } from "@open-file-viewer/core";
import { imagePlugin, officePlugin, pdfPlugin, textPlugin } from "@open-file-viewer/core";
import { FileViewer } from "@open-file-viewer/react";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { ErrorInfo, ReactNode } from "react";
import { Component, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";
import { htmlPreviewPlugin } from "./html-plugin";
import { buildPreviewUrl } from "./utils";

// 导入官方样式
import "@open-file-viewer/core/style.css";

interface FileViewerPreviewProps {
  envId: string;
  filePath: string;
}

/** 中文内置文案，覆盖 @open-file-viewer 默认英文 */
const zhCNMessages: Partial<PreviewMessages> = {
  loading: "加载中...",
  unsupportedTitle: "暂不支持此格式",
  downloadTitle: "下载文件",
  downloadFile: "下载",
  file: "文件",
  unnamedFile: "未命名文件",
  format: "格式",
  unknown: "未知",
  mime: "MIME 类型",
  undeclared: "未声明",
  size: "大小",
  source: "来源",
  remoteUrl: "远程 URL",
  localFile: "本地文件",
};

/** 错误边界：防止 FileViewer 内部异常导致父组件状态异常 */
class FileViewerErrorBoundary extends Component<
  { children: ReactNode; filePath: string },
  { hasError: boolean; errorMessage: string }
> {
  constructor(props: { children: ReactNode; filePath: string }) {
    super(props);
    this.state = { hasError: false, errorMessage: "" };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, errorMessage: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[FileViewerPreview] 预览组件异常", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center p-4 gap-2">
          <span className="text-xs font-medium text-red-500">预览组件加载失败</span>
          <span className="text-[11px] text-text-muted break-all">{this.state.errorMessage}</span>
        </div>
      );
    }
    return this.props.children;
  }
}

export function FileViewerPreview({ envId, filePath }: FileViewerPreviewProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const previewUrl = useMemo(() => buildPreviewUrl(envId, filePath), [envId, filePath]);
  const fileName = useMemo(() => filePath.split("/").pop() ?? filePath, [filePath]);

  const toolbar = useMemo(
    () => ({
      zoom: true,
      rotate: true,
      download: true,
      fullscreen: true,
      search: true,
      labels: {
        download: t("fileTree.preview.download", "下载"),
        fullscreen: t("fileTree.preview.fullscreen", "全屏"),
        search: t("fileTree.preview.search", "搜索"),
      },
    }),
    [t],
  );

  const plugins = useMemo(
    () => [imagePlugin(), pdfPlugin({ workerSrc: pdfjsWorkerUrl }), officePlugin(), htmlPreviewPlugin(), textPlugin()],
    [],
  );

  return (
    <FileViewerErrorBoundary filePath={filePath}>
      <FileViewer
        file={previewUrl}
        fileName={fileName}
        plugins={plugins}
        height="100%"
        toolbar={toolbar}
        theme="auto"
        locale="zh-CN"
        messages={zhCNMessages}
      />
    </FileViewerErrorBoundary>
  );
}
