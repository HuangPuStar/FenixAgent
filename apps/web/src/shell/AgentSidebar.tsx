import { AgentSidebarTree } from "@fenix/agent-config/web";
import { ChangePasswordDialog, signOut, useOrg, useSession } from "@fenix/identity/web";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@fenix/ui-components/ui/dropdown-menu";
import { ErrorFallback } from "@fenix/ui-components/ui/error-fallback";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@fenix/ui-components/ui/resizable";
import { Link } from "@tanstack/react-router";
import { Building2, Check, ChevronLeft, ChevronRight, KeyRound, LogOut, UserRound } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";
import { ShellNavigation } from "./ShellNavigation";

interface AgentSidebarProps {
  activeNav: string | null;
  selectedInstanceId?: string | null;
  selectedEnvironmentId?: string | null;
  onSelectInstance: (instanceId: string, envId: string, sessionId: string | null) => void;
  onNavigate: (pageId: string) => void;
  onCreateAgent?: () => void;
  onEditAgent?: (agentName: string) => void;
  onDeleteAgentEnvironments?: (environmentIds: string[]) => void;
}

/**
 * 左侧导航（§7.1 放置矩阵第 5 行）：非关键面板，根组件裹一层错误边界——智能体树 / 快捷导航 / 账号菜单
 * 任一崩溃时收缩成统一降级 UI（一次重试即可重新挂载侧栏），聊天区与输出面板不受影响。
 *
 * `memo` 留在导出这一层：它的职责是「props 未变就不重渲染」，与边界包在哪一层无关。
 *
 * 样式：取值全部在 `className`——刻度（`--spacing` / `--radius-*` / `--text-*`）已在 `@theme` 按 px 落地，
 * 工具类写的就是设计值（`w-60` = 240px、`size-11` = 44px、`text-13` = 13px），上一版「13px 根字号 →
 * 刻度只渲染名义值 0.8125 倍 → 手写 px」的口径已作废。折叠态由 `collapsed` 给**互斥的条件类串**
 * （`w-16 min-w-16` 对 `w-60 min-w-60`、折叠分支的内边距等），不再用 `.collapsed` 后代选择器，也不用
 * `--collapsed` 修饰类做同属性覆写。仍留在 CSS 的只有工具类表达不了的部分（见 `src/index.css` 的
 * 「宿主壳残余样式」段）：伪元素、`.agent-sidebar > *` 这样的跨元素覆写、复合渐变 / 投影 / 过渡、
 * 无标准档的取值。
 */
export const AgentSidebar = memo(function AgentSidebar(props: AgentSidebarProps) {
  return (
    <ErrorBoundary
      FallbackComponent={ErrorFallback}
      onError={(error, info) => console.error("[AgentSidebar] 渲染失败", error, info)}
    >
      <AgentSidebarView {...props} />
    </ErrorBoundary>
  );
});

