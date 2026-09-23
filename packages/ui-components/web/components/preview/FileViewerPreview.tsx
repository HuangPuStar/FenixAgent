/**
 * 文件预览器（从 apps/web 的 `agent-panel/preview/FileViewerPreview.tsx` 复制并纯化）。
 *
 * 依赖 `@open-file-viewer/core` + `@open-file-viewer/react` 渲染，配套两个本地插件
 * （`html-plugin` 渲染 HTML、`native-pdf-plugin` 走浏览器原生 PDF），并按文件类型决定
 * 是否以 Blob 形式加载（保留原始字节数，见 `preview-source.ts`）。
 *
 * 纯化取舍：
 * 1. i18n：`NS.COMPONENTS` → 包内 `UI_COMPONENTS_NS`，文案键仍是 `fileTree.preview.*`，
 *    对应字典在 `web/i18n/locales/{en,zh}/uiComponents.json`。
 * 2. `buildPreviewUrl` 改为可选 prop：默认值仍指向源宿主的文件代理路由
 *    `/web/environments/<envId>/fs/<path>?preview=true`（见「已知限制」），
 *    宿主注入自己的实现即可完全解除路由耦合。
 * 3. 重试参数按 URL 是否已含 `?` 选择分隔符 —— 源实现硬编码 `&`，仅在默认构建器下成立，
 *    自定义构建器返回无 query 的 URL 时会拼出非法地址。
 * 4. `locale="zh-CN"` 与内置中文文案 `zhCNMessages` 改为 `locale` / `messages` props，
 *    默认值与源实现一致（zh-CN + 内置中文），宿主可传 `en-US` 或覆盖部分键。
 * 5. 错误边界内的中文串（「预览组件加载失败」）与源实现保持一致：它是 React 边界内的兜底提示，
 *    不是预览器文案，未纳入 props；需要多语言的宿主应在外层包一层本地化边界。
 * 6. `overrides.css` 与组件同目录并由本文件 import（工具栏置底等外观修正），
 *    缺失会导致预览工具栏回到顶部。
 */

import type { PreviewLocale, PreviewMessages } from "@open-file-viewer/core";
import { imagePlugin, officePlugin, textPlugin } from "@open-file-viewer/core";
import { FileViewer } from "@open-file-viewer/react";
import type { ErrorInfo, ReactNode } from "react";
import { Component, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { htmlPreviewPlugin } from "./html-plugin";
import { nativePdfPlugin } from "./native-pdf-plugin";
import { getPreviewMimeType, loadByteAccuratePreviewSource, shouldLoadPreviewAsBlob } from "./preview-source";

// 导入官方样式
import "@open-file-viewer/core/style.css";
// 包内样式覆盖（工具栏置底等）
import "./overrides.css";

export interface FileViewerPreviewProps {
  /** 环境标识；默认 URL 构建器用它拼宿主文件代理路由。 */
  envId: string;
  /** workspace 相对路径（同时用于展示文件名与推断 MIME）。 */
  filePath: string;
  /**
   * 预览 URL 构建器。默认实现沿用源宿主的文件代理路由约定
   * （`/web/environments/<envId>/fs/<path>?preview=true`，见 README「已知限制」）；
   * 宿主注入自己的实现即可解除该路由依赖。
   */
  buildPreviewUrl?: (envId: string, filePath: string) => string;
  /** 预览器内置文案，默认简体中文；宿主可按语言整体注入或只覆盖部分键。 */
  messages?: Partial<PreviewMessages>;
  /** 预览器 locale，默认 `"zh-CN"`。 */
  locale?: PreviewLocale;
}

/**
 * 默认预览 URL 构建器（逐字保留源实现）。
 *
 * 按路径段分别 encodeURIComponent，避免中文等非 ASCII 字符在浏览器→Vite 代理→后端
 * 的链路上产生编码歧义。分隔符 / 不编码，保持路径结构。
 *
 * 已知限制：返回值硬编码源宿主的路由 `/web/environments/<envId>/fs/<path>?preview=true`，
 * 本包不定义该路由；不使用该约定的宿主必须传入 `buildPreviewUrl`。
 */
function defaultBuildPreviewUrl(envId: string, filePath: string): string {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return `/web/environments/${envId}/fs/${encodedPath}?preview=true`;
}

/** 中文内置文案，覆盖 @open-file-viewer 默认英文（源实现保留；作为 `messages` prop 的默认值） */
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
          {/* 兜底提示硬编码中文，与源实现一致（见文件头注释第 5 条） */}
          <span className="text-xs font-medium text-red-500">预览组件加载失败</span>
          <span className="text-3xs text-text-muted break-all">{this.state.errorMessage}</span>
        </div>
      );
    }
    return this.props.children;
  }
}

export function FileViewerPreview({
  envId,
  filePath,
  buildPreviewUrl = defaultBuildPreviewUrl,
  messages = zhCNMessages,
  locale = "zh-CN",
}: FileViewerPreviewProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const previewUrl = useMemo(() => buildPreviewUrl(envId, filePath), [buildPreviewUrl, envId, filePath]);
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
    // 重试参数：URL 可能由自定义构建器提供、未必带 query，故按是否已含 `?` 选择分隔符
    const separator = previewUrl.includes("?") ? "&" : "?";
    const requestUrl = reloadKey === 0 ? previewUrl : `${previewUrl}${separator}retry=${reloadKey}`;
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
        {/* 错误消息来自 loadByteAccuratePreviewSource，为中文硬编码（与源实现一致） */}
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
        locale={locale}
        messages={messages}
      />
    </FileViewerErrorBoundary>
  );
}
