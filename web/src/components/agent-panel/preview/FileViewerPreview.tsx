import { imagePlugin, officePlugin, pdfPlugin, textPlugin } from "@open-file-viewer/core";
import { FileViewer } from "@open-file-viewer/react";
import pdfjsWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { ErrorInfo, ReactNode } from "react";
import { Component, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";
import { buildPreviewUrl } from "./utils";

// 导入官方样式
import "@open-file-viewer/core/style.css";

interface FileViewerPreviewProps {
  envId: string;
  filePath: string;
}

/** 模块级常量，避免重复创建插件实例 */
const plugins = [imagePlugin(), pdfPlugin({ workerSrc: pdfjsWorkerUrl }), officePlugin(), textPlugin()];

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
      />
    </FileViewerErrorBoundary>
  );
}
