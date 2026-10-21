/**
 * ChatArea — 聊天会话容器，**属于宿主 Shell**；chat 域实现在 `@fenix/agent-runtime/web`。
 *
 * 边界（2026-09-25，台账 `ce-standards-todo.md` D1 复核后的裁定，**改写** T5b「聊天容器整体留宿主」的旧结论）：
 * - **域归包**：`ChatPanel`（面板壳）、`use-chat-panel-runtime`（连接状态机）、`chat-panel-ports`
 *   （ui-components 面板的端口装配）、`FilePickerDialog`（取件入口）、`chat-area-lifecycle`（槽位失效判据）
 *   全部迁入 `packages/agent-runtime/web/agent-panel/`。§9 的归属表把 Chat 划给 `@fenix/agent-runtime`，
 *   而这些是聊天本身，不是「把哪个 Environment 装进哪个面板」的装配。T6d 曾让它们回宿主，理由是当时的
 *   实现直接依赖 `@fenix/identity/web`、`@fenix/resource-task/web` 与宿主 `@/src/*`；本次把这些跨域能力
 *   改成宿主注入（逐项理由见包内 `chat-panel-host-ports.ts`）、把文案键随实现迁入包字典后，回包不再
 *   产生任何越界依赖。
 * - **壳留宿主**：本文件负责宿主路由参数、懒加载边界、可见性与能力端口装配；
 *   包内 `useChatAreaSlots` 只接收身份、Environment 和实例标识，维护稳定的缓存生命周期，
 *   不读取宿主路由。每个 `ChatPanel` 只持有自己的会话与环境数据。
 * - 右侧工件面板的装配在同目录 `chat-workspace-artifacts.tsx`（宿主页面布局与宿主偏好，不属于聊天域）。
 *
 * 样式：本文件不再导入任何样式表。工件面板的伴随表 `artifacts-workspace.css` 已于 2026-09-28 退役：
 * 几何撤回各消费方（本文件、`chat-workspace-artifacts.tsx`、`artifacts/ArtifactsPanel.tsx` 与
 * `artifacts/TopModeTabs.tsx`）的 `className`，伪元素与 `[data-layout]` 属性选择器等残余规则收进
 * `apps/web/src/index.css` 的「宿主壳残余样式」段——**进静态表**这件事本身做过复核：该表原先是本文件的
 * 副作用导入（懒加载 chunk，运行期 append 到 head 末尾，与 index.html 静态 <link> 的先后正好相反），
 * 搬进静态表后逐条 grep 确认全仓没有第二条**同为未分层**的规则命中同一选择器（只有 `@layer utilities`
 * 里的工具类会被它压过，层级关系不变），T5b 那种「静态表赢过宿主表、docked 多出 10px 间隙」的前提
 * （同名对冲的两条规则）已随 `chat-layout.css` 删除而消失，级联结论不因加载顺序改变。
 *
 * 姊妹文件 `./chat-layout.css` 已于 2026-09-28 清空删除（声明就近取档到本文件与包内组件的 `className`，
 * 页面壳类名不再有 CSS 规则）；它的移除同时消掉了 `gap: 0`/`gap: 10px` 那对同名对冲——现在
 * `.agent-chat-workspace` 的工具类里只有 `gap-0`（原生效值）。拆出的 `chat-workspace-artifacts.tsx`
 * 不导入 CSS，宿主 `src/` 现在只剩 `index.css` 一份样式表（由 `main.tsx` 静态导入）。
 *
 * 页面壳类名的取值全部在本文件的 `className` 里（`.agent-panel-content` / `.agent-chat-area` 等）；
 * `.agent-panel-body` / `.agent-panel-layout` 的取值在各自的渲染点（`DefaultAppShell`、`$prodViewId`、
 * `ProdViewPage`），宿主样式表已不再为它们声明任何属性。
 *
 * 外部注入点：`ProdViewPage`（`@fenix/resource-prod-view/web`）不直接引用本组件，而是通过
 * `ProdViewChatAreaProps` 窄端口接收宿主传入的聊天容器——分享页路由 `apps/web/src/routes/view/$prodViewId.tsx`
 * 负责把本组件作为该 prop 注入。
 */

import { loadBoundMcps } from "@fenix/agent-config/web";
import type { ChatPanelHostPorts } from "@fenix/agent-runtime/web";
import {
  resolveActiveChatEnvironmentId,
  useChatAreaSlots,
} from "@fenix/agent-runtime/web/agent-panel/chat-area-lifecycle";
import { resolveChatAuthState } from "@fenix/agent-runtime/web/hooks/chat-auth-state";
import { useSession } from "@fenix/identity/web";
import { getPeriTaskDetail } from "@fenix/model-management/web";
import type { ProdViewModulesConfig } from "@fenix/resource-prod-view/web";
import { useTaskViews } from "@fenix/resource-task/web/hooks/use-task-views";
import { useOrgSession } from "@fenix/web-runtime/contexts/org-session";
import { ChatPageVisibleContext } from "@fenix/web-runtime/hooks/use-page-visible";
import { useRequest } from "ahooks";
import { lazy, Suspense, useMemo } from "react";
import { PanelRouteFallback } from "@/src/components/panel-route-fallback";
import { ChatWorkspaceArtifacts } from "./chat-workspace-artifacts";

