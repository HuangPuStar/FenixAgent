import { ChevronsLeft, ChevronsRight, LogOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { signOut, useSession } from "../../../src/lib/auth-client";
import { OrgSwitcher } from "../../components/OrgSwitcher";
import { AgentSidebarConfig } from "./AgentSidebarConfig";
import { AgentSidebarTree } from "./AgentSidebarTree";

interface AgentSidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  selectedInstanceId: string | null;
  onSelectInstance: (instanceId: string, envId: string, sessionId: string | null) => void;
  onNavigate: (pageId: string) => void;
  onCreateAgent?: () => void;
}

export function AgentSidebar({
  collapsed,
  onToggleCollapse,
  selectedInstanceId,
  onSelectInstance,
  onNavigate,
  onCreateAgent,
}: AgentSidebarProps) {
  const { t } = useTranslation("agentPanel");
  const { t: tSidebar } = useTranslation("sidebar");
  const { data: session } = useSession();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  const userEmail = session?.user?.email ?? "";
  const avatarLetter = userEmail.charAt(0).toUpperCase() || "U";

  useEffect(() => {
    if (!userMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [userMenuOpen]);

  const handleLogout = async () => {
    setUserMenuOpen(false);
    await signOut({ fetchOptions: { credentials: "include" } });
  };

  return (
    <aside className={["agent-sidebar", collapsed ? "collapsed" : ""].join(" ")}>
      {/* 品牌区 + 团队切换器 */}
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
          {t("brand")}
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
          title={collapsed ? t("expandSidebar") : t("collapseSidebar")}
        >
          {collapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
        </button>
      </div>

      {/* 团队切换器 */}
      <div className="border-b border-border-subtle px-2 py-2">
        {!collapsed && (
          <div className="px-1">
            <OrgSwitcher />
          </div>
        )}
      </div>

      {/* 智能体树 */}
      <AgentSidebarTree
        collapsed={collapsed}
        selectedInstanceId={selectedInstanceId}
        onSelectInstance={onSelectInstance}
        onCreateAgent={onCreateAgent}
      />

      {/* 配置导航 */}
      <AgentSidebarConfig collapsed={collapsed} onNavigate={onNavigate} />

      {/* 用户头像 */}
      <div className="relative border-t border-border-subtle mt-auto">
        <button
          type="button"
          onClick={() => setUserMenuOpen((v) => !v)}
          className={[
            "flex items-center w-full",
            "cursor-pointer transition-colors duration-150",
            collapsed ? "justify-center py-2.5" : "gap-2.5 px-4 py-2.5",
          ].join(" ")}
          title={collapsed ? userEmail : undefined}
        >
          <div
            className={[
              "w-8 h-8 rounded-full flex-shrink-0",
              "flex items-center justify-center",
              "bg-gradient-to-br from-brand to-brand-light",
              "text-white text-[13px] font-semibold",
              "transition-shadow duration-150",
              "hover:shadow-[0_0_0_3px_rgba(99,102,241,0.15)]",
            ].join(" ")}
          >
            {avatarLetter}
          </div>
          <span
            className={[
              "text-[12px] text-text-dim truncate",
              "transition-opacity duration-200",
              collapsed ? "opacity-0 w-0" : "opacity-100",
            ].join(" ")}
          >
            {userEmail}
          </span>
        </button>

        {userMenuOpen && (
          <div
            ref={userMenuRef}
            className={[
              "absolute left-2 right-2 bottom-full mb-1",
              "py-1.5",
              "rounded-[var(--radius-lg)]",
              "border border-border-default bg-surface-2",
              "shadow-lg shadow-black/10",
              "z-50",
            ].join(" ")}
          >
            <div className="px-3 py-2 border-b border-border-subtle">
              <p className="text-[13px] font-medium text-text-bright truncate">{userEmail}</p>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className={[
                "flex items-center gap-2 w-full px-3 py-2",
                "text-[13px] text-text-default",
                "hover:bg-surface-elevated rounded-[var(--radius)] mx-0.5",
                "transition-colors duration-100",
              ].join(" ")}
            >
              <LogOut className="w-3.5 h-3.5" />
              {tSidebar("logout")}
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
