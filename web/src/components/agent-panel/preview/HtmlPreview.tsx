import { Code2, Eye, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fileApi } from "@/src/api/sdk";
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
 * 源码模式按需通过 fileApi.readFile 拉取内容，通过按钮 onClick 触发而非 useEffect 驱动，
 * 避免 effect 依赖与状态更新相互触发导致的竞态（曾经出现"一直转圈"的问题）。
 */
export function HtmlPreview({ envId, filePath }: HtmlPreviewProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const [mode, setMode] = useState<ViewMode>("preview");
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<string | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  // 防止重复发起加载：useRef 不触发 re-render，也不会进入 effect 依赖
  const sourceLoadingRef = useRef(false);

  const src = buildPreviewUrl(envId, filePath);

  const handleLoad = useCallback(() => {
    setLoading(false);
  }, []);

  // 文件切换时重置源码缓存，避免显示上一个文件的内容。
  // 依赖 envId/filePath 是为了在文件变化时触发重置，虽然 effect 内部不直接读取它们，
  // 但这是有意的"监听变化"语义，不是无意义依赖。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 监听 props 变化重置内部 state
  useEffect(() => {
    setSource(null);
    setSourceLoading(false);
    sourceLoadingRef.current = false;
    setLoading(true);
  }, [envId, filePath]);

  const loadSource = useCallback(async () => {
    if (sourceLoadingRef.current) return;
    if (source !== null) return;
    sourceLoadingRef.current = true;
    setSourceLoading(true);
    const { data, error: err } = await fileApi.readFile({ id: envId, path: filePath });
    sourceLoadingRef.current = false;
    setSourceLoading(false);
    if (err) {
      console.error("Failed to load HTML source:", err);
      return;
    }
    if (data && typeof data.content === "string") {
      setSource(data.content);
    }
  }, [envId, filePath, source]);

  const handleSwitchToSource = useCallback(() => {
    setMode("source");
    void loadSource();
  }, [loadSource]);

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
          {!sourceLoading && source !== null && <CodePreview content={source} filePath={filePath} />}
        </>
      )}
    </div>
  );
}
