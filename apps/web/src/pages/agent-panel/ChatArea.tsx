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
 * - **壳留宿主**：本文件只负责「把某个 Environment 的某个实例装进哪个槽位」——keep-alive 槽位表、懒加载
 *   边界、`ChatPageVisibleContext` 接线与宿主能力注入。判据是**状态归属**：槽位集合由宿主路由态决定
 *   （URL 里的 agent/session、侧栏的实例重启事件、实例删除集合），跨页面切换时槽位必须保持挂载，而包内的
 *   `ChatPanel` 只认识自己那一个 session。槽位表若进包，包就会持有宿主路由语义，分享页
 *   （`@fenix/resource-prod-view/web` 的 `chatArea` 端口）与工作流编辑器也都得跟着宿主路由走。
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
  evictDeletedEnvironmentSlots,
  resolveActiveChatEnvironmentId,
  type SessionSlot,
} from "@fenix/agent-runtime/web/agent-panel/chat-area-lifecycle";
import { resolveChatAuthState } from "@fenix/agent-runtime/web/hooks/chat-auth-state";
import { useSession } from "@fenix/identity/web";
import { getPeriTaskDetail } from "@fenix/model-management/web";
import type { ProdViewModulesConfig } from "@fenix/resource-prod-view/web";
import { useTaskViews } from "@fenix/resource-task/web/hooks/use-task-views";
import { ChatPageVisibleContext } from "@fenix/web-runtime/hooks/use-page-visible";
import { useRequest } from "ahooks";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
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
 * 两层 keep-alive：
 * 1. 页面级：通过 CSS display 控制可见性，切到非 chat 页面时保持挂载
 * 2. Session 级：缓存所有访问过的 session 的 ChatPanel 实例，
 *    同一 agent 下切换 session 时通过 CSS display 切换，不重建 WebSocket 连接
 *
 * agentId/sessionId 从 DefaultAppShell 的 URL 解析传入（而非 Route.useParams），
 * 仅当用户主动切换到新的 chat agent 时才变更，切到非 chat 页面时保持上次的 agentId。
 */