/** 侧栏本体：品牌区、快捷导航、智能体树与底部账号/组织菜单。 */
function AgentSidebarView({
  activeNav,
  selectedInstanceId = null,
  selectedEnvironmentId = null,
  onSelectInstance,
  onNavigate,
  onCreateAgent,
  onEditAgent,
  onDeleteAgentEnvironments,
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
    <aside
      className={[
        "agent-sidebar relative z-10 flex shrink-0 flex-col overflow-visible text-white",
        // 折叠态与展开态的唯一几何差异是宽度，按状态在两个刻度类串之间切换：`w-60` / `min-w-60` = 240px，
        // `w-16` / `min-w-16` = 64px（与折叠条目 `8 + 48 + 8` 精确咬合）。深蓝双层渐变、主投影与宽度
        // 过渡仍在残余段里——那是复合值与过渡。
        collapsed ? "w-16 min-w-16" : "w-60 min-w-60",
      ].join(" ")}
    >
      {/* 品牌区：内边距 14px / 18px、高度下限 72px 展开态与折叠态各一串（折叠态居中、横向零内边距）。 */}
      <Link
        to="/agent/home"
        aria-label="Fenix AOS"
        className={[
          "agent-sidebar-brand flex items-center min-h-18 border-b border-white/10 no-underline",
          collapsed ? "justify-center px-0 py-3.5" : "px-4.5 py-3.5",
        ].join(" ")}
      >
        <FenixSidebarLogo collapsed={collapsed} />
      </Link>
      <button
        type="button"
        // 位置与尺寸（`top-6` = 24px / `-right-3` = -12px / `size-6` = 24×24 与图标 `size-3.5` = 14×14）
        // 全在这里；`position: absolute` 与 `z-index: 20` 仍留在残余段——`.agent-sidebar > *` 那条跨元素
        // 覆写（未分层、源顺序在后）会把工具类的 `relative` / `z-1` 反压回去，按钮会掉回文档流。
        className="agent-sidebar-toggle flex items-center justify-center top-6 -right-3 size-6 rounded-full border bg-white cursor-pointer"
        onClick={() => setCollapsed((value) => !value)}
        title={collapsed ? tSidebar("expand") : tSidebar("collapse")}
        aria-label={collapsed ? tSidebar("expand") : tSidebar("collapse")}
      >
        {collapsed ? <ChevronRight className="size-3.5 stroke-2" /> : <ChevronLeft className="size-3.5 stroke-2" />}
      </button>

      <ResizablePanelGroup orientation="vertical" className="agent-sidebar-sections flex-auto min-h-0">
        <ResizablePanel defaultSize="44%" minSize="120px">
          {/* 快捷导航：项来自各资源包的 web contribution，分组与组序由 Shell 声明 */}
          <div className="agent-sidebar-nav-wrap h-full min-h-0 overflow-hidden">
            <ShellNavigation onNavigate={onNavigate} activeNav={activeNav} collapsed={collapsed} />
          </div>
        </ResizablePanel>
        <ResizableHandle
          className={[
            // 高度 1px（`h-px`）与悬停 / 拖动中的强调青在这里；过渡的 `ease` 初值曲线与 `background`
            // 简写写不出等价工具类，留在残余段。层叠 / 收缩 / 光标 / 半透明白同在本串。
            "agent-sidebar-tree-resize-handle h-px z-2 shrink-0 cursor-row-resize bg-white/14 hover:bg-(--agent-sidebar-cyan)",
            collapsed ? "invisible pointer-events-none" : "",
          ].join(" ")}
          aria-label={tSidebar("resizeAgentArea")}
        />
        <ResizablePanel defaultSize="56%" minSize="160px">
          {/* 智能体树 */}
          <div
            className={[
              "agent-sidebar-tree-wrap flex flex-col h-full overflow-hidden",
              // 树面板的盒模型下限：展开态 `flex: 1 1 180px`（`grow shrink basis-45`）/ `min-height: 160px`
              // （`min-h-40`），折叠态覆盖成 `1 1 auto` / `min-height: 0`——两串互斥，由 `collapsed` 二选一。
              collapsed
                ? "grow shrink basis-auto min-h-0 invisible pointer-events-none"
                : "grow shrink basis-45 min-h-40",
            ].join(" ")}
          >
            <AgentSidebarTree
              selectedInstanceId={selectedInstanceId}
              selectedEnvironmentId={selectedEnvironmentId}
              onSelectInstance={onSelectInstance}
              onCreateAgent={onCreateAgent}
              onEditAgent={onEditAgent}
              onDeleteAgentEnvironments={onDeleteAgentEnvironments}
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      {/* 底部：用户 + 组织（折叠态只留头像，行内其余元素与整条组织行都不渲染） */}
      <div
        className={[
          "agent-sidebar-footer shrink-0 border-t border-white/10",
          // 折叠态的内边距 8 / 10 / 12 只在折叠分支给（展开态无内边距，用户面板自带）。
          collapsed ? "pt-2 px-2.5 pb-3" : "",
        ].join(" ")}
      >
        <div
          className={[
            "agent-sidebar-user-panel overflow-visible",
            // 用户面板内边距 12px 10px；折叠态归零（初值，不给类），留白改由上面那条给。
            collapsed ? "" : "px-2.5 py-3",
          ].join(" ")}
        >
          {/* 统一底部卡片（10px 圆角 = `rounded-10`，`--radius-10` 档 2026-09-28 补齐后从残余段撤回） */}
          <div className="agent-sidebar-footer-card rounded-10 bg-white/10 border border-white/10 overflow-hidden">
            <DropdownMenu open={userMenuOpen} onOpenChange={setUserMenuOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  onClick={() => setOrgMenuOpen(false)}
                  className={[
                    "agent-sidebar-user-button flex min-h-10 px-3 w-full items-center bg-transparent text-white text-13 font-semibold cursor-pointer hover:bg-white/6",
                    // 折叠态：48px 高、内容居中、无内边距、无分隔线（`transition` 留在残余段，行高由 `text-13` 定）。
                    collapsed ? "justify-center min-h-12 border-b-0" : "border-b border-white/8",
                  ].join(" ")}
                >
                  <div className="agent-sidebar-avatar-slot w-8 h-6.5 flex shrink-0 items-center justify-center">
                    <div className="agent-sidebar-avatar size-6.5 flex shrink-0 items-center justify-center rounded-full text-white">
                      <UserRound className="w-4 h-4" />
                    </div>
                  </div>
                  {!collapsed && (
                    <span className="agent-sidebar-user-name truncate flex-1 min-w-0 pl-2.5 text-left text-13 font-semibold text-white">
                      {userName}
                    </span>
                  )}
                  {!collapsed && (
                    <ChevronRight
                      className="agent-sidebar-user-chevron size-3.5 shrink-0 text-white/30"
                      strokeWidth={2.2}
                    />
                  )}
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
                  {tSidebar("changePassword")}
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

            {!collapsed && org && (
              <DropdownMenu open={orgMenuOpen} onOpenChange={setOrgMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setUserMenuOpen(false)}
                    className="agent-sidebar-org-row flex min-h-10 px-3 w-full items-center bg-transparent cursor-pointer text-white/55 text-11 hover:bg-white/6"
                  >
                    <div className="agent-sidebar-org-icon-wrap w-8 h-6.5 flex shrink-0 items-center justify-center">
                      <Building2 className="agent-sidebar-org-icon size-4 shrink-0 text-white/45" />
                    </div>
                    <span className="agent-sidebar-org-name truncate flex-1 min-w-0 pl-2.5 text-left text-11 font-normal">
                      {org.name}
                    </span>
                    <ChevronRight
                      className="agent-sidebar-org-chevron size-3.5 shrink-0 text-white/30"
                      strokeWidth={2.2}
                    />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="end" sideOffset={4} className="min-w-48 p-1.5">
                  <div className="px-3 py-2 text-xs text-muted-foreground font-medium">{tSidebar("switchOrgHint")}</div>
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

function FenixSidebarLogo({ collapsed }: { collapsed: boolean }) {
  const { t: tSidebar } = useTranslation(NS.SIDEBAR);
  const assetBase = import.meta.env.BASE_URL;

  return (
    <span
      className={[
        "fenix-sidebar-logo flex w-full items-center",
        // 展开态的 10px 间距（`gap-2.5`）与折叠态的居中 / 零间距（`gap-0`）各一串。
        collapsed ? "justify-center gap-0" : "gap-2.5",
      ].join(" ")}
    >
      <img
        className="fenix-sidebar-logo-mark size-11 block shrink-0 object-contain object-center"
        src={`${assetBase}brand/fenix-agent-logo-mark.png`}
        alt=""
        aria-hidden="true"
      />
      {!collapsed && (
        <span className="fenix-sidebar-logo-text min-w-0 flex flex-col gap-px text-white/96 leading-none">
          <span className="fenix-sidebar-logo-main mb-0.75 font-extrabold whitespace-nowrap text-17 tracking-6">
            Fenix AOS
          </span>
          <span className="fenix-sidebar-logo-sub font-medium whitespace-nowrap opacity-72 text-3xs tracking-4">
            {tSidebar("brandSubtitle")}
          </span>
        </span>
      )}
    </span>
  );
}
