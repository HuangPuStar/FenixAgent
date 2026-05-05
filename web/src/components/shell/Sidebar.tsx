import {
  Monitor,
  Bot,
  Cpu,
  MessageSquare,
  Settings,
  Plug,
  Clock,
  Radio,
  KeyRound,
  Workflow,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  currentPage: string;
  onNavigate: (page: string) => void;
}

interface NavEntry {
  id: string;
  label: string;
  icon: LucideIcon;
}

interface NavGroup {
  label: string;
  items: NavEntry[];
}

/* ------------------------------------------------------------------ */
/*  Navigation definition                                              */
/* ------------------------------------------------------------------ */

const NAV_GROUPS: NavGroup[] = [
  {
    label: "控制台",
    items: [
      { id: "dashboard", label: "概览", icon: Monitor },
      { id: "workflow", label: "智能体编排", icon: Workflow },
      { id: "environments", label: "智能体", icon: Bot },
      { id: "models", label: "模型", icon: Cpu },
      { id: "session", label: "会话", icon: MessageSquare },
    ],
  },
  {
    label: "配置",
    items: [
      { id: "skills", label: "技能", icon: Settings },
      { id: "mcp", label: "MCP", icon: Plug },
      { id: "tasks", label: "定时任务", icon: Clock },
      { id: "channels", label: "消息渠道", icon: Radio },
      { id: "apikeys", label: "API Key", icon: KeyRound },
    ],
  },
];

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function Sidebar({
  collapsed,
  onToggle,
  currentPage,
  onNavigate,
}: SidebarProps) {
  return (
    <aside
      className={[
        "flex flex-col h-full overflow-hidden",
        "border-r border-border-subtle bg-surface-0",
        "transition-[width,min-width] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]",
        "z-20",
        collapsed ? "w-[var(--sidebar-collapsed)] min-w-[var(--sidebar-collapsed)]" : "w-[var(--sidebar-width)] min-w-[var(--sidebar-width)]",
      ].join(" ")}
    >
      {/* ---- Brand ---- */}
      <div
        className={[
          "flex items-center gap-2.5 px-4",
          "border-b border-border-subtle",
          "min-h-[var(--topbar-height)]",
          "bg-gradient-to-b from-surface-1 to-surface-0",
        ].join(" ")}
      >
        {/* Icon */}
        <div
          className={[
            "w-7 h-7 rounded-lg flex-shrink-0",
            "flex items-center justify-center",
            "bg-gradient-to-br from-brand to-brand-light",
            "text-white font-bold text-sm",
            "shadow-[0_2px_8px_rgba(99,102,241,0.25)]",
          ].join(" ")}
        >
          R
        </div>

        {/* Text */}
        <span
          className={[
            "text-sm font-bold tracking-[0.02em] text-text-bright",
            "whitespace-nowrap overflow-hidden",
            "transition-opacity duration-200",
            collapsed ? "opacity-0" : "opacity-100",
          ].join(" ")}
        >
          RCS
        </span>

        {/* Toggle button */}
        <button
          type="button"
          onClick={onToggle}
          className={[
            "ml-auto w-7 h-7 rounded-md flex-shrink-0",
            "flex items-center justify-center",
            "border border-border-subtle bg-transparent",
            "text-text-dim cursor-pointer",
            "transition-all duration-150",
            "hover:bg-surface-hover hover:text-text-primary",
          ].join(" ")}
          title={collapsed ? "展开侧栏" : "收起侧栏"}
        >
          {collapsed ? (
            <ChevronsRight className="w-4 h-4" />
          ) : (
            <ChevronsLeft className="w-4 h-4" />
          )}
        </button>
      </div>

      {/* ---- Navigation ---- */}
      <nav className="flex-1 py-2 overflow-y-auto overflow-x-hidden">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            {/* Section label */}
            <div
              className={[
                "text-[11px] font-semibold uppercase tracking-[0.06em]",
                "text-text-dim whitespace-nowrap overflow-hidden",
                "px-5 pt-3 pb-1.5",
                "transition-all duration-200",
                collapsed && "text-center px-2 text-[0px] pt-3 pb-1.5",
              ].join(" ")}
            >
              {collapsed ? (
                <span className="block w-4 h-px bg-border-default mx-auto mt-1" />
              ) : (
                group.label
              )}
            </div>

            {/* Items */}
            {group.items.map((item) => {
              const isActive =
                item.id === currentPage ||
                (item.id === "environments" && currentPage === "agents") ||
                (item.id === "session" && currentPage === "session");

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
                    // default
                    "text-text-secondary",
                    // spacing – collapsed vs expanded
                    collapsed
                      ? "justify-center gap-0 px-0 py-2 mx-1.5 rounded-lg"
                      : "gap-2.5 px-3 py-2 mx-2 rounded-[var(--radius)]",
                    // active
                    isActive
                      ? "bg-brand-subtle text-brand-light"
                      : "hover:bg-surface-hover hover:text-text-primary",
                  ].join(" ")}
                >
                  {/* Active indicator bar */}
                  {isActive && (
                    <span
                      className={[
                        "absolute top-1 bottom-1 w-[3px] rounded-r-[3px]",
                        "bg-brand",
                        collapsed ? "left-0" : "-left-2",
                      ].join(" ")}
                    />
                  )}

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

      {/* ---- Status panel ---- */}
      <div
        className={[
          "border-t border-border-subtle flex-shrink-0 overflow-hidden",
          "bg-surface-0",
          "transition-all duration-300",
          collapsed
            ? "flex flex-col items-center gap-1 px-0 py-3"
            : "px-3 py-3.5",
        ].join(" ")}
      >
        {collapsed ? (
          <>
            {/* Collapsed: just dots */}
            <span className="block w-1.5 h-1.5 rounded-full bg-status-active" />
            <span className="block w-1.5 h-1.5 rounded-full bg-brand" />
          </>
        ) : (
          <>
            {/* Agents row */}
            <div className="flex items-center gap-2 py-1 text-xs text-text-secondary whitespace-nowrap">
              <span className="w-1.5 h-1.5 rounded-full bg-status-active flex-shrink-0" />
              <span>Agents</span>
              <span
                className={[
                  "ml-auto font-mono text-[10px] font-semibold",
                  "text-white px-1.5 py-px rounded-full",
                  "bg-status-active",
                ].join(" ")}
              >
                LIVE
              </span>
              <span className="font-mono text-[11px] font-semibold text-text-bright">
                3
              </span>
            </div>

            {/* Sessions row */}
            <div className="flex items-center gap-2 py-1 text-xs text-text-secondary whitespace-nowrap">
              <span className="w-1.5 h-1.5 rounded-full bg-brand flex-shrink-0" />
              <span>活跃会话</span>
              <span className="ml-auto font-mono text-[11px] font-semibold text-text-bright">
                12
              </span>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
