import { LogOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { signOut, useSession } from "../../../src/lib/auth-client";
import { OrgSwitcher } from "../../components/OrgSwitcher";
import { AgentSidebarConfig, AgentSidebarQuickNav } from "./AgentSidebarConfig";
import { AgentSidebarTree } from "./AgentSidebarTree";

interface AgentSidebarProps {
  selectedInstanceId: string | null;
  onSelectInstance: (instanceId: string, envId: string, sessionId: string | null) => void;
  onNavigate: (pageId: string) => void;
  onCreateAgent?: () => void;
}

export function AgentSidebar({
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
    <aside className="agent-sidebar">
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
        <span className="text-sm font-bold tracking-[0.02em] text-text-bright whitespace-nowrap overflow-hidden">
          {t("brand")}
        </span>
      </div>

      {/* 快捷导航：模型、技能、MCP、组织管理 */}
      <AgentSidebarQuickNav onNavigate={onNavigate} />

      {/* 智能体树 */}
      <div className="border-t border-border-subtle">
        <AgentSidebarTree
          selectedInstanceId={selectedInstanceId}
          onSelectInstance={onSelectInstance}
          onCreateAgent={onCreateAgent}
        />
      </div>

      {/* 更多导航：下拉菜单 */}
      <div className="border-t border-border-subtle">
        <AgentSidebarConfig onNavigate={onNavigate} />
      </div>

      {/* 底部：组织切换 + 用户头像 */}
      <div className="mt-auto border-t border-border-subtle">
        {/* 组织切换 */}
        <div className="px-2 py-1.5">
          <OrgSwitcher />
        </div>

        {/* 用户头像 */}
        <div className="border-t border-border-subtle relative">
          <button
            type="button"
            onClick={() => setUserMenuOpen((v) => !v)}
            className="flex items-center gap-2.5 w-full px-4 py-2.5 cursor-pointer transition-colors duration-150"
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
            <span className="text-[12px] text-text-dim truncate">
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
      </div>
    </aside>
  );
}
