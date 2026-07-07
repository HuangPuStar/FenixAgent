import { useRequest } from "ahooks";
import { PanelRight } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePanelRef } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { envApi } from "@/src/api/environments";
import { unwrap } from "@/src/api/request";
import { extractChangedFiles } from "@/src/lib/extract-changed-files";
import type { ThreadEntry } from "@/src/lib/types";
import { cn } from "@/src/lib/utils";

const ChatPanel = lazy(() => import("./ChatPanel").then((m) => ({ default: m.ChatPanel })));
const ArtifactsPanel = lazy(() => import("./ArtifactsPanel").then((m) => ({ default: m.ArtifactsPanel })));

interface ChatAreaProps {
  agentId: string | null;
  sessionId?: string | null;
  visible: boolean;
}

interface SessionSlot {
  agentId: string;
  sessionId: string | null;
}

/**
 * ChatArea — 始终挂载的聊天区域组件。
 *
 * 两层 keep-alive：
 * 1. 页面级：通过 CSS display 控制可见性，切到非 chat 页面时保持挂载
 * 2. Session 级：缓存所有访问过的 session 的 ChatPanel 实例，
 *    同一 agent 下切换 session 时通过 CSS display 切换，不重建 WebSocket 连接
 *
 * agentId/sessionId 从 AgentPanelLayout 的 URL 解析传入（而非 Route.useParams），
 * 仅当用户主动切换到新的 chat agent 时才变更，切到非 chat 页面时保持上次的 agentId。
 */
