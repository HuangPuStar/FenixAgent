import { useParams } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { lazy, Suspense, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ChatModulesConfig } from "@/components/ChatInterface";
import { Button } from "@/components/ui/button";
import { prodViewApi } from "@/src/api/prod-views";
import { unwrap } from "@/src/api/request";
import { NS } from "@/src/i18n";
import "../agent-panel/agent-panel.css";

const ChatArea = lazy(() => import("@/src/pages/agent-panel/ChatArea").then((m) => ({ default: m.ChatArea })));

export function ProdViewPage() {
  const { prodViewId } = useParams({ from: "/view/$prodViewId" }) as { prodViewId: string };
  const { t } = useTranslation(NS.PROD_VIEWS);

  const { data: viewConfig, loading, error: loadError } = useRequest(async () => unwrap(prodViewApi.load(prodViewId)));

  const modulesConfig = useMemo<ChatModulesConfig | undefined>(() => {
    if (!viewConfig?.modulesConfig) return undefined;
    return viewConfig.modulesConfig as ChatModulesConfig;
  }, [viewConfig?.modulesConfig]);

  return (
    <div className="agent-panel-layout !flex-col">
      {/* 极简 header：复用 agent 页面的 CSS 变量，确保暗色模式一致 */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/40 bg-surface-1 px-4 text-sm">
        <span className="font-medium text-text-primary">{viewConfig?.name ?? t("title")}</span>
        <span className="text-xs text-text-dim">FenixAgent</span>
      </div>

      <div className="agent-panel-body">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
          </div>
        ) : loadError ? (
          <div className="flex h-full flex-col items-center justify-center gap-4">
            <p className="text-sm text-text-muted">{(loadError as Error)?.message ?? t("loadError")}</p>
            <Button variant="outline" onClick={() => window.location.reload()}>
              {t("retry")}
            </Button>
          </div>
        ) : !viewConfig?.environmentId ? (
          <div className="flex h-full flex-col items-center justify-center gap-4">
            <p className="text-sm text-text-muted">{t("loadError", { message: "未找到对应的环境实例" })}</p>
            <Button variant="outline" onClick={() => window.location.reload()}>
              {t("retry")}
            </Button>
          </div>
        ) : (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
              </div>
            }
          >
            <ChatArea agentId={viewConfig.environmentId} visible={true} modulesConfig={modulesConfig} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
