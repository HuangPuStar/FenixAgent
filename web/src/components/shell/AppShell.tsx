import { useState, useCallback, type ReactNode } from "react";
import { Sidebar, type SidebarItem } from "./Sidebar";
import { cn } from "../../lib/utils";
import { ThemeToggle } from "@/components/ui/theme-toggle";

interface AppShellProps {
  /** Current active view id */
  activeView: string;
  /** Sidebar navigation items (auto-generated from props) */
  navItems: SidebarItem[];
  /** Footer action items */
  footerItems?: SidebarItem[];
  /** Top bar content (right side) */
  topBarRight?: ReactNode;
  /** Top bar title override */
  title?: string;
  /** Main content */
  children: ReactNode;
}

export function AppShell({
  activeView,
  navItems,
  footerItems,
  topBarRight,
  title,
  children,
}: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const toggleCollapse = useCallback(() => setCollapsed((c) => !c), []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-surface-0">
      {/* Sidebar */}
      <Sidebar
        collapsed={collapsed}
        onToggleCollapse={toggleCollapse}
        items={navItems}
        footerItems={footerItems}
      />

      {/* Main area */}
      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        {/* Top navbar */}
        <header className="flex h-12 items-center justify-between border-b border-border bg-surface-1 px-4 flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            {title && (
              <h1 className="text-sm font-semibold text-text-primary truncate">{title}</h1>
            )}
          </div>
          <div className="flex items-center gap-2">
            {topBarRight}
            <ThemeToggle />
          </div>
        </header>

        {/* Content area */}
        <main className="flex flex-1 flex-col overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}
