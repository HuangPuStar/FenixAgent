import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Brain,
  Clock,
  Cpu,
  KeyRound,
  Menu,
  MessageSquare,
  Monitor,
  Plug,
  Settings,
  Users,
  Workflow,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NS } from "../../i18n";

interface NavEntry {
  id: string;
  labelKey: string;
  icon: LucideIcon;
}

interface NavGroup {
  labelKey: string;
  items: NavEntry[];
}

/** 直接显示的快捷入口（模型、技能、MCP、组织管理） */
const QUICK_NAV: NavEntry[] = [
  { id: "models", labelKey: "agentPanel:models", icon: Cpu },
  { id: "skills", labelKey: "agentPanel:skills", icon: Settings },
  { id: "memories", labelKey: "agentPanel:memories", icon: Brain },
  { id: "mcp", labelKey: "agentPanel:mcp", icon: Plug },
  { id: "organizations", labelKey: "sidebar:organizations", icon: Users },
];

/** 折叠到下拉菜单的其余导航 */
const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: "agentPanel:console",
    items: [
      { id: "dashboard", labelKey: "agentPanel:overview", icon: Monitor },
      { id: "workflow", labelKey: "agentPanel:workflow", icon: Workflow },
      { id: "sessions", labelKey: "agentPanel:sessions", icon: MessageSquare },
    ],
  },
  {
    labelKey: "agentPanel:config",
    items: [
      { id: "knowledge-bases", labelKey: "agentPanel:knowledgeBases", icon: BookOpen },
      { id: "tasks", labelKey: "agentPanel:tasks", icon: Clock },
      { id: "apikeys", labelKey: "agentPanel:apiKeys", icon: KeyRound },
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
    <div className="px-2 py-1.5">
      {QUICK_NAV.map((item) => {
        const Icon = item.icon;
        const isActive = activeNav === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavigate(item.id)}
            className={`flex items-center gap-2.5 w-full px-3 py-2 rounded-[var(--radius)] text-[13px] font-medium transition-all duration-150 cursor-pointer ${
              isActive
                ? "bg-brand-subtle text-brand-light border-l-2 border-brand"
                : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
            }`}
          >
            <Icon className="w-[18px] h-[18px] flex-shrink-0" />
            <span>{t(item.labelKey)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 智能体树下方的更多导航（下拉菜单） */
export function AgentSidebarConfig({ onNavigate }: AgentSidebarConfigProps) {
  const { t } = useTranslation(NS.AGENT_PANEL);

  return (
    <div className="px-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2.5 w-full px-3 py-2 rounded-[var(--radius)] text-[13px] font-medium text-text-secondary hover:bg-surface-hover hover:text-text-primary transition-all duration-150 cursor-pointer"
          >
            <Menu className="w-[18px] h-[18px] flex-shrink-0" />
            <span>{t("navigation")}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-48">
          {NAV_GROUPS.map((group, gi) => (
            <DropdownMenuGroup key={group.labelKey}>
              {gi > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-dim">
                {t(group.labelKey)}
              </DropdownMenuLabel>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <DropdownMenuItem key={item.id} onClick={() => onNavigate(item.id)}>
                    <Icon className="w-4 h-4" />
                    <span>{t(item.labelKey)}</span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
