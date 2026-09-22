import { Button } from "@fenix/ui-components/ui/button";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { ApiError, unwrap } from "@fenix/web-runtime/api/request";
import { useParams } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { type ComponentType, Suspense, useRef } from "react";
import { useTranslation } from "react-i18next";
import { type ProdViewModulesConfig, prodViewApi } from "../../api/prod-views";
import { PROD_VIEWS_NS } from "../../i18n/namespace";

// 本页用到的 `.agent-panel-layout` / `.agent-panel-body` 定义在宿主 apps/web 的 agent-panel.css，
// 由挂载本页的路由 `apps/web/src/routes/view/$prodViewId.tsx` 以副作用导入加载（它在 lazy 之前导入，
// 样式先于页面组件执行）。本包不再自带该 CSS 的导入：包内 web 面禁止宿主别名，而样式表仍属宿主资源。

/**
 * 分享页需要宿主提供的聊天容器端口。
 *
 * 分享页只解析「哪个 Environment 的哪个实例」这一身份问题（`prodViewApi.load`），聊天容器本身属于宿主
 * Shell（§2.3「Shell 属于 app，不属于资源包」）——它的实现持有宿主路由态、keep-alive 槽位与页面壳层样式。
 * 因此 `ProdViewPage` **不引用**任何聊天包，只声明它需要的这一小块 prop 形状，由宿主路由
 * `apps/web/src/routes/view/$prodViewId.tsx` 注入 `apps/web` 的 `ChatArea`（CE 阶段 2 任务 1.6 T5b：
 * 该组件此前是 `@fenix/chat-channel/web/chat-area` 的 lazy import，会让资源包依赖聊天包的实现）。
 *
 * 端口刻意小于宿主 `ChatArea` 的完整 props：只声明分享页真实供给的部分（无 `deletedEnvironmentIds`
 * ——分享页没有删除流），宿主组件多出的可选 prop 不影响赋值。
 */
export interface ProdViewChatAreaProps {
  agentId: string;
  sessionId?: string | null;
  visible: boolean;
  modulesConfig?: ProdViewModulesConfig;
}

export interface ProdViewPageProps {
  /** 宿主注入的聊天容器；必须是 `apps/web/src/pages/agent-panel/ChatArea.tsx`。 */
  chatArea: ComponentType<ProdViewChatAreaProps>;
}

export function ProdViewPage({ chatArea: ChatArea }: ProdViewPageProps) {
  const { prodViewId } = useParams({ from: "/view/$prodViewId" }) as { prodViewId: string };
  const { t } = useTranslation(PROD_VIEWS_NS);
  const requestGeneration = useRef(0);

  const {
    data: viewConfig,
    loading,
    error: loadError,
    refresh,
  } = useRequest(
    async () => {
      const generation = ++requestGeneration.current;
      const data = await unwrap(prodViewApi.load(prodViewId));
      if (generation !== requestGeneration.current) throw new DOMException("Stale ProdView request", "AbortError");
      return data;
    },
    { refreshDeps: [prodViewId] },
  );

  /** 401/403（request 层把两者统一归一为 UNAUTHORIZED）不重试：分享页的授权结果不因重试改变。 */
  const unauthorized = loadError instanceof ApiError && loadError.code === "UNAUTHORIZED";

  return (
    <div className="agent-panel-layout !flex-col">
      {/* 极简 header：复用 agent 页面的 CSS 变量，确保暗色模式一致 */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/40 bg-surface-1 px-4 text-sm">
        <span className="font-medium text-text-primary">{viewConfig?.name ?? t("title")}</span>
        <span className="text-xs text-text-dim">FenixAgent</span>
      </div>

      <div className="agent-panel-body">
        {loading ? (
          <Spinner variant="panel" label={<span className="sr-only">{t("loading")}</span>} />
        ) : loadError ? (
          // 持久错误分支（role="alert"）与 401/403 的无权限分支分开：后者给重试按钮是无意义的入口。
          <div className="flex h-full flex-col items-center justify-center gap-4" role="alert">
            <p className="text-sm text-text-muted">
              {unauthorized ? t("noPermission") : ((loadError as Error)?.message ?? t("loadError"))}
            </p>
            {unauthorized ? (
              <p className="text-xs text-text-dim">{t("noPermissionHint")}</p>
            ) : (
              <Button variant="outline" onClick={refresh} disabled={loading}>
                {t("retry")}
              </Button>
            )}
          </div>
        ) : !viewConfig?.environmentId ? (
          <div className="flex h-full flex-col items-center justify-center gap-4">
            <p className="text-sm text-text-muted">{t("instanceNotFound")}</p>
            <Button variant="outline" onClick={refresh} disabled={loading}>
              {t("retry")}
            </Button>
          </div>
        ) : (
          <Suspense fallback={<Spinner variant="panel" label={<span className="sr-only">{t("loading")}</span>} />}>
            <ChatArea
              key={`${prodViewId}:${viewConfig.environmentId}:${viewConfig.instanceUid}`}
              agentId={viewConfig.environmentId}
              sessionId={viewConfig.instanceUid}
              visible={true}
              modulesConfig={viewConfig.modulesConfig ?? {}}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}
