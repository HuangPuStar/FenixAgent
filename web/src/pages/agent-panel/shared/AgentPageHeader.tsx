interface AgentPageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}

/** 统一的页面标题栏：深色标题 + 浅灰副标题 + 分隔线 + 操作按钮区 */
export function AgentPageHeader({ title, subtitle, actions }: AgentPageHeaderProps) {
  return (
    <>
      <div className="mb-3 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight text-[#1a2944]">{title}</h1>
          {subtitle && <p className="mt-0.5 text-[12px] text-[#94a3b8]">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      <div className="mb-3.5 h-px bg-[#e8edf4]" />
    </>
  );
}
