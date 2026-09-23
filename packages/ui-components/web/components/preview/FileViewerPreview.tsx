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
 * 4. `locale="zh-CN"` 与内置中文文案 `zhCNMessages` 改为「包内字典缺省 + props 覆盖」：缺省值随当前
 *    语言变化，`locale` / `messages` 仍是覆盖端口，宿主需要固定语言或注入自己的词表时照旧可用
 *    （见「已知限制」第 9 条）。
 * 5. 错误边界的兜底提示（源实现写死中文「预览组件加载失败」）纳入包内字典、由调用方按当前语言传入：
 *    它同样渲染给用户看，不再是「不随语言变化」的例外。
 * 6. `overrides.css` 与组件同目录并由本文件 import（工具栏置底等外观修正），
 *    缺失会导致预览工具栏回到顶部。
 */

import type { PreviewLocale, PreviewMessages } from "@open-file-viewer/core";
import { imagePlugin, officePlugin, textPlugin } from "@open-file-viewer/core";
import { FileViewer } from "@open-file-viewer/react";
import type { TFunction } from "i18next";
import type { ErrorInfo, ReactNode } from "react";
import { Component, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { ErrorFallback } from "../../ui/error-fallback";
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
  /** 预览器内置文案。缺省按当前语言取包内字典（`fileTree.preview.messages.*`）；传值时整块覆盖。 */
  messages?: Partial<PreviewMessages>;
  /** 预览器 locale（第三方格式化与内置词典都按它取）。缺省跟随当前语言：`zh*` → `zh-CN`，其余 → `en-US`。 */
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

/**
 * 预览器内置文案的缺省取值。
 *
 * 键与包内其余文案同在 `fileTree.preview.*` 组下，真相来源只有一份（`uiComponents` 字典）；
 * 源实现把这份中文写死在组件里，于是宿主切成英文后预览器信息栏仍是中文。
 * 逐键取值而不是拼 key 前缀：字典是打平的 JSON，显式列出才能在缺键时被字面量扫描抓到。
 */
function buildDefaultPreviewMessages(t: TFunction): Partial<PreviewMessages> {
  return {
    loading: t("fileTree.preview.messages.loading"),
    unsupportedTitle: t("fileTree.preview.messages.unsupportedTitle"),
    downloadTitle: t("fileTree.preview.messages.downloadTitle"),
    downloadFile: t("fileTree.preview.messages.downloadFile"),
    file: t("fileTree.preview.messages.file"),
    unnamedFile: t("fileTree.preview.messages.unnamedFile"),
    format: t("fileTree.preview.messages.format"),
    unknown: t("fileTree.preview.messages.unknown"),
    mime: t("fileTree.preview.messages.mime"),
    undeclared: t("fileTree.preview.messages.undeclared"),
    size: t("fileTree.preview.messages.size"),
    source: t("fileTree.preview.messages.source"),
    remoteUrl: t("fileTree.preview.messages.remoteUrl"),
    localFile: t("fileTree.preview.messages.localFile"),
  };
}

/**
 * 错误边界：防止 FileViewer 内部异常导致父组件状态异常。
 *
 * 降级 UI 用统一的 `ErrorFallback`（§7.1）：它自带重试按钮（§7.2），点重试即清掉 `hasError`、重新挂载
 * `FileViewer`。主文案经 `fallbackText` 由调用方注入（类组件用不了 `useTranslation`，语言只在外面拿得到）：
 * 提示是渲染给用户看的，必须跟随当前语言，不能像源实现那样在边界内写死中文。
 *
 * **不回显错误正文**（§7.2）：原始错误只进 `componentDidCatch` 的 `console.error`。此前降级 UI 会把
 * `error.message` 渲染成第二行文本——它可能含第三方解析器的内部细节，且不随语言变化。
 */
class FileViewerErrorBoundary extends Component<{ children: ReactNode; fallbackText: string }, { hasError: boolean }> {
  constructor(props: { children: ReactNode; fallbackText: string }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[FileViewerPreview] 预览组件异常", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <ErrorFallback
          message={this.props.fallbackText}
          resetErrorBoundary={() => this.setState({ hasError: false })}
        />
      );
    }
    return this.props.children;
  }
}

export function FileViewerPreview({
  envId,
  filePath,
  buildPreviewUrl = defaultBuildPreviewUrl,
  messages,
  locale,
}: FileViewerPreviewProps) {
  const { t, i18n } = useTranslation(UI_COMPONENTS_NS);
  // 缺省文案随语言重建（`t` 只在切语言时换身份），传入 `messages` 的宿主不受影响
  const previewMessages = useMemo(() => messages ?? buildDefaultPreviewMessages(t), [messages, t]);
  // locale 缺省跟随当前语言：第三方的日期/数字格式与内置词典都按它取，固定 zh-CN 会让英文界面出现中文格式
  const previewLocale: PreviewLocale = locale ?? (i18n.language?.startsWith("zh") ? "zh-CN" : "en-US");
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
        download: t("fileTree.preview.download"),
        fullscreen: t("fileTree.preview.fullscreen"),
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
          {t("fileTree.preview.retry")}
        </button>
      </div>
    );
  }

  if (previewSource === null) {
    return (
      <div className="flex-1 flex items-center justify-center p-4" role="status">
        <span className="text-xs text-text-muted">{t("fileTree.preview.loading")}</span>
      </div>
    );
  }

  return (
    <FileViewerErrorBoundary fallbackText={t("fileTree.preview.componentError")}>
      <FileViewer
        file={previewSource}
        fileName={fileName}
        mimeType={mimeType}
        plugins={plugins}
        height="100%"
        fit="width"
        toolbar={toolbar}
        theme="auto"
        locale={previewLocale}
        messages={previewMessages}
      />
    </FileViewerErrorBoundary>
  );
}
