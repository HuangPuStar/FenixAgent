import { useRequest } from "ahooks";
import type { LucideIcon } from "lucide-react";
import {
  Binary,
  BookOpen,
  Bot,
  Brain,
  Clock,
  Cpu,
  Globe,
  KeyRound,
  Layers,
  Plug,
  Plus,
  Settings,
  Users,
  Workflow,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { sidebarConfigApi } from "@/src/api/sidebar-config";
import { NS } from "@/src/i18n";

export interface NavEntry {
  id: string;
  labelKey: string;
  icon: LucideIcon;
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavEntry[];
}

interface NavGroupDefinition {
  id: string;
  labelKey: string;
  items: NavEntry[];
}

export const SIDEBAR_NAV_GROUPS: NavGroupDefinition[] = [
  {
    id: "core",
    labelKey: "navGroupCore",
    items: [
      { id: "home", labelKey: "agentPanel:createAgent", icon: Plus },
      { id: "agents", labelKey: "agentPanel:agentManagement", icon: Bot },
      { id: "workflow", labelKey: "agentPanel:workflow", icon: Workflow },
    ],
  },
  {
    id: "config",
    labelKey: "navGroupConfig",
    items: [
      { id: "models", labelKey: "agentPanel:models", icon: Cpu },
      { id: "vertical-models", labelKey: "agentPanel:verticalModels", icon: Layers },
      { id: "algorithms", labelKey: "agentPanel:algorithms", icon: Binary },
      { id: "skills", labelKey: "agentPanel:skills", icon: Settings },
      { id: "knowledge-bases", labelKey: "agentPanel:knowledgeBases", icon: BookOpen },
      { id: "mcp", labelKey: "agentPanel:mcp", icon: Plug },
      { id: "tasks", labelKey: "agentPanel:tasks", icon: Clock },
      { id: "memories", labelKey: "agentPanel:memories", icon: Brain },
      { id: "sites", labelKey: "agentPanel:sites", icon: Globe },
      { id: "organizations", labelKey: "sidebar:organizations", icon: Users },
      { id: "apikeys", labelKey: "agentPanel:apiKeys", icon: KeyRound },
    ],
  },
];

/** 按隐藏列表过滤导航组，并自动移除空组。 */
export function filterNavGroups<T extends { id: string; items: NavEntry[] }>(groups: T[], hiddenTabs: string[]): T[] {
  const hiddenTabSet = new Set(hiddenTabs);
  return (
    groups.map((group) => ({
      ...group,
      items: group.items.filter((item) => !hiddenTabSet.has(item.id)),
    })) as T[]
  ).filter((group) => group.items.length > 0);
}

/** 导航分组定义，labelKey 统一在组件内通过 t() 翻译 */
function useNavGroups(): NavGroup[] {
  const { t } = useTranslation(NS.SIDEBAR);
  const { data } = useRequest(
    async () => {
      const response = await sidebarConfigApi.get();
      return response.success ? (response.data?.hiddenTabs ?? []) : [];
    },
    {
      cacheKey: "sidebar-config",
      staleTime: 60_000,
    },
  );

  const translatedGroups = SIDEBAR_NAV_GROUPS.map((group) => ({
    id: group.id,
    label: t(group.labelKey),
    items: group.items,
  }));

  return filterNavGroups(translatedGroups, data ?? []);
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