export function ChatArea({ agentId, sessionId, visible }: ChatAreaProps) {
  const { t } = useTranslation("agentPanel");

  const artifactsPanelRef = usePanelRef();
  const artifactsCollapsedRef = useRef(true);
  const [artifactsCollapsed, setArtifactsCollapsed] = useState(true);

  // 仅无 sessionId 时加载 environment.agentConfigId（与 chat.$agentId 行为对齐）
  const { data: agentConfigId = null } = useRequest(
    async () => {
      if (!agentId) return null;
      const env = await unwrap(envApi.get({ id: agentId }));
      return env.agentConfigId ?? null;
    },
    {
      refreshDeps: [agentId],
      ready: !!agentId && !sessionId,
      onError: (err) => console.warn("[ChatArea] 加载 environment 详情失败", err),
    },
  );

  const [entries, setEntries] = useState<ThreadEntry[]>([]);
  const [restartKey, setRestartKey] = useState(0);
  const changedFiles = useMemo(() => extractChangedFiles(entries), [entries]);

  // ── Session keep-alive 缓存 ──
  // 缓存所有访问过的 session slot，key 为 sessionId 或 agent-level 兜底 key
  const [sessionSlots, setSessionSlots] = useState<Record<string, SessionSlot>>({});
  const currentSessionKey = sessionId ?? (agentId ? `__agent_${agentId}` : null);

  // 新 session 首次访问时注册到缓存，触发重渲染以包含新的 ChatPanel 实例
  useEffect(() => {
    if (currentSessionKey && agentId && !sessionSlots[currentSessionKey]) {
      setSessionSlots((prev) => ({
        ...prev,
        [currentSessionKey]: { agentId, sessionId: sessionId ?? null },
      }));
    }
  }, [currentSessionKey, agentId, sessionId, sessionSlots]);

  // 实例重启时：清除所有同 agent 的缓存 slot（它们都需要重建连接）
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.envId && detail.envId === agentId) {
        setEntries([]);
        setRestartKey((k) => k + 1);
        // 清除同 agent 所有 session slot，重建 ChatPanel
        setSessionSlots((prev) => {
          const next: Record<string, SessionSlot> = {};
          for (const [key, slot] of Object.entries(prev)) {
            if (slot.agentId !== agentId) {
              next[key] = slot;
            }
          }
          return next;
        });
      }
    };
    window.addEventListener("agent:reconnect", handler);
    return () => window.removeEventListener("agent:reconnect", handler);
  }, [agentId]);

  // 合并 state 中的缓存 + 当前渲染中的 slot（首次访问时 effect 尚未触发，需要兜底）
  const allSlots = { ...sessionSlots };
  if (currentSessionKey && agentId) {
    allSlots[currentSessionKey] = { agentId, sessionId: sessionId ?? null };
  }

  // 聊天面板列表：每个 slot 一个 ChatPanel 实例，通过 CSS display 切换
  // 活跃面板使用 display:contents 使其在布局中透明，让 ChatPanel 直接作为 flex 子元素继承高度
  const chatPanels = Object.entries(allSlots).map(([key, slot]) => {
    const isActive = key === currentSessionKey && visible;
    return (
      <div key={key} style={{ display: isActive ? "contents" : "none" }}>
        <ChatPanel agentId={slot.agentId} sessionId={slot.sessionId} />
      </div>
    );
  });

  // 监听 chat:stats 事件，派生 changedFiles
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setEntries(detail.entries ?? []);
    };
    window.addEventListener("chat:stats", handler);
    return () => window.removeEventListener("chat:stats", handler);
  }, []);

  // 记录用户是否已手动操作面板（展开/折叠/拖拽），
  // 防止 layout 重新计算时 panelRef 短暂重置导致意外 collapse
  const userInteractedRef = useRef(false);

  // artifacts:select-site → 展开右侧面板
  useEffect(() => {
    const handler = () => {
      if (artifactsCollapsedRef.current) {
        userInteractedRef.current = true;
        artifactsPanelRef.current?.expand();
      }
    };
    window.addEventListener("artifacts:select-site", handler);
    return () => window.removeEventListener("artifacts:select-site", handler);
  }, [artifactsPanelRef.current?.expand]);

  // artifacts:preview-file → 展开右侧面板
  useEffect(() => {
    const handler = () => {
      if (artifactsCollapsedRef.current) {
        userInteractedRef.current = true;
        artifactsPanelRef.current?.expand();
      }
    };
    window.addEventListener("artifacts:preview-file", handler);
    return () => window.removeEventListener("artifacts:preview-file", handler);
  }, [artifactsPanelRef.current?.expand]);

  // ResizablePanel onResize 同步折叠状态
  const handleArtifactsResize = useCallback(() => {
    const panel = artifactsPanelRef.current;
    if (!panel) return;
    const collapsed = panel.isCollapsed();
    if (collapsed !== artifactsCollapsedRef.current) {
      artifactsCollapsedRef.current = collapsed;
      setArtifactsCollapsed(collapsed);
      // 用户拖拽分隔条后标记为已交互，阻止后续意外 collapse
      if (!collapsed) userInteractedRef.current = true;
    }
  }, [artifactsPanelRef]);

  // mount 时默认折叠右侧面板，仅首次挂载执行；
  // ref 重置导致的二次触发会被 userInteractedRef 拦截
  useEffect(() => {
    const panel = artifactsPanelRef.current;
    if (!panel || userInteractedRef.current) return;
    // 延迟到下一帧执行，避免与 ResizablePanelGroup 的 layout 计算冲突
    const frame = requestAnimationFrame(() => {
      panel.collapse();
    });
    return () => cancelAnimationFrame(frame);
  }, [artifactsPanelRef.current?.collapse, artifactsPanelRef.current]);

  // 窄屏自动折叠 — 仅在用户未手动展开时生效
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches && !userInteractedRef.current) {
        artifactsPanelRef.current?.collapse();
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [artifactsPanelRef.current?.collapse]);

  const toggleArtifacts = useCallback(() => {
    const panel = artifactsPanelRef.current;
    if (!panel) return;
    userInteractedRef.current = true;
    panel.isCollapsed() ? panel.expand() : panel.collapse();
  }, [artifactsPanelRef]);

  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        </div>
      }
    >
      <div className="agent-panel-content" style={{ display: visible ? undefined : "none" }}>
        <ResizablePanelGroup orientation="horizontal" className="agent-panel-resizable">
          <ResizablePanel defaultSize="60%" minSize="30%">
            <div className="agent-chat-area">{chatPanels}</div>
          </ResizablePanel>

          <ResizableHandle>
            <button
              type="button"
              className={cn("agent-artifacts-expand-btn", !artifactsCollapsed && "open")}
              onClick={toggleArtifacts}
              title={artifactsCollapsed ? t("showArtifacts") : t("hideArtifacts")}
            >
              {artifactsCollapsed ? (
                <PanelRight className="h-3.5 w-3.5" />
              ) : (
                <PanelRight className="h-3.5 w-3.5 -scale-x-100" />
              )}
            </button>
          </ResizableHandle>

          <ResizablePanel
            panelRef={artifactsPanelRef}
            defaultSize="40%"
            minSize="20%"
            maxSize="70%"
            collapsible
            collapsedSize="0%"
            onResize={handleArtifactsResize}
          >
            <ArtifactsPanel
              key={`${agentId}-${restartKey}`}
              envId={agentId}
              agentConfigId={agentConfigId}
              changedFiles={changedFiles}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </Suspense>
  );
}
