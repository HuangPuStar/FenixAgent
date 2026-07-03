import { useRequest } from "ahooks";
import { Code2, Eye, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fsApi } from "@/src/api/fs";
import { unwrap } from "@/src/api/request";
import { NS } from "../../../i18n";
import { CodePreview } from "./CodePreview";
import { buildPreviewUrl } from "./utils";

interface HtmlPreviewProps {
  envId: string;
  filePath: string;
}

type ViewMode = "preview" | "source";

/**
 * HTML 文件预览：支持「渲染预览」与「源码」两种模式切换。
 *
 * 渲染模式用 iframe 加载 buildPreviewUrl，相对路径资源（CSS/JS/图片）可正常解析；
 * sandbox 同时开启 allow-scripts 与 allow-same-origin，因为 workspace 内的相对资源
 * 需要携带 cookie 才能通过 /web/environments/* 的认证。这里的 HTML 来自用户自己
 * 上传的 workspace 文件，非外部不可信内容，风险可控。
 *
 * 源码模式按需通过 fileApi.readFile 拉取内容。
 */
export function HtmlPreview({ envId, filePath }: HtmlPreviewProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const [mode, setMode] = useState<ViewMode>("preview");
  const [loading, setLoading] = useState(true);
  const [sourceRequested, setSourceRequested] = useState(false);

  const src = buildPreviewUrl(envId, filePath);

  const handleLoad = useCallback(() => {
    setLoading(false);
  }, []);

  // 文件切换时重置源码缓存，避免显示上一个文件的内容
  // biome-ignore lint/correctness/useExhaustiveDependencies: 监听 props 变化重置内部 state
  useEffect(() => {
    setSourceRequested(false);
    setLoading(true);
  }, [envId, filePath]);

  // 按需加载源码：只有切换到源码模式且尚未请求过时才发起请求
  const { data: source, loading: sourceLoading } = useRequest(() => unwrap(fsApi.readFile(envId, filePath)), {
    ready: mode === "source" && sourceRequested,
    refreshDeps: [envId, filePath, mode],
  });

  const handleSwitchToSource = useCallback(() => {
    setMode("source");
    setSourceRequested(true);
  }, []);

  const fileName = filePath.split("/").pop() ?? filePath;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 模式切换栏 */}
      <div className="flex items-center gap-1 px-3 py-1.5 shrink-0 border-b bg-surface-2/50">
        <button
          type="button"
          onClick={() => setMode("preview")}
          className={`h-7 px-2.5 flex items-center gap-1.5 rounded text-xs font-medium transition-colors ${
            mode === "preview"
              ? "bg-surface-1 text-text-primary shadow-sm"
              : "text-text-muted hover:text-text-primary hover:bg-surface-1/50"
          }`}
          title={t("fileTree.preview.htmlPreview")}
        >
          <Eye className="h-3.5 w-3.5" />
          {t("fileTree.preview.htmlPreview")}
        </button>
        <button
          type="button"
          onClick={handleSwitchToSource}
          className={`h-7 px-2.5 flex items-center gap-1.5 rounded text-xs font-medium transition-colors ${
            mode === "source"
              ? "bg-surface-1 text-text-primary shadow-sm"
              : "text-text-muted hover:text-text-primary hover:bg-surface-1/50"
          }`}
          title={t("fileTree.preview.htmlSource")}
        >
          <Code2 className="h-3.5 w-3.5" />
          {t("fileTree.preview.htmlSource")}
        </button>
      </div>

      {/* 内容区 */}
      {mode === "preview" ? (
        <div className="flex-1 relative bg-white">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-surface-1">
              <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
            </div>
          )}
          <iframe
            src={src}
            title={fileName}
            onLoad={handleLoad}
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin"
          />
        </div>
      ) : (
        <>
          {sourceLoading && (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
            </div>
          )}
          {!sourceLoading && source?.content && <CodePreview content={source.content} filePath={filePath} />}
        </>
      )}
    </div>
  );
}
