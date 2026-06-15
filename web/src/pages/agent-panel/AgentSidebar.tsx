import { Link } from "@tanstack/react-router";
import { Building2, Check, ChevronLeft, ChevronRight, KeyRound, LogOut, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";
import { ChangePasswordDialog } from "../../../components/ChangePasswordDialog";
import { signOut, useSession } from "../../../src/lib/auth-client";
import { useOrg } from "../../contexts/OrgContext";
import { AgentSidebarQuickNav } from "./AgentSidebarConfig";
import { AgentSidebarTree } from "./AgentSidebarTree";

interface AgentSidebarProps {
  activeNav: string | null;
  selectedInstanceId?: string | null;
  selectedEnvironmentId?: string | null;
  onSelectInstance: (instanceId: string, envId: string, sessionId: string | null) => void;
  onNavigate: (pageId: string) => void;
  onCreateAgent?: () => void;
  onEditAgent?: (agentName: string) => void;
}

export function AgentSidebar({
  activeNav,
  selectedInstanceId = null,
  selectedEnvironmentId = null,
  onSelectInstance,
  onNavigate,
  onCreateAgent,
  onEditAgent,
}: AgentSidebarProps) {
  const { t: tSidebar } = useTranslation(NS.SIDEBAR);
  const { data: session } = useSession();
  const { org, orgs, switchOrg } = useOrg();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [orgMenuOpen, setOrgMenuOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("agent-panel:sidebar-collapsed") === "true");
  const userMenuRef = useRef<HTMLDivElement>(null);

  const userEmail = session?.user?.email ?? "";
  const userName = session?.user?.name || userEmail.split("@")[0] || "User";

  useEffect(() => {
    if (!userMenuOpen && !orgMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
        setOrgMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [userMenuOpen, orgMenuOpen]);

  useEffect(() => {
    localStorage.setItem("agent-panel:sidebar-collapsed", String(collapsed));
  }, [collapsed]);

  const handleLogout = async () => {
    setUserMenuOpen(false);
    await signOut({ fetchOptions: { credentials: "include" } });
  };

  const handleSwitchOrg = async (orgId: string) => {
    setOrgMenuOpen(false);
    await switchOrg(orgId);
  };

  return (
    <aside className={`agent-sidebar${collapsed ? " collapsed" : ""}`}>
      {/* 品牌区 */}
      <Link
        to="/agent/home"
        aria-label="Fenix Agent"
        className={[
          "agent-sidebar-brand",
          "flex items-center gap-2.5 px-4",
          "border-b border-border-subtle",
          "min-h-[var(--topbar-height)]",
          "bg-gradient-to-b from-surface-1 to-surface-0",
        ].join(" ")}
      >
        <FenixSidebarLogo />
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
          selectedEnvironmentId={selectedEnvironmentId}
          onSelectInstance={onSelectInstance}
          onCreateAgent={onCreateAgent}
          onEditAgent={onEditAgent}
        />
      </div>

      {/* 底部：用户 + 组织 */}
      <div className="agent-sidebar-footer border-t border-border-subtle">
        <div ref={userMenuRef} className="agent-sidebar-user-panel relative">
          {userMenuOpen && (
            <div className="agent-sidebar-user-menu absolute rounded-[var(--radius-lg)] shadow-lg shadow-black/10 z-50">
              <div className="agent-sidebar-user-menu-section">
                <button
                  type="button"
                  onClick={() => {
                    setUserMenuOpen(false);
                    setChangePasswordOpen(true);
                  }}
                  className="agent-sidebar-user-menu-item"
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  {tSidebar("personalSettings", { defaultValue: "个人设置" })}
                </button>
                <button type="button" onClick={handleLogout} className="agent-sidebar-user-menu-item danger">
                  <LogOut className="w-3.5 h-3.5" />
                  {tSidebar("logout")}
                </button>
              </div>
            </div>
          )}

          <div className="agent-sidebar-user">
            <button
              type="button"
              onClick={() => {
                setOrgMenuOpen(false);
                setUserMenuOpen((v) => !v);
              }}
              className="agent-sidebar-user-button"
            >
              <div className="agent-sidebar-avatar">
                <UserRound className="w-4 h-4" />
              </div>
              <span className="agent-sidebar-user-name truncate">{userName}</span>
              <ChevronRight className="agent-sidebar-user-chevron w-3.5 h-3.5" />
            </button>
          </div>

          {orgMenuOpen && (
            <div className="agent-sidebar-org-menu absolute rounded-[var(--radius-lg)] shadow-lg shadow-black/10 z-50">
              <div className="agent-sidebar-user-menu-section orgs">
                {orgs.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => void handleSwitchOrg(item.id)}
                    className={["agent-sidebar-user-menu-item", item.id === org?.id ? "active" : ""].join(" ")}
                  >
                    <Building2 className="w-3.5 h-3.5" />
                    <span className="truncate">{item.name}</span>
                    {item.id === org?.id && <Check className="ml-auto w-3.5 h-3.5" />}
                  </button>
                ))}
              </div>
            </div>
          )}

          {org && (
            <button
              type="button"
              className="agent-sidebar-org-row"
              onClick={() => {
                setUserMenuOpen(false);
                setOrgMenuOpen((v) => !v);
              }}
            >
              <Building2 className="agent-sidebar-org-icon w-4 h-4" />
              <span className="agent-sidebar-org-name truncate">{org.name}</span>
              <ChevronRight className="agent-sidebar-org-chevron w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      <ChangePasswordDialog open={changePasswordOpen} onOpenChange={setChangePasswordOpen} />
    </aside>
  );
}

function FenixSidebarLogo() {
  const assetBase = import.meta.env.BASE_URL;

  return (
    <span className="fenix-sidebar-logo">
      <img
        className="fenix-sidebar-logo-mark"
        src={`${assetBase}brand/fenix-agent-logo-mark.png`}
        alt=""
        aria-hidden="true"
      />
      <span className="fenix-sidebar-logo-text">Fenix Agent</span>
    </span>
  );
}
