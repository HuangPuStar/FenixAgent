import type { PreviewMessages } from "@open-file-viewer/core";
import { imagePlugin, officePlugin, textPlugin } from "@open-file-viewer/core";
import { FileViewer } from "@open-file-viewer/react";
import type { ErrorInfo, ReactNode } from "react";
import { Component, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";
import { htmlPreviewPlugin } from "./html-plugin";
import { nativePdfPlugin } from "./native-pdf-plugin";
import { buildPreviewUrl, getPreviewMimeType, loadByteAccuratePreviewSource, shouldLoadPreviewAsBlob } from "./utils";

// 导入官方样式
import "@open-file-viewer/core/style.css";
// 项目自定义样式覆盖（工具栏置底等）
import "./overrides.css";

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
  const mimeType = useMemo(() => getPreviewMimeType(filePath), [filePath]);
  const loadAsBlob = useMemo(() => shouldLoadPreviewAsBlob(filePath), [filePath]);
  const [previewSource, setPreviewSource] = useState<string | Blob | null>(() => (loadAsBlob ? null : previewUrl));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!loadAsBlob) {
      setPreviewSource(previewUrl);
      setLoadError(null);
      return;
    }

    const controller = new AbortController();
    setPreviewSource(null);
    setLoadError(null);
    const requestUrl = reloadKey === 0 ? previewUrl : `${previewUrl}&retry=${reloadKey}`;
    void loadByteAccuratePreviewSource(requestUrl, fetch, { signal: controller.signal })
      .then(setPreviewSource)
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [loadAsBlob, previewUrl, reloadKey]);

  const toolbar = useMemo(
    () => ({
      zoom: false,
      rotate: false,
      download: true,
      fullscreen: true,
      search: false,
      labels: {
        download: t("fileTree.preview.download", "下载"),
        fullscreen: t("fileTree.preview.fullscreen", "全屏"),
      },
    }),
    [t],
  );

  const plugins = useMemo(
    () => [imagePlugin(), nativePdfPlugin(), officePlugin(), htmlPreviewPlugin(), textPlugin()],
    [],
  );

  if (loadError) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-4 gap-3" role="alert">
        <span className="text-xs font-medium text-red-500">{loadError}</span>
        <button
          type="button"
          className="text-xs text-primary hover:underline"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          {t("fileTree.preview.retry", "重试")}
        </button>
      </div>
    );
  }

  if (previewSource === null) {
    return (
      <div className="flex-1 flex items-center justify-center p-4" role="status">
        <span className="text-xs text-text-muted">{t("fileTree.preview.loading", "加载中...")}</span>
      </div>
    );
  }

  return (
    <FileViewerErrorBoundary filePath={filePath}>
      <FileViewer
        file={previewSource}
        fileName={fileName}
        mimeType={mimeType}
        plugins={plugins}
        height="100%"
        fit="width"
        toolbar={toolbar}
        theme="auto"
        locale="zh-CN"
        messages={zhCNMessages}
      />
    </FileViewerErrorBoundary>
  );
}
