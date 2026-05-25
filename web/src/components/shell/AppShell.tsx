import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

interface AppShellProps {
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}

export function AppShell({ collapsed, onToggle, children }: AppShellProps) {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-surface-0">
      <Sidebar collapsed={collapsed} onToggle={onToggle} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar />
        {children}
      </div>
    </div>
  );
}
