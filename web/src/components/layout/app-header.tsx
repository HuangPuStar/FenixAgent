import type { ReactNode } from "react";

interface AppHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

/** 业务页统一标题区：固定信息层级、操作基线与内容分隔。 */
export function AppHeader({ title, subtitle, actions }: AppHeaderProps) {
  return (
    <header className="flex shrink-0 items-start justify-between gap-6 border-b border-[#e4eaf2] pb-4 max-[640px]:min-h-0 max-[640px]:flex-col max-[640px]:gap-3">
      <div className="min-w-0">
        <h1 className="text-3xl font-bold tracking-[-0.02em] text-[#17233a]">{title}</h1>
        {subtitle ? <p className="mt-1 text-[12px] leading-5 text-[#94a3b8]">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2 max-[640px]:self-end">{actions}</div> : null}
    </header>
  );
}
