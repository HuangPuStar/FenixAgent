import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { TeamSwitcher } from "../../components/TeamSwitcher";
import { AgentSidebarConfig } from "./AgentSidebarConfig";
import { AgentSidebarTree } from "./AgentSidebarTree";

interface AgentSidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  selectedInstanceId: string | null;
  onSelectInstance: (instanceId: string, envId: string, sessionId: string | null) => void;
  onNavigate: (pageId: string) => void;
}

export function AgentSidebar({
  collapsed,
  onToggleCollapse,
  selectedInstanceId,
  onSelectInstance,
  onNavigate,
}: AgentSidebarProps) {
  return (
    <aside className={["agent-sidebar", collapsed ? "collapsed" : ""].join(" ")}>
      {/* 品牌区 */}
      <div
        className={[
          "flex items-center gap-2.5 px-4",
          "border-b border-border-subtle",
          "min-h-[var(--topbar-height)]",
          "bg-gradient-to-b from-surface-1 to-surface-0",
        ].join(" ")}
      >
        <div
          className={[
            "w-7 h-7 rounded-lg flex-shrink-0",
            "flex items-center justify-center",
            "bg-gradient-to-br from-brand to-brand-light",
            "text-white font-bold text-sm",
            "shadow-[0_2px_8px_rgba(99,102,241,0.25)]",
          ].join(" ")}
        >
          X
        </div>
        <span
          className={[
            "text-sm font-bold tracking-[0.02em] text-text-bright",
            "whitespace-nowrap overflow-hidden",
            "transition-opacity duration-200",
            collapsed ? "opacity-0" : "opacity-100",
          ].join(" ")}
        >
          XAgent
        </span>
        <button
          type="button"
          onClick={onToggleCollapse}
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
          {collapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
        </button>
      </div>

      {/* 配置导航区 */}
      <AgentSidebarConfig collapsed={collapsed} onNavigate={onNavigate} />

      {/* 分隔线 */}
      <div className="mx-3 border-t border-border-subtle" />

      {/* 智能体树 */}
      <AgentSidebarTree
        collapsed={collapsed}
        selectedInstanceId={selectedInstanceId}
        onSelectInstance={onSelectInstance}
      />

      {/* 底部团队切换器 */}
      <div className="border-t border-border-subtle px-2 py-2">
        {!collapsed && (
          <div className="px-1 mb-1.5">
            <TeamSwitcher />
          </div>
        )}
      </div>
    </aside>
  );
}
