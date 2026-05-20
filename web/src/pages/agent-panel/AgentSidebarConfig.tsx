import type { LucideIcon } from "lucide-react";
import { BookOpen, Clock, Cpu, KeyRound, MessageSquare, Monitor, Plug, Radio, Settings, Workflow } from "lucide-react";

interface NavEntry {
  id: string;
  label: string;
  icon: LucideIcon;
}

interface NavGroup {
  label: string;
  items: NavEntry[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "控制台",
    items: [
      { id: "dashboard", label: "概览", icon: Monitor },
      { id: "workflow", label: "智能体编排", icon: Workflow },
      { id: "models", label: "模型", icon: Cpu },
      { id: "session", label: "会话", icon: MessageSquare },
    ],
  },
  {
    label: "配置",
    items: [
      { id: "skills", label: "技能", icon: Settings },
      { id: "knowledge-bases", label: "知识库", icon: BookOpen },
      { id: "mcp", label: "MCP", icon: Plug },
      { id: "tasks", label: "定时任务", icon: Clock },
      { id: "channels", label: "消息渠道", icon: Radio },
      { id: "apikeys", label: "API Key", icon: KeyRound },
    ],
  },
];

interface AgentSidebarConfigProps {
  collapsed: boolean;
  onNavigate: (pageId: string) => void;
}

export function AgentSidebarConfig({ collapsed, onNavigate }: AgentSidebarConfigProps) {
  return (
    <nav className="py-2 overflow-y-auto overflow-x-hidden">
      {NAV_GROUPS.map((group) => (
        <div key={group.label}>
          <div
            className={[
              "text-[11px] font-semibold uppercase tracking-[0.06em]",
              "text-text-dim whitespace-nowrap overflow-hidden",
              "px-5 pt-3 pb-1.5",
              "transition-all duration-200",
              collapsed && "text-center px-2 text-[0px] pt-3 pb-1.5",
            ].join(" ")}
          >
            {collapsed ? <span className="block w-4 h-px bg-border-default mx-auto mt-1" /> : group.label}
          </div>

          {group.items.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                title={collapsed ? item.label : undefined}
                className={[
                  "relative flex items-center w-full",
                  "text-[13px] font-medium cursor-pointer",
                  "transition-all duration-150",
                  "whitespace-nowrap overflow-hidden select-none",
                  "text-text-secondary",
                  collapsed
                    ? "justify-center gap-0 px-0 py-2 mx-1.5 rounded-lg"
                    : "gap-2.5 px-3 py-2 mx-2 rounded-[var(--radius)]",
                  "hover:bg-surface-hover hover:text-text-primary",
                ].join(" ")}
              >
                <Icon className="w-[18px] h-[18px] flex-shrink-0" />
                <span
                  className={[
                    "overflow-hidden transition-opacity duration-200",
                    collapsed ? "opacity-0 w-0" : "opacity-100",
                  ].join(" ")}
                >
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
