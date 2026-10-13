import type { ReactNode } from "react";

interface AppHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

/**
 * 页面统一标题区：固定信息层级、操作基线与内容分隔。
 *
 * 源实现的分隔线与文字色为硬编码色值（#e4eaf2 / #17233a / #94a3b8），此处改用
 * 包内 token（border / text-bright / text-muted），视觉意图不变并支持主题切换。
 */
export function AppHeader({ title, subtitle, actions }: AppHeaderProps) {
  return (
    <header className="flex shrink-0 items-start justify-between gap-6 border-b border-border pb-4 max-sm:min-h-0 max-sm:flex-col max-sm:gap-3">
      <div className="min-w-0">
        <h1 className="text-3xl font-bold tracking-tight text-text-bright">{title}</h1>
        {subtitle ? <p className="mt-1 text-xs leading-5 text-text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2 max-sm:self-end">{actions}</div> : null}
    </header>
  );
}
