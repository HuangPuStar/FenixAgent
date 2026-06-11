import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Brain,
  Clock,
  Cpu,
  KeyRound,
  MessageSquare,
  Monitor,
  Plug,
  Plus,
  Send,
  Settings,
  Users,
  Workflow,
} from "lucide-react";
import { useTranslation } from "react-i18next";

interface NavEntry {
  id: string;
  labelKey: string;
  icon: LucideIcon;
}

interface NavGroup {
  label: string;
  items: NavEntry[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "核心",
    items: [
      { id: "home", labelKey: "agentPanel:createAgent", icon: Plus },
      { id: "workflow", labelKey: "agentPanel:workflow", icon: Workflow },
      { id: "sessions", labelKey: "agentPanel:sessions", icon: MessageSquare },
    ],
  },
  {
    label: "配置",
    items: [
      { id: "models", labelKey: "agentPanel:models", icon: Cpu },
      { id: "skills", labelKey: "agentPanel:skills", icon: Settings },
      { id: "memories", labelKey: "agentPanel:memories", icon: Brain },
      { id: "knowledge-bases", labelKey: "agentPanel:knowledgeBases", icon: BookOpen },
      { id: "mcp", labelKey: "agentPanel:mcp", icon: Plug },
      { id: "tasks", labelKey: "agentPanel:tasks", icon: Clock },
      { id: "channels", labelKey: "agentPanel:channels", icon: Send },
      { id: "apikeys", labelKey: "agentPanel:apiKeys", icon: KeyRound },
    ],
  },
  {
    label: "系统",
    items: [
      { id: "dashboard", labelKey: "agentPanel:overview", icon: Monitor },
      { id: "organizations", labelKey: "sidebar:organizations", icon: Users },
    ],
  },
];

interface AgentSidebarConfigProps {
  onNavigate: (pageId: string) => void;
}

/** 智能体树上方的快捷导航 */
export function AgentSidebarQuickNav({
  onNavigate,
  activeNav,
}: AgentSidebarConfigProps & { activeNav: string | null }) {
  const { t } = useTranslation();

  return (
    <div className="agent-sidebar-nav px-2 py-1.5">
      {NAV_GROUPS.map((group) => (
        <div className="agent-sidebar-nav-group" key={group.label}>
          <div className="agent-sidebar-section-label">{group.label}</div>
          {group.items.map((item) => {
            const Icon = item.icon;
            const isActive = activeNav === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
                title={t(item.labelKey)}
                className={`agent-sidebar-nav-item flex items-center gap-2.5 w-full px-3 py-2 rounded-[var(--radius)] text-[13px] font-medium transition-all duration-150 cursor-pointer ${
                  isActive
                    ? "active bg-brand-subtle text-brand-light border-l-2 border-brand"
                    : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
                }`}
              >
                <Icon className="w-[18px] h-[18px] flex-shrink-0" />
                <span>{t(item.labelKey)}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** 预留给旧布局的底部导航，现在菜单已在 QuickNav 中直出。 */
export function AgentSidebarConfig({ onNavigate }: AgentSidebarConfigProps) {
  void onNavigate;
  return null;
}
