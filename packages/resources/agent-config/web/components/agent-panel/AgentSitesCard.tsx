import { useCardEmit } from "@fenix/ui-components/lib/card-renderer";
import { cn } from "@fenix/ui-components/lib/cn";
import { AlertCircle, ArrowRight, Globe, Loader2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { agentSitesApi } from "../../api/sites";
import { AGENTS_NS } from "../../i18n/namespace";
import { buildAgentSiteUrl } from "../../lib/agent-site-url";

interface AgentSitesCardProps {
  /** 远端 site 的 remoteAppId（由 streamdown 从 HTML attribute agent-site-id 传入），前端据此拼出同源地址 */
  "agent-site-id": string;
}

/**
 * 卡片失败态：缺属性是「调用方写错了标签」，请求失败才是「后端没给数据」，两者配色与文案都不同。
 *
 * 显式枚举而不是把错误消息本身当状态：旧写法用 `error.includes("缺少 agent-site-id")` 反查中文串，
 * 文案一旦本地化（改 key、切语言）判定就失效，缺属性反而会渲染成红色的「站点信息加载失败」。
 */
type CardErrorKind = "missing-attribute" | "load-failed";

/**
 * AgentSitesCard — 聊天消息中的站点卡片。
 * 由 streamdown 根据 <agent-sites agent-site-id="app-xxxx"/> 标签渲染。
 *
 * 卡片布局：上方小尺寸 iframe 实时预览 + 下方信息栏（图标 + 名称 +「查看站点」按钮）。
 * iframe 地址由 `buildAgentSiteUrl` 统一拼装（口径见 `web/lib/agent-site-url.ts`），不再依赖 agent 传入 url。
 *
 * 文案取本包 `agents` 命名空间（键在 `web/i18n/locales/{en,zh}/agents.json` 的 `sites.card.*`）：
 * 卡片渲染在宿主应用内，与包内其余页面同用一个已注册的单例，因此直接 `t()` 即可。
 */
export function AgentSitesCard(props: AgentSitesCardProps) {
  const agentSiteId = props["agent-site-id"];
  const siteUrl = agentSiteId ? buildAgentSiteUrl(agentSiteId) : null;
  const emit = useCardEmit();
  const { t } = useTranslation(AGENTS_NS);

  const [loading, setLoading] = useState(true);
  const [errorKind, setErrorKind] = useState<CardErrorKind | null>(null);
  const [siteName, setSiteName] = useState<string | null>(null);

  // 仅挂载时执行一次：agentSiteId/emit 不应作为重触发依赖（依赖变化重跑会重复请求并重复上报 render
  // 事件），cleanup 由 cancelled flag 保证。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 一次性挂载是刻意行为，补齐依赖会改变语义；源文件位于 apps/web 时未声明 react 依赖、规则未启用，包内按 T2e 声明 react 后该规则才生效。
  useEffect(() => {
    if (!agentSiteId) {
      setErrorKind("missing-attribute");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErrorKind(null);
    agentSitesApi
      .getByRemote(agentSiteId)
      .then((res) => {
        if (cancelled) return;
        const data = (res as { success?: boolean; data?: { name?: string } }).data;
        // 空名字按「没拿到名字」处理：回退文案在渲染期按当前语言取，不在请求回调里固化某一门语言
        setSiteName(data?.name || null);
        emit("render", { siteId: agentSiteId });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // 原始错误只进控制台（诊断用），界面统一显示通用文案：后端错误消息不是给用户看的
        console.error("[AgentSitesCard] 加载站点详情失败", err);
        setErrorKind("load-failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleClick = useCallback(() => {
    window.dispatchEvent(new window.CustomEvent("artifacts:select-site", { detail: { siteId: agentSiteId } }));
  }, [agentSiteId]);

  // ── Loading ──
  if (loading) {
    return (
      <div className="w-full rounded-lg border border-border/40 bg-surface-1 p-3">
        <div className="flex items-center gap-3">
          <SiteBadge className="bg-brand/10">
            <Loader2 className="h-4 w-4 text-brand animate-spin" />
          </SiteBadge>
          <div className="text-sm text-text-muted">{t("sites.card.loading")}</div>
        </div>
      </div>
    );
  }

  // ── Error ──
  if (errorKind) {
    const isMissingAttr = errorKind === "missing-attribute";
    return (
      <div
        className={cn(
          "w-full rounded-lg border p-3",
          isMissingAttr ? "border-yellow-500/30 bg-yellow-500/5" : "border-red-500/30 bg-red-500/5",
        )}
      >
        <div className="flex items-center gap-3">
          <SiteBadge className={isMissingAttr ? "bg-yellow-500/10" : "bg-red-500/10"}>
            <AlertCircle className={cn("h-4 w-4", isMissingAttr ? "text-yellow-500" : "text-red-500")} />
          </SiteBadge>
          <div className="text-sm text-text-muted">
            {isMissingAttr ? t("sites.card.missingId") : t("sites.card.loadFailed")}
          </div>
        </div>
      </div>
    );
  }

  // ── Success ──
  const displayName = siteName || agentSiteId || t("sites.card.unknownName");

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
          <SiteBadge className="bg-brand/10">
            <Globe className="h-4 w-4 text-brand" />
          </SiteBadge>
          <div className="min-w-0">
            <div className="text-sm text-text-primary">{t("sites.card.generated")}</div>
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
          {t("sites.card.view")}
          <ArrowRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

/**
 * 卡片三态（loading / error / success）共用的圆形图标底座。
 *
 * 底座骨架（尺寸 + 圆形 + 居中 + 不收缩）原先在三种状态里各写了一遍，只有背景色与图标不同；
 * 背景色由调用方经 className 传入（error 态还要按 isMissingAttr 二选一）。
 */
function SiteBadge({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("h-8 w-8 rounded-full flex items-center justify-center shrink-0", className)}>{children}</div>
  );
}