// 懒加载边界落在包的 `./web` 出口上：本文件（宿主壳）同步加载，面板实现随该动态 import 分块。
const ChatPanel = lazy(() => import("@fenix/agent-runtime/web").then((m) => ({ default: m.ChatPanel })));

interface ChatAreaProps {
  agentId: string | null;
  sessionId?: string | null;
  visible: boolean;
  /** 已删除的 Environment；对应 keep-alive slot 必须立即卸载。 */
  deletedEnvironmentIds?: ReadonlySet<string>;
  /** ProdView 模块配置，控制右侧附加面板的显示/隐藏 */
  modulesConfig?: ProdViewModulesConfig;
}

/**
 * ChatArea — 始终挂载的聊天区域容器。
 *
 * 两层生命周期：
 * 1. 页面级：通过 CSS display 控制可见性，切到非 chat 页面时保持挂载
 * 2. 实例级：按 Environment + instanceUid 保留 ChatPanel，切换只改变可见性；
 *    删除、重启或组织/用户变化时释放对应槽位
 *
 * agentId/sessionId 从 DefaultAppShell 的 URL 解析传入（而非 Route.useParams），
 * 仅当用户主动切换到新的 chat agent 时才变更，切到非 chat 页面时保持上次的 agentId。
 */
export function ChatArea({ agentId, sessionId, visible, deletedEnvironmentIds, modulesConfig }: ChatAreaProps) {
  const activeAgentId = resolveActiveChatEnvironmentId(agentId, deletedEnvironmentIds);
  const { organizationId } = useOrgSession();

  // ── 宿主能力端口（为什么只能由宿主注入，见包内 chat-panel-host-ports.ts）──
  // 登录态：identity 是 platform-impl，包不得依赖；三态解析用包内纯函数，判据仍只有一份实现。
  const { data: session, isPending: sessionPending, error: sessionError } = useSession();
  const userId = session?.user?.id;
  const authState = resolveChatAuthState({ pending: sessionPending, error: sessionError, userId });

  // `useTaskViews` 与 `getPeriTaskDetail` 是模块级导入（引用天然稳定），故不进依赖数组。
  const hostPorts = useMemo<ChatPanelHostPorts>(
    () => ({
      authState,
      userId,
      usePeriTaskViews: useTaskViews,
      loadPeriTaskDetail: getPeriTaskDetail,
    }),
    [authState, userId],
  );

  const { slots, activeRestartVersion } = useChatAreaSlots(
    agentId,
    sessionId ?? null,
    JSON.stringify([organizationId, userId]),
    deletedEnvironmentIds,
  );
  const chatPanels = slots.map((slot) => {
    const isActive = slot.active && visible;
    return (
      <ChatPageVisibleContext.Provider key={slot.key} value={isActive}>
        <div style={{ display: isActive ? "contents" : "none" }}>
          <HostedChatPanel agentId={slot.agentId} sessionId={slot.sessionId} hostPorts={hostPorts} />
        </div>
      </ChatPageVisibleContext.Provider>
    );
  });

  return (
    <Suspense fallback={<PanelRouteFallback />}>
      <ChatPageVisibleContext.Provider value={visible}>
        <div
          className="agent-panel-content agent-panel-content--chat relative flex min-w-0 flex-1 min-h-0 overflow-hidden bg-white p-0"
          style={{ display: visible ? undefined : "none" }}
        >
          <ChatWorkspaceArtifacts
            agentId={activeAgentId}
            sessionId={sessionId ?? null}
            agentRestartVersion={activeRestartVersion}
            modulesConfig={modulesConfig}
          >
            <div className="agent-chat-area flex h-auto min-w-0 min-h-0 flex-1 flex-col overflow-hidden bg-transparent">
              {chatPanels}
            </div>
          </ChatWorkspaceArtifacts>
        </div>
      </ChatPageVisibleContext.Provider>
    </Suspense>
  );
}

/** 每个缓存面板持有自己环境的 MCP 数据，避免切换 Agent 时覆盖后台面板的能力。 */
function HostedChatPanel({
  agentId,
  sessionId,
  hostPorts,
}: {
  agentId: string;
  sessionId: string | null;
  hostPorts: ChatPanelHostPorts;
}) {
  const { data: boundMcps } = useRequest(() => loadBoundMcps(agentId), {
    refreshDeps: [agentId],
    ready: hostPorts.authState === "ready",
    onError: (err) => console.warn("[ChatArea] 加载已绑定 MCP 失败", err),
  });
  const scopedPorts = useMemo(() => ({ ...hostPorts, boundMcps }), [hostPorts, boundMcps]);
  return <ChatPanel agentId={agentId} sessionId={sessionId} hostPorts={scopedPorts} />;
}
