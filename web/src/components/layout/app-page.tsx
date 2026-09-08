import type { ReactNode } from "react";

type AppPageProps = {
  children: ReactNode;
  className?: string;
  busy?: boolean;
};

/** 控制台业务页的统一滚动边界、背景与页面留白。 */
export function AppPage({ children, className, busy }: AppPageProps) {
  return (
    <main
      aria-busy={busy || undefined}
      className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-auto bg-[#f5f7fb] px-8 pt-7 pb-10 text-[#17233a] max-[720px]:px-4 max-[720px]:pt-5 max-[720px]:pb-8 ${className ?? ""}`}
    >
      {children}
    </main>
  );
}
