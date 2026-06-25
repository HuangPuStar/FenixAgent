import { AlertCircle, Globe, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { agentSitesApi } from "@/src/api/sdk";
import { useCardEmit } from "@/src/lib/card-renderer";

interface AgentSitesCardProps {
  /** 后端 site 的 ID（由 streamdown 从 HTML attribute agent-site-id 传入） */
  "agent-site-id": string;
}

/**
 * AgentSitesCard — 聊天消息中的站点卡片。
 * 由 streamdown 根据 LLM 输出的 <agent-sites agent-site-id="app-xxxx"/> 标签渲染。
 *
 * 功能：
 * - 挂载时调用 agentSitesApi.get(id) 获取站点详情
 * - Loading：骨架卡片（Loader2 + "加载中…"）
 * - Error：错误卡片（AlertCircle + "加载失败"），仍可点击 dispatch 事件
 * - Success：站点卡片（Globe + 站点名称 + site ID 副文本）
 * - 点击时通过 window CustomEvent 通知 ArtifactsPanel 切到 Sites 模式并选中此 site
 * - 成功加载后 emit "render" 事件用于生命周期跟踪
 */
export function AgentSitesCard(props: AgentSitesCardProps) {
  const agentSiteId = props["agent-site-id"];
  const emit = useCardEmit();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [siteName, setSiteName] = useState<string | null>(null);

  // 仅挂载时执行一次：agentSiteId/emit 不应作为重触发依赖，cleanup 由 cancelled flag 保证
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅挂载时执行一次
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    agentSitesApi
      .get(agentSiteId)
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

  // ── Loading 状态 ──
  if (loading) {
    return (
      <button
        type="button"
        disabled
        className="flex items-center gap-3 p-3 rounded-lg border border-border/40 bg-surface-1 max-w-sm w-full text-left"
      >
        <div className="h-9 w-9 rounded-full bg-brand/10 flex items-center justify-center shrink-0">
          <Loader2 className="h-4 w-4 text-brand animate-spin" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-text-muted">加载中…</div>
        </div>
      </button>
    );
  }

  // ── Error 状态 ──
  if (error) {
    return (
      <button
        type="button"
        onClick={handleClick}
        className="flex items-center gap-3 p-3 rounded-lg border border-border/40 bg-surface-1 hover:bg-surface-2/60 transition-colors max-w-sm w-full text-left cursor-pointer"
        title={error}
      >
        <div className="h-9 w-9 rounded-full bg-red-500/10 flex items-center justify-center shrink-0">
          <AlertCircle className="h-4 w-4 text-red-500" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-text-muted">加载失败</div>
        </div>
      </button>
    );
  }

  // ── Success 状态 ──
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
        <div className="text-sm font-medium text-text-primary truncate" title={siteName || ""}>
          {siteName}
        </div>
        <div className="text-[11px] text-text-muted truncate mt-0.5" title={agentSiteId}>
          {agentSiteId}
        </div>
      </div>
    </button>
  );
}
