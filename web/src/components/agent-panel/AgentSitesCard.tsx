import { Globe } from "lucide-react";
import { useEffect } from "react";
import { useCardEmit } from "@/src/lib/card-renderer";

interface AgentSitesCardProps {
  url: string;
  title?: string;
}

/**
 * AgentSitesCard — 聊天消息中的外部站点卡片。
 * 由 streamdown 根据 LLM 输出的 <agent-sites> 标签渲染，接收 HTML attribute props（均为 string 类型）。
 *
 * 功能：
 * - 展示 Globe 图标 + 站点标题（默认显示 URL hostname）
 * - 点击时通过 window CustomEvent 通知 ArtifactsPanel 打开外部站点 iframe
 * - 挂载时 emit "render" 事件用于生命周期跟踪
 */
export function AgentSitesCard({ url, title }: AgentSitesCardProps) {
  const emit = useCardEmit();
  const hostname = safeHostname(url);
  const displayTitle = title || hostname;

  // 挂载时发送 render 事件，用于卡片生命周期跟踪。
  // 只触发一次——url/title/emit 不应作为重触发依赖。
  // biome-ignore lint/correctness/useExhaustiveDependencies: render 事件仅在挂载时发送一次
  useEffect(() => {
    emit("render", { url, title });
  }, []);

  const handleClick = () => {
    window.dispatchEvent(new CustomEvent("artifacts:open-site", { detail: { url, title: displayTitle } }));
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="flex items-center gap-3 p-3 rounded-lg border border-border/40 bg-surface-1 hover:bg-surface-2/60 transition-colors max-w-sm w-full text-left cursor-pointer"
    >
      <div className="h-9 w-9 rounded-full bg-brand/10 flex items-center justify-center shrink-0">
        <Globe className="h-4 w-4 text-brand" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary truncate" title={displayTitle}>
          {displayTitle}
        </div>
        <div className="text-[11px] text-text-muted truncate mt-0.5" title={url}>
          {url}
        </div>
      </div>
    </button>
  );
}

/** 从 URL 安全提取 hostname，无效 URL 返回原字符串 */
function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
