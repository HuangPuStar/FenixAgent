import { useNavigate } from "@tanstack/react-router";
import { AlertCircle, ExternalLink, Globe, Loader2, RefreshCw } from "lucide-react";
import QRCode from "qrcode";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { envApi } from "@/src/api/environments";
import { unwrap } from "@/src/api/request";
import { NS } from "../../i18n";
import { cn } from "../../lib/utils";

export interface SiteFrameProps {
  /** 远程 app id（形如 app-xxxx），拼接到同源根路径展示业务前端 */
  remoteAppId: string;
  /** 显示名称（用于 aria-label / title） */
  name: string;
  /** 创建此 site 的 agent config id。null 表示创建者已删除，不显示创建者。 */
  createdByAgentConfigId?: string | null;
  /** 创建者 agent config 名称（用于展示）。 */
  createdByAgentConfigName?: string | null;
}

/** 加载超时阈值：超过此时长 onLoad 仍未触发则认为 site 不可达 */
const LOAD_TIMEOUT_MS = 15_000;

type LoadState = "loading" | "loaded" | "timeout";

/**
 * SiteFrame —— 在 ArtifactsPanel 内嵌加载一个 agent-sites 应用。
 *
 * 通过同源 `/web/site/deploy/${remoteAppId}/` 路径访问业务前端，避免跨域；iframe 加载状态由
 * onLoad 回调关闭，并在外部状态切换时通过 key 重置 src 强制刷新。
 *
 * 兜底：site 不可达时浏览器对部分连接级失败不会触发 onLoad，会让用户卡在
 * 永久 loading。这里加 15s 超时定时器 + iframe onError，超时后展示错误态 +
 * 重试按钮，避免无反馈的死等。
 *
 * 设计原因：保持 agent-sites 的鉴权/cookie 链路（L3 业务前端直连 PB），
 * 不在 RCS 后端代理业务前端流量——后端只代理 L2 PB Admin API。
 */
