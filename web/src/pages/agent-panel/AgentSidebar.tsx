import { Link } from "@tanstack/react-router";
import { Building2, Check, ChevronLeft, ChevronRight, KeyRound, LogOut, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

  const userEmail = session?.user?.email ?? "";
  const userName = session?.user?.name || userEmail.split("@")[0] || "User";

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
        <div className="agent-sidebar-user-panel">
          {/* 统一底部卡片 */}
          <div className="agent-sidebar-footer-card">
            <DropdownMenu open={userMenuOpen} onOpenChange={setUserMenuOpen}>
              <DropdownMenuTrigger asChild>
                <button type="button" onClick={() => setOrgMenuOpen(false)} className="agent-sidebar-user-button">
                  <div className="agent-sidebar-avatar-slot">
                    <div className="agent-sidebar-avatar">
                      <UserRound className="w-4 h-4" />
                    </div>
                  </div>
                  <span className="agent-sidebar-user-name truncate">{userName}</span>
                  <ChevronRight className="agent-sidebar-user-chevron w-3.5 h-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="end" sideOffset={4} className="min-w-48 p-1.5">
                <DropdownMenuItem
                  onClick={() => {
                    setUserMenuOpen(false);
                    setChangePasswordOpen(true);
                  }}
                  className="px-3 py-2.5 focus:outline-none focus-visible:ring-0"
                >
                  <KeyRound className="w-4 h-4" />
                  {tSidebar("changePassword", { defaultValue: "修改密码" })}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={handleLogout}
                  className="px-3 py-2.5 focus:outline-none focus-visible:ring-0"
                >
                  <LogOut className="w-4 h-4" />
                  {tSidebar("logout")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {org && (
              <DropdownMenu open={orgMenuOpen} onOpenChange={setOrgMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <button type="button" onClick={() => setUserMenuOpen(false)} className="agent-sidebar-org-row">
                    <div className="agent-sidebar-org-icon-wrap">
                      <Building2 className="agent-sidebar-org-icon w-4 h-4" />
                    </div>
                    <span className="agent-sidebar-org-name truncate">{org.name}</span>
                    <ChevronRight className="agent-sidebar-org-chevron w-3.5 h-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="end" sideOffset={4} className="min-w-48 p-1.5">
                  <div className="px-3 py-2 text-xs text-muted-foreground font-medium">
                    {tSidebar("switchOrgHint", { defaultValue: "点击切换组织" })}
                  </div>
                  {orgs.map((item) => (
                    <DropdownMenuItem
                      key={item.id}
                      onClick={() => void handleSwitchOrg(item.id)}
                      className="px-3 py-2.5 focus:outline-none focus-visible:ring-0"
                    >
                      <Building2 className="w-4 h-4" />
                      <span className="truncate">{item.name}</span>
                      {item.id === org?.id && <Check className="ml-auto w-4 h-4" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
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