export function ChatArea({ agentId, sessionId, visible, deletedEnvironmentIds, modulesConfig }: ChatAreaProps) {
  const activeAgentId = resolveActiveChatEnvironmentId(agentId, deletedEnvironmentIds);

  // ── 宿主能力端口（为什么只能由宿主注入，见包内 chat-panel-host-ports.ts）──
  // 登录态：identity 是 platform-impl，包不得依赖；三态解析用包内纯函数，判据仍只有一份实现。
  const { data: session, isPending: sessionPending, error: sessionError } = useSession();
  const userId = session?.user?.id;
  const authState = resolveChatAuthState({ pending: sessionPending, error: sessionError, userId });

  // 已绑定 MCP 列表：查询要同时读 agent-config 与 MCP 资源包，包内不得依赖资源包，故由宿主取好后注入。
  // 查询失败降级为「无绑定 MCP」（面板仍可用）。
  const { data: boundMcps } = useRequest(async () => (activeAgentId ? loadBoundMcps(activeAgentId) : []), {
    refreshDeps: [activeAgentId],
    ready: !!activeAgentId,
    onError: (err) => console.warn("[ChatArea] 加载已绑定 MCP 失败", err),
  });

  // `useTaskViews` 与 `getPeriTaskDetail` 是模块级导入（引用天然稳定），故不进依赖数组。
  const hostPorts = useMemo<ChatPanelHostPorts>(
    () => ({
      authState,
      userId,
      usePeriTaskViews: useTaskViews,
      loadPeriTaskDetail: getPeriTaskDetail,
      boundMcps,
    }),
    [authState, userId, boundMcps],
  );

  // ── Session keep-alive 缓存 ──
  // 缓存所有访问过的 session slot，key 为 sessionId 或 agent-level 兜底 key
  const [sessionSlots, setSessionSlots] = useState<Record<string, SessionSlot>>({});
  const currentSessionKey = sessionId ?? (activeAgentId ? `__agent_${activeAgentId}` : null);

  // 新 session 首次访问时注册到缓存，触发重渲染以包含新的 ChatPanel 实例
  useEffect(() => {
    if (currentSessionKey && activeAgentId && !sessionSlots[currentSessionKey]) {
      setSessionSlots((prev) => ({
        ...prev,
        [currentSessionKey]: { agentId: activeAgentId, sessionId: sessionId ?? null },
      }));
    }
  }, [currentSessionKey, activeAgentId, sessionId, sessionSlots]);

  // 当前 slot 会在清理缓存后立即回填，必须单独递增重连版本以重新获取新实例的 capabilities。
  const [agentRestartVersions, setAgentRestartVersions] = useState<Record<string, number>>({});
  const activeAgentRestartVersion = activeAgentId ? (agentRestartVersions[activeAgentId] ?? 0) : 0;

  // 实例重启时：清除所有同 agent 的缓存 slot（它们都需要重建连接）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const restartedEnvironmentId = detail?.envId;
      if (typeof restartedEnvironmentId !== "string" || restartedEnvironmentId !== activeAgentId) return;

      setAgentRestartVersions((versions) => ({
        ...versions,
        [restartedEnvironmentId]: (versions[restartedEnvironmentId] ?? 0) + 1,
      }));
      // 清除同 agent 所有 session slot，重建 ChatPanel
      setSessionSlots((prev) => {
        const next: Record<string, SessionSlot> = {};
        for (const [key, slot] of Object.entries(prev)) {
          if (slot.agentId !== restartedEnvironmentId) {
            next[key] = slot;
          }
        }
        return next;
      });
    };
    window.addEventListener("agent:reconnect", handler);
    return () => window.removeEventListener("agent:reconnect", handler);
  }, [activeAgentId]);

  // Agent 删除后驱逐其全部 session slot，确保隐藏 ChatPanel 断开连接并停止请求。
  useEffect(() => {
    if (!deletedEnvironmentIds || deletedEnvironmentIds.size === 0) return;
    setSessionSlots((prev) => evictDeletedEnvironmentSlots(prev, deletedEnvironmentIds));
  }, [deletedEnvironmentIds]);

  // 合并 state 中的缓存 + 当前渲染中的 slot（首次访问时 effect 尚未触发，需要兜底）
  const allSlots = { ...sessionSlots };
  if (currentSessionKey && activeAgentId) {
    allSlots[currentSessionKey] = { agentId: activeAgentId, sessionId: sessionId ?? null };
  }

  // 聊天面板列表：每个 slot 一个 ChatPanel 实例，通过 CSS display 切换
  // 活跃面板使用 display:contents 使其在布局中透明，让 ChatPanel 直接作为 flex 子元素继承高度
  // 每个 ChatPanel 用独立的 ChatPageVisibleContext 包裹，传递 isActive，
  // 使非活跃面板的 SessionsProvider 能感知到自己被隐藏，从而停止轮询
  const chatPanels = Object.entries(allSlots).map(([key, slot]) => {
    const isActive = key === currentSessionKey && visible;
    const restartVersion = agentRestartVersions[slot.agentId] ?? 0;
    return (
      <ChatPageVisibleContext.Provider key={`${key}:${restartVersion}`} value={isActive}>
        <div style={{ display: isActive ? "contents" : "none" }}>
          {/* boundMcps 只注入当前活跃 slot：keep-alive 的隐藏 slot 若拿到活跃 agent 的列表，
              重新激活时会短暂显示另一个 agent 的 MCP 条目 */}
          <ChatPanel
            agentId={slot.agentId}
            sessionId={slot.sessionId}
            hostPorts={slot.agentId === activeAgentId ? hostPorts : { ...hostPorts, boundMcps: undefined }}
          />
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
            agentRestartVersion={activeAgentRestartVersion}
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
