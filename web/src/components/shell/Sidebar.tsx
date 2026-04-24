import { useState, useCallback } from "react";
import { cn } from "../../lib/utils";
import {
  LayoutDashboard,
  MessageSquare,
  Monitor,
  Settings,
  ChevronLeft,
  ChevronRight,
  KeyRound,
  UserPlus,
} from "lucide-react";

export interface SidebarItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  badge?: string;
  active?: boolean;
  onClick?: () => void;
}

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  items: SidebarItem[];
  /** Bottom action items */
  footerItems?: SidebarItem[];
}

export function Sidebar({ collapsed, onToggleCollapse, items, footerItems }: SidebarProps) {
  return (
    <aside
      className={cn(
        "sidebar-transition flex flex-col bg-sidebar-bg border-r border-sidebar-border h-full overflow-hidden flex-shrink-0",
      )}
      style={{ width: collapsed ? "var(--sidebar-collapsed-width)" : "var(--sidebar-width)" }}
    >
      {/* Logo header */}
      <div className="flex h-12 items-center border-b border-sidebar-border px-3 flex-shrink-0">
        {!collapsed ? (
          <div className="flex items-center gap-2 min-w-0 overflow-hidden">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="flex-shrink-0">
              <path
                d="M10 1L12.2 7.8L19 10L12.2 12.2L10 19L7.8 12.2L1 10L7.8 7.8L10 1Z"
                fill="#409EFF"
              />
            </svg>
            <span className="text-sm font-semibold text-white truncate">Remote Control</span>
          </div>
        ) : (
          <div className="flex w-full justify-center">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path
                d="M10 1L12.2 7.8L19 10L12.2 12.2L10 19L7.8 12.2L1 10L7.8 7.8L10 1Z"
                fill="#409EFF"
              />
            </svg>
          </div>
        )}
      </div>

      {/* Navigation items */}
      <nav className="flex-1 overflow-y-auto py-2 px-2">
        {items.map((item) => (
          <SidebarNavItem key={item.id} item={item} collapsed={collapsed} />
        ))}
      </nav>

      {/* Footer items */}
      {footerItems && footerItems.length > 0 && (
        <div className="border-t border-sidebar-border py-2 px-2">
          {footerItems.map((item) => (
            <SidebarNavItem key={item.id} item={item} collapsed={collapsed} />
          ))}
        </div>
      )}

      {/* Collapse toggle */}
      <div className="border-t border-sidebar-border p-2 flex-shrink-0">
        <button
          type="button"
          onClick={onToggleCollapse}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sidebar-text transition-colors hover:bg-sidebar-hover hover:text-white",
            collapsed && "justify-center",
          )}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4 flex-shrink-0" />
          ) : (
            <>
              <ChevronLeft className="h-4 w-4 flex-shrink-0" />
              <span className="text-xs">Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}

function SidebarNavItem({ item, collapsed }: { item: SidebarItem; collapsed: boolean }) {
  return (
    <button
      type="button"
      onClick={item.onClick}
      title={collapsed ? item.label : undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors",
        collapsed && "justify-center",
        item.active
          ? "bg-sidebar-active text-sidebar-text-active border-l-2 border-brand"
          : "text-sidebar-text hover:bg-sidebar-hover hover:text-white",
      )}
    >
      <span className="flex-shrink-0">{item.icon}</span>
      {!collapsed && (
        <span className="truncate">{item.label}</span>
      )}
      {!collapsed && item.badge && (
        <span className="ml-auto rounded-full bg-brand/20 px-1.5 py-0.5 text-[10px] font-medium text-brand">
          {item.badge}
        </span>
      )}
    </button>
  );
}
