import type { ReactNode } from "react";

type AppPageProps = {
  children: ReactNode;
  className?: string;
  busy?: boolean;
};

/**
 * 页面级统一滚动边界、背景与留白。
 *
 * 源实现使用 `bg-[#f5f7fb]` / `text-[#17233a]` 硬编码色值，此处改用包内 token
 * （surface-0 / text-bright），视觉意图不变并跟随包内主题切换。
 */
export function AppPage({ children, className, busy }: AppPageProps) {
  return (
    <main
      aria-busy={busy || undefined}
      className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-auto bg-surface-0 px-8 pt-7 pb-10 text-text-bright max-[720px]:px-4 max-[720px]:pt-5 max-[720px]:pb-8 ${className ?? ""}`}
    >
      {children}
    </main>
  );
}
