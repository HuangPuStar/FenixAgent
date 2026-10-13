import { Button } from "@fenix/ui-components/ui/button";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { type AssemblyCapabilitiesState, useAssemblyCapabilities } from "./AssemblyCapabilitiesProvider";
import { routeWebId } from "./assembly-capabilities";

/** 单一展示边界，关闭时不挂载业务子树，因而不会触发页面请求或 iframe 握手。 */
export function AssemblyRouteState({
  moduleId,
  state,
  children,
}: {
  moduleId: string | undefined;
  state: AssemblyCapabilitiesState;
  children: ReactNode;
}) {
  const { t } = useTranslation("common");
  if (!moduleId) return children;
  if (state.loading) return <Spinner variant="screen" label={t("assembly.loading")} />;
  if (!state.enabled.has(moduleId)) {
    return (
      <section role="status" className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="text-xl font-semibold">{t("assembly.disabled", { module: moduleId })}</h1>
        <p className="text-muted-foreground">{t("assembly.disabledHint")}</p>
      </section>
    );
  }
  return (
    <>
      {state.failed && (
        <div role="alert" className="flex items-center justify-center gap-3 border-b p-3 text-sm">
          <span>{t("assembly.failed")}</span>
          <Button variant="outline" size="sm" onClick={state.retry}>
            {t("retry")}
          </Button>
        </div>
      )}
      {children}
    </>
  );
}

/** 根出口统一按贡献归属拦截，导航项与其全部子路径自动接入。 */
export function AssemblyRouteGate({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const state = useAssemblyCapabilities();
  return (
    <AssemblyRouteState moduleId={routeWebId(pathname)} state={state}>
      {children}
    </AssemblyRouteState>
  );
}
