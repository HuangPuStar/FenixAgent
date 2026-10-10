import { authClient, OrgProvider, useSession } from "@fenix/identity/web";
import { ThemeProvider } from "@fenix/ui-components/lib/theme";
import { ErrorFallback } from "@fenix/ui-components/ui/error-fallback";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { createRootRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { useTranslation } from "react-i18next";
import { Toaster } from "sonner";
import { ErrorPage } from "@/src/components/error-page";
import { AssemblyCapabilitiesProvider } from "@/src/shell/AssemblyCapabilitiesProvider";
import { AssemblyRouteGate } from "@/src/shell/AssemblyRouteGate";
import { decideSessionGuard, SESSION_NULL_VERIFY_DELAY_MS } from "@/src/shell/session-guard";

// 根布局边界（§7.1 放置矩阵第 1 行）：整个应用的兜底——`RootComponent` 四个分支（会话加载中 /
// 未登录直出 / 未登录壳 / 主壳）里任何没被下级边界接住的渲染异常都在这里收口，不再整页白屏。
// 位置在组件**外**：`RootComponent` 自身（`useSession` 等 hook）抛错时同样要被接住。
export const Route = createRootRoute({
  component: () => (
    <ErrorBoundary
      FallbackComponent={RootErrorFallback}
      onError={(error, info) => console.error("[Root] 渲染失败", error, info)}
    >
      <AssemblyCapabilitiesProvider>
        <RootComponent />
      </AssemblyCapabilitiesProvider>
    </ErrorBoundary>
  ),
  notFoundComponent: NotFoundPage,
});

/** 根布局降级 UI：整屏形态（崩溃时页面外壳已不可用，只剩这一屏）。文案取组件库字典，此处无需 i18n。 */
function RootErrorFallback({ resetErrorBoundary }: FallbackProps) {
  return <ErrorFallback resetErrorBoundary={resetErrorBoundary} variant="screen" />;
}

function RootComponent() {
  const { data: session, isPending, refetch } = useSession();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { t } = useTranslation("common");
  // /admin 观察面板独立于 better-auth 会话体系：无 session 也可访问，
  // 由页面内 AdminKeyGate（共享组件库）把关（docs/arch/21 §5），不触发登录跳转。
  const isAdminPath = pathname.startsWith("/admin");
  // 「疑似未登录」的复核状态：置位后复核仍为空才跳登录页（决策表与动机见 shell/session-guard）。
  const verifiedNullRef = useRef(false);
  // 复核计时器挂 ref 而不是随 effect 清理：路由抖动（重定向往返会让 pathname 以几十毫秒的节奏变化）
  // 每次都会重跑 effect，若把计时器绑在 effect 生命周期上，抖动会把复核一遍遍清掉重排，
  // 复核永远完不成，守卫也就永远不跳登录页——正是「循环停不下来」的成因之一。
  const verifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 复核确认无会话后会话 atom 不变，靠它触发下一轮决策去执行跳转。
  const [verifyTick, setVerifyTick] = useState(0);

  // 只负责卸载清理：在途复核不应把定时器留给已卸载的组件。
  useEffect(() => {
    return () => {
      if (verifyTimerRef.current) clearTimeout(verifyTimerRef.current);
      verifyTimerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const action = decideSessionGuard({
      hasSession: Boolean(session),
      isPending,
      pathname,
      isAdminPath,
      verifiedNull: verifiedNullRef.current,
    });
    // 会话恢复或落到两个豁免面（登录页 / 管理面）后，为下一轮「疑似未登录」重新开始复核，
    // 并取消在途复核；复核进行中的 isPending 刻意不重置，否则复核会把自己抹掉、退化成每秒一次的复核循环。
    if (session || pathname === "/login" || isAdminPath) {
      verifiedNullRef.current = false;
      if (verifyTimerRef.current) clearTimeout(verifyTimerRef.current);
      verifyTimerRef.current = null;
    }
    if (action === "to-agent") {
      void navigate({ to: "/agent", replace: true });
      return;
    }
    if (action === "to-login") {
      void navigate({ to: "/login", replace: true });
      return;
    }
    if (action !== "verify") return;
    // 已在复核中就不再重排：等这次结果即可，路径抖动不参与复核的生命周期。
    if (verifyTimerRef.current) return;
    // 复核：延迟后主动再问一次会话，仍为空才在下一轮决策里跳登录页（此时置位 verifiedNull）。
    verifyTimerRef.current = setTimeout(() => {
      verifyTimerRef.current = null;
      verifiedNullRef.current = true;
      void authClient
        .getSession()
        .then((result) => {
          // 会话其实还在（瞬时抖动）：刷新全局会话状态让页面回到正常分支，不发生跳转。
          if (result?.data) void refetch();
          else setVerifyTick((tick) => tick + 1);
        })
        .catch(() => setVerifyTick((tick) => tick + 1));
    }, SESSION_NULL_VERIFY_DELAY_MS);
  }, [session, isPending, pathname, navigate, isAdminPath, refetch, verifyTick]);

  if (isPending) {
    return (
      <ThemeProvider>
        <Spinner variant="screen" size="lg" label={t("connecting")} className="gap-4" />
      </ThemeProvider>
    );
  }

  // 疑似未登录：复核结束前渲染加载态（不再白屏），复核仍为空时由上面的守卫跳登录页。
  if (!session && pathname !== "/login" && !isAdminPath) {
    return (
      <ThemeProvider>
        <Spinner variant="screen" size="lg" label={t("connecting")} className="gap-4" />
      </ThemeProvider>
    );
  }

  if (!session) {
    return (
      <ThemeProvider>
        <AssemblyRouteGate>
          <Outlet />
        </AssemblyRouteGate>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <OrgProvider>
        <AssemblyRouteGate>
          <Outlet />
        </AssemblyRouteGate>
        <Toaster richColors closeButton position="top-right" />
      </OrgProvider>
    </ThemeProvider>
  );
}

// 404 与 403 共用 `ErrorPage`（此前两份逐字复制的整屏错误页）。
function NotFoundPage() {
  const { t } = useTranslation("common");
  return <ErrorPage code="404" message={t("not_found")} backLabel={t("back_home")} />;
}
