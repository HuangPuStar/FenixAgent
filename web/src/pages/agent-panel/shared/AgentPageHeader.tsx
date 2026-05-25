interface AgentPageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}

export function AgentPageHeader({ title, subtitle, actions }: AgentPageHeaderProps) {
  return (
    <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
      <div>
        <h2 className="text-lg font-semibold text-text-bright">{title}</h2>
        {subtitle && <p className="text-sm text-text-muted mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
