import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { Button } from "@/components/ui/button";
import { LogOut } from "lucide-react";

export interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  active?: boolean;
  onClick: () => void;
}

interface AppShellProps {
  navItems: NavItem[];
  userEmail: string;
  onLogout: () => void;
  children: ReactNode;
}

export function AppShell({ navItems, userEmail, onLogout, children }: AppShellProps) {
  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-surface-0">
      {/* First row: brand + user account */}
      <header className="flex h-12 items-center justify-between border-b border-border bg-surface-1 px-4 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="flex-shrink-0">
            <path
              d="M10 1L12.2 7.8L19 10L12.2 12.2L10 19L7.8 12.2L1 10L7.8 7.8L10 1Z"
              fill="#409EFF"
            />
          </svg>
          <span className="text-sm font-semibold text-text-primary">AI Panel</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted truncate max-w-[200px]">{userEmail}</span>
          <Button variant="ghost" size="sm" onClick={onLogout} title="退出登录">
            <LogOut className="h-4 w-4" />
          </Button>
          <ThemeToggle />
        </div>
      </header>

      {/* Second row: navigation tabs */}
      <nav className="flex h-10 items-center gap-1 border-b border-border bg-surface-1 px-4 flex-shrink-0 overflow-x-auto">
        {navItems.map((item) => (
          <Button
            key={item.id}
            variant="ghost"
            size="sm"
            onClick={item.onClick}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1 text-sm font-normal whitespace-nowrap",
              item.active
                ? "bg-brand/10 text-brand"
                : "text-text-secondary hover:bg-surface-2 hover:text-text-primary",
            )}
          >
            <span className="flex-shrink-0">{item.icon}</span>
            <span>{item.label}</span>
          </Button>
        ))}
      </nav>

      {/* Content area */}
      <main className="flex flex-1 flex-col overflow-hidden">
        {children}
      </main>
    </div>
  );
}
