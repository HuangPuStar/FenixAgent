import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, KeyRound, LogOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";
import { getAppBrand } from "@/src/lib/app-brand";
import { ChangePasswordDialog } from "../../../components/ChangePasswordDialog";
import { signOut, useSession } from "../../../src/lib/auth-client";
import { OrgSwitcher } from "../../components/OrgSwitcher";
import { AgentSidebarQuickNav } from "./AgentSidebarConfig";
import { AgentSidebarTree } from "./AgentSidebarTree";

interface AgentSidebarProps {
  activeNav: string | null;
  selectedInstanceId?: string | null;
  onSelectInstance: (instanceId: string, envId: string, sessionId: string | null) => void;
  onNavigate: (pageId: string) => void;
  onCreateAgent?: () => void;
  onEditAgent?: (agentName: string) => void;
}

export function AgentSidebar({
  activeNav,
  selectedInstanceId = null,
  onSelectInstance,
  onNavigate,
  onCreateAgent,
  onEditAgent,
}: AgentSidebarProps) {
  const { t: tSidebar } = useTranslation(NS.SIDEBAR);
  const { data: session } = useSession();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("agent-panel:sidebar-collapsed") === "true");
  const userMenuRef = useRef<HTMLDivElement>(null);
  const brand = getAppBrand();

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

  useEffect(() => {
    localStorage.setItem("agent-panel:sidebar-collapsed", String(collapsed));
  }, [collapsed]);

  const handleLogout = async () => {
    setUserMenuOpen(false);
    await signOut({ fetchOptions: { credentials: "include" } });
  };

  return (
    <aside className={`agent-sidebar${collapsed ? " collapsed" : ""}`}>
      {/* 品牌区 */}
      <Link
        to="/agent/home"
        className={[
          "agent-sidebar-brand",
          "flex items-center gap-2.5 px-4",
          "border-b border-border-subtle",
          "min-h-[var(--topbar-height)]",
          "bg-gradient-to-b from-surface-1 to-surface-0",
        ].join(" ")}
      >
        <FenixSidebarLogo />
        <span className="agent-sidebar-brand-text text-sm font-bold tracking-[0.02em] text-text-bright whitespace-nowrap overflow-hidden">
          {brand.name}
        </span>
      </Link>
      <button
        type="button"
        className="agent-sidebar-toggle"
        onClick={() => setCollapsed((value) => !value)}
        title={collapsed ? "展开侧栏" : "收起侧栏"}
        aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
      >
        {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
      </button>

      {/* 快捷导航：模型、技能、MCP、组织管理 */}
      <AgentSidebarQuickNav onNavigate={onNavigate} activeNav={activeNav} />

      {/* 智能体树 */}
      <div className="agent-sidebar-tree-wrap border-t border-border-subtle flex-1 min-h-0 overflow-hidden">
        <AgentSidebarTree
          selectedInstanceId={selectedInstanceId}
          onSelectInstance={onSelectInstance}
          onCreateAgent={onCreateAgent}
          onEditAgent={onEditAgent}
        />
      </div>

      {/* 底部：组织切换 + 用户头像 */}
      <div className="agent-sidebar-footer border-t border-border-subtle">
        {/* 组织切换 */}
        <div className="px-2 py-1.5">
          <OrgSwitcher />
        </div>

        {/* 用户头像 */}
        <div className="agent-sidebar-user border-t border-border-subtle relative">
          <button
            type="button"
            onClick={() => setUserMenuOpen((v) => !v)}
            className="agent-sidebar-user-button flex items-center gap-2.5 w-full px-4 py-2.5 cursor-pointer transition-colors duration-150"
          >
            <div
              className={[
                "agent-sidebar-avatar",
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
            <span className="agent-sidebar-user-email text-[12px] text-text-dim truncate">{userEmail}</span>
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
                onClick={() => {
                  setUserMenuOpen(false);
                  setChangePasswordOpen(true);
                }}
                className={[
                  "flex items-center gap-2 w-full px-3 py-2",
                  "text-[13px] text-text-default",
                  "hover:bg-surface-elevated rounded-[var(--radius)] mx-0.5",
                  "transition-colors duration-100",
                ].join(" ")}
              >
                <KeyRound className="w-3.5 h-3.5" />
                {tSidebar("changePassword")}
              </button>
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
      </div>
      <ChangePasswordDialog open={changePasswordOpen} onOpenChange={setChangePasswordOpen} />
    </aside>
  );
}

function FenixSidebarLogo() {
  return (
    <svg className="agent-sidebar-logo w-8 h-8 flex-shrink-0" viewBox="0 0 200 200" aria-hidden="true">
      <path
        d="M100 20C130 40 150 70 150 100C150 130 130 160 100 180C70 160 50 130 50 100C50 70 70 40 100 20Z"
        fill="none"
        stroke="#fff"
        strokeWidth="6"
      />
      <path d="M70 60Q100 30 130 60" fill="none" stroke="#6BE6FF" strokeWidth="4" />
      <path d="M60 80Q100 40 140 80" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="3" />
      <path d="M60 120Q100 160 140 120" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="3" />
      <path d="M70 140Q100 170 130 140" fill="none" stroke="#6BE6FF" strokeWidth="4" />
      <rect x="92" y="92" width="16" height="16" rx="2" fill="#6BE6FF" transform="rotate(45 100 100)" />
    </svg>
  );
}