export function SiteFrame({ remoteAppId, name, createdByAgentConfigId, createdByAgentConfigName }: SiteFrameProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const navigate = useNavigate();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [reloadKey, setReloadKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 同源路径，避免跨域；以 / 开头确保从 RCS 域根解析
  // 调用方切换 site 时通过 key={remoteAppId} 强制重挂载，loading 自然回到 true
  const src = `/web/site/deploy/${remoteAppId}/`;

  // 二维码数据 URL：组件挂载时异步生成，url 变化时重新生成
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  // 分享弹窗开关
  const [shareOpen, setShareOpen] = useState(false);
  const shareContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const fullUrl = `${window.location.origin}${src}`;
    QRCode.toDataURL(fullUrl, {
      width: 140,
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch((err) => {
        if (!cancelled) console.error("[SiteFrame] 生成二维码失败", err);
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  // 点击弹窗外关闭（弹窗内部点击不关闭）
  useEffect(() => {
    if (!shareOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const container = shareContainerRef.current;
      if (container && !container.contains(e.target as Node)) {
        setShareOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [shareOpen]);

  // 加载超时兜底：每次 reloadKey 变化（用户点刷新）重挂载 iframe 时重启定时器，
  // onLoad 触发后清除。src 在组件实例内是常量（父组件用 key={remoteAppId} 重挂载），
  // 变化等同整个组件重挂载，effect 自然重新执行，故不列入依赖。
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey 是 reload 信号，effect 内部不需要直接引用
  useEffect(() => {
    setLoadState("loading");
    timerRef.current = setTimeout(() => {
      // 若 onLoad 仍未触发，切换到 timeout 错误态
      setLoadState((cur) => (cur === "loading" ? "timeout" : cur));
    }, LOAD_TIMEOUT_MS);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [reloadKey]);

  const handleOpenInNewTab = useCallback(() => {
    window.open(src, "_blank", "noopener,noreferrer");
  }, [src]);

  /** 跳转到创建该 site 的 agent 的聊天页 */
  const handleNavigateToCreator = useCallback(async () => {
    if (!createdByAgentConfigId) return;
    try {
      const envList = await unwrap(envApi.list());
      const env = Array.isArray(envList) ? envList.find((e) => e.agentConfigId === createdByAgentConfigId) : undefined;
      if (env) {
        void navigate({ to: "/agent/$agentId", params: { agentId: env.id } });
      } else {
        toast.error("该智能体暂未激活，无法跳转");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "跳转失败");
    }
  }, [createdByAgentConfigId, navigate]);

  const handleReload = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  const isLoading = loadState === "loading";
  const isTimeout = loadState === "timeout";

  return (
    <div className="flex h-full min-w-0 flex-col bg-surface-1">
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-1.5 flex-shrink-0 bg-surface-1/50">
        <Globe className="h-3.5 w-3.5 text-text-muted flex-shrink-0" />
        <span className="text-xs text-text-muted truncate flex-1 min-w-0" title={name}>
          {name}
        </span>
        <code className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-dim font-mono flex-shrink-0">
          {remoteAppId}
        </code>
        {createdByAgentConfigId && (
          <button
            type="button"
            className="text-[10px] text-text-dim hover:text-primary hover:underline cursor-pointer flex-shrink-0"
            onClick={handleNavigateToCreator}
            title={`创建者: ${createdByAgentConfigName || createdByAgentConfigId}`}
          >
            {createdByAgentConfigName || createdByAgentConfigId}
          </button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-text-muted hover:text-text-primary"
          onClick={handleReload}
          title={t("siteFrame.reload")}
          aria-label={t("siteFrame.reload")}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
        <div className="relative" ref={shareContainerRef}>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-text-muted hover:text-text-primary"
            title={t("siteFrame.share")}
            aria-label={t("siteFrame.share")}
            onClick={() => setShareOpen((v) => !v)}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
          {shareOpen && (
            <div className="absolute right-0 top-full mt-1.5 z-50 bg-surface-1 rounded-md border border-border shadow-lg p-3">
              <div className="flex flex-col items-center gap-2">
                {/* 站点名称 */}
                <span className="text-xs font-medium text-text-primary truncate max-w-[140px]" title={name}>
                  {name}
                </span>
                {/* 二维码区域 */}
                <div className="w-[120px] h-[120px] rounded-md border border-border/30 bg-white flex items-center justify-center overflow-hidden">
                  {qrDataUrl ? (
                    <img src={qrDataUrl} alt={`QR code for ${name}`} className="w-full h-full object-contain" />
                  ) : (
                    <Loader2 className="h-5 w-5 text-text-muted animate-spin" />
                  )}
                </div>
                {/* 跳转按钮 */}
                <Button
                  size="xs"
                  variant="outline"
                  className="text-xs"
                  onClick={() => {
                    setShareOpen(false);
                    handleOpenInNewTab();
                  }}
                >
                  {t("siteFrame.openInNewTab")}
                  <ExternalLink className="h-3 w-3 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="relative flex-1 min-h-0 min-w-0">
        {isLoading && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-surface-1/80">
            <Loader2 className="h-6 w-6 text-brand animate-spin" />
            <span className="text-xs text-text-muted">{t("siteFrame.loading")}</span>
          </div>
        )}
        {isTimeout && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-surface-1/95 px-6 text-center">
            <AlertCircle className="h-8 w-8 text-orange-500" />
            <div>
              <p className="text-sm font-medium text-text-primary">{t("siteFrame.loadTimeout")}</p>
              <p className="mt-1 text-xs text-text-muted">{t("siteFrame.loadTimeoutHint")}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleReload}>
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                {t("siteFrame.reload")}
              </Button>
              <Button variant="outline" size="sm" onClick={handleOpenInNewTab}>
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                {t("siteFrame.openInNewTab")}
              </Button>
            </div>
          </div>
        )}
        {/* 即使 timeout 也保留 iframe：site 可能只是慢，最终还是会响应；
            视觉上由错误态遮罩覆盖，不影响 iframe 在后台继续尝试加载 */}
        <iframe
          key={reloadKey}
          ref={iframeRef}
          src={src}
          title={name}
          className={cn("h-full w-full border-0 bg-white", isTimeout && "pointer-events-none")}
          onLoad={() => {
            if (timerRef.current) {
              clearTimeout(timerRef.current);
              timerRef.current = null;
            }
            setLoadState("loaded");
          }}
          onError={() => {
            if (timerRef.current) {
              clearTimeout(timerRef.current);
              timerRef.current = null;
            }
            setLoadState("timeout");
          }}
          // sandbox：业务前端可以 form-submit / run scripts，但禁止跨域访问 RCS cookie
          // allow-popups 让 OAuth 弹窗能工作；allow-same-origin 让业务前端访问自己的 cookie
          sandbox="allow-scripts allow-forms allow-popups allow-same-origin allow-downloads"
          referrerPolicy="no-referrer"
        />
      </div>
    </div>
  );
}
