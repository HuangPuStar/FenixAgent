import type { LucideIcon } from "lucide-react";
import { BookOpen, Bot, Brain, Clock, Cpu, Globe, KeyRound, Plug, Plus, Settings, Users, Workflow } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";

interface NavEntry {
  id: string;
  labelKey: string;
  icon: LucideIcon;
}

interface NavGroup {
  label: string;
  items: NavEntry[];
}

/** 导航分组定义，labelKey 统一在组件内通过 t() 翻译 */
function useNavGroups(): NavGroup[] {
  const { t } = useTranslation(NS.SIDEBAR);

  return [
    {
      label: t("navGroupCore"),
      items: [
        { id: "home", labelKey: "agentPanel:createAgent", icon: Plus },
        { id: "agents", labelKey: "agentPanel:agentManagement", icon: Bot },
        { id: "workflow", labelKey: "agentPanel:workflow", icon: Workflow },
      ],
    },
    {
      label: t("navGroupConfig"),
      items: [
        { id: "models", labelKey: "agentPanel:models", icon: Cpu },
        { id: "skills", labelKey: "agentPanel:skills", icon: Settings },
        { id: "memories", labelKey: "agentPanel:memories", icon: Brain },
        { id: "knowledge-bases", labelKey: "agentPanel:knowledgeBases", icon: BookOpen },
        { id: "mcp", labelKey: "agentPanel:mcp", icon: Plug },
        { id: "tasks", labelKey: "agentPanel:tasks", icon: Clock },
        { id: "sites", labelKey: "agentPanel:sites", icon: Globe },
        { id: "organizations", labelKey: "sidebar:organizations", icon: Users },
        { id: "apikeys", labelKey: "agentPanel:apiKeys", icon: KeyRound },
      ],
    },
  ];
}

interface AgentSidebarConfigProps {
  onNavigate: (pageId: string) => void;
}

/** 智能体树上方的快捷导航 */
export function AgentSidebarQuickNav({
  onNavigate,
  activeNav,
}: AgentSidebarConfigProps & { activeNav: string | null }) {
  const { t } = useTranslation();
  const navGroups = useNavGroups();

  return (
    <div className="agent-sidebar-nav px-2 py-1">
      {navGroups.map((group) => (
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
                className={`agent-sidebar-nav-item flex items-center gap-2 w-full px-3 py-1.5 rounded-[var(--radius)] text-[12px] font-medium transition-all duration-150 cursor-pointer ${
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
