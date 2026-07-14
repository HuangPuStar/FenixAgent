import { AlertCircle, ArrowRight, Globe, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { agentSitesApi } from "@/src/api/sites";
import { useCardEmit } from "@/src/lib/card-renderer";
import { cn } from "@/src/lib/utils";

interface AgentSitesCardProps {
  /** 远端 site 的 remoteAppId（由 streamdown 从 HTML attribute agent-site-id 传入），前端据此拼出同源地址 */
  "agent-site-id": string;
}

/**
 * AgentSitesCard — 聊天消息中的站点卡片。
 * 由 streamdown 根据 <agent-sites agent-site-id="app-xxxx"/> 标签渲染。
 *
 * 卡片布局：上方小尺寸 iframe 实时预览 + 下方信息栏（图标 + 名称 +「查看站点」按钮）。
 * iframe 地址由前端同源路径 `/web/site/deploy/{agent-site-id}/` 拼接，不再依赖 agent 传入 url。
 */
export function AgentSitesCard(props: AgentSitesCardProps) {
  const agentSiteId = props["agent-site-id"];
  const siteUrl = agentSiteId ? `/web/site/deploy/${agentSiteId}/` : null;
  const emit = useCardEmit();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [siteName, setSiteName] = useState<string | null>(null);

  // 仅挂载时执行一次：agentSiteId/emit 不应作为重触发依赖，cleanup 由 cancelled flag 保证
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅挂载时执行一次
  useEffect(() => {
    if (!agentSiteId) {
      setError("缺少 agent-site-id 属性");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    agentSitesApi
      .getByRemote(agentSiteId)
      .then((res) => {
        if (cancelled) return;
        const data = (res as { success?: boolean; data?: { name?: string } }).data;
        setSiteName(data?.name || "Unknown Site");
        emit("render", { siteId: agentSiteId });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("[AgentSitesCard] 加载站点详情失败", err);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleClick = useCallback(() => {
    window.dispatchEvent(new CustomEvent("artifacts:select-site", { detail: { siteId: agentSiteId } }));
  }, [agentSiteId]);

  // ── Loading ──
  if (loading) {
    return (
      <div className="w-full rounded-lg border border-border/40 bg-surface-1 p-3">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-full bg-brand/10 flex items-center justify-center shrink-0">
            <Loader2 className="h-4 w-4 text-brand animate-spin" />
          </div>
          <div className="text-sm text-text-muted">正在获取站点信息…</div>
        </div>
      </div>
    );
  }

  // ── Error ──
  if (error) {
    const isMissingAttr = error.includes("缺少 agent-site-id");
    return (
      <div
        className={cn(
          "w-full rounded-lg border p-3",
          isMissingAttr ? "border-yellow-500/30 bg-yellow-500/5" : "border-red-500/30 bg-red-500/5",
        )}
      >
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "h-8 w-8 rounded-full flex items-center justify-center shrink-0",
              isMissingAttr ? "bg-yellow-500/10" : "bg-red-500/10",
            )}
          >
            <AlertCircle className={cn("h-4 w-4", isMissingAttr ? "text-yellow-500" : "text-red-500")} />
          </div>
          <div className="text-sm text-text-muted">{isMissingAttr ? "缺少站点 ID" : "站点信息加载失败"}</div>
        </div>
      </div>
    );
  }

  // ── Success ──
  const displayName = siteName || agentSiteId || "Unknown Site";

  return (
    <div className="w-full rounded-lg border border-border/40 bg-surface-1 overflow-hidden">
      {/* 上方：小尺寸 iframe 预览（有 url 时显示） */}
      {siteUrl && (
        <div className="w-full" style={{ height: 180 }}>
          <iframe
            src={siteUrl}
            title={displayName}
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-forms allow-same-origin"
            referrerPolicy="no-referrer"
          />
        </div>
      )}

      {/* 下方：信息栏 + 按钮 */}
      <div className="flex items-center justify-between gap-3 p-3">
        {/* 左侧：图标 + 信息 */}
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-8 w-8 rounded-full bg-brand/10 flex items-center justify-center shrink-0">
            <Globe className="h-4 w-4 text-brand" />
          </div>
          <div className="min-w-0">
            <div className="text-sm text-text-primary">您的站点已生成</div>
            <div className="text-xs text-text-muted truncate mt-0.5">
              {displayName} · {agentSiteId}
            </div>
          </div>
        </div>

        {/* 右侧：操作按钮 */}
        <button
          type="button"
          onClick={handleClick}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-brand/10 hover:bg-brand/20 text-brand text-xs font-medium transition-colors shrink-0 cursor-pointer"
        >
          查看站点
          <ArrowRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
