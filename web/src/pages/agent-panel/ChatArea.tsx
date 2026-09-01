import { useRequest } from "ahooks";
import { PanelRight } from "lucide-react";
import {
  type CSSProperties,
  lazy,
  type PointerEvent as ReactPointerEvent,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { envApi } from "@/src/api/environments";
import type { ProdViewModulesConfig } from "@/src/api/prod-views";
import { unwrap } from "@/src/api/request";
import { useChangedFilesFromStats } from "@/src/hooks/use-changed-files-stats";
import { ChatPageVisibleContext } from "@/src/hooks/usePageVisible";
import { NS } from "@/src/i18n";
import "./artifacts-workspace.css";
import "./chat-layout.css";

const ChatPanel = lazy(() => import("./ChatPanel").then((m) => ({ default: m.ChatPanel })));
const ArtifactsPanel = lazy(() => import("./ArtifactsPanel").then((m) => ({ default: m.ArtifactsPanel })));

interface ChatAreaProps {
  agentId: string | null;
  sessionId?: string | null;
  visible: boolean;
  /** ProdView 模块配置，控制右侧附加面板的显示/隐藏 */
  modulesConfig?: ProdViewModulesConfig;
}

interface SessionSlot {
  agentId: string;
  sessionId: string | null;
}

type ArtifactsLayoutMode = "floating" | "docked";

const ARTIFACTS_MIN_WIDTH = 320;
const ARTIFACTS_DEFAULT_WIDTH = 520;
const ARTIFACTS_MAX_WIDTH_RATIO = 0.75;
const COMPACT_LAYOUT_QUERY = "(max-width: 1050px)";

function readArtifactsWidth(): number {
  try {
    const saved = Number(localStorage.getItem("fenix:artifacts-width"));
    return Number.isFinite(saved) && saved >= ARTIFACTS_MIN_WIDTH ? saved : ARTIFACTS_DEFAULT_WIDTH;
  } catch {
    return ARTIFACTS_DEFAULT_WIDTH;
  }
}

function readArtifactsLayout(): ArtifactsLayoutMode {
  try {
    return localStorage.getItem("fenix:artifacts-layout") === "docked" ? "docked" : "floating";
  } catch {
    return "floating";
  }
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
export function ChatArea({ agentId, sessionId, visible, modulesConfig }: ChatAreaProps) {
  const { t } = useTranslation(NS.AGENT_PANEL);

  const artifactsCollapsedRef = useRef(true);
  const [artifactsCollapsed, setArtifactsCollapsed] = useState(true);
  const [artifactsLayout, setArtifactsLayout] = useState<ArtifactsLayoutMode>(readArtifactsLayout);
  const [artifactsWidth, setArtifactsWidth] = useState(readArtifactsWidth);
  const [compactLayout, setCompactLayout] = useState(() => window.matchMedia(COMPACT_LAYOUT_QUERY).matches);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const resizeStartRef = useRef<{ pointerId: number; clientX: number; width: number } | null>(null);

  // 加载 environment.agentConfigId，供 ArtifactsPanel 站点绑定等功能使用。
  // 无论是否有 sessionId 都需加载——有 session 时按 agentId 拉取。
  const { data: agentConfigId = null } = useRequest(
    async () => {
      if (!agentId) return null;
      const env = await unwrap(envApi.get({ id: agentId }));
      return env.agentConfigId ?? null;
    },
    {
      refreshDeps: [agentId],
      ready: !!agentId,
      onError: (err) => console.warn("[ChatArea] 加载 environment 详情失败", err),
    },
  );

  // changedFiles 由 ChatInterface 通过 chat:stats 摘要事件派发（已含 extractChangedFiles 的结果），
  // 此处只做投影存储，不再持有完整 entries 或二次全量派生。
  // 按 agentName 过滤：ChatArea 维护跨 agent 的 session keep-alive 槽位，
  // 后台隐藏槽位（延迟节流 flush / 重连收流中）派发的 chat:stats 不得污染当前 agent 的面板
  const changedFiles = useChangedFilesFromStats(agentId);
  // 当前 slot 会在清理缓存后立即回填，必须单独递增重连版本以重新获取新实例的 capabilities。
  const [agentRestartVersions, setAgentRestartVersions] = useState<Record<string, number>>({});
  const activeAgentRestartVersion = agentId ? (agentRestartVersions[agentId] ?? 0) : 0;

  // ProdView 模块配置：若所有附加面板都被禁用，则不渲染右侧面板区域
  const hasPanelModules = useMemo(() => {
    if (!modulesConfig) return true;
    const panelKeys = ["filesPanel", "sitesPanel", "tasksPanel", "viewsPanel"] as const;
    return panelKeys.some((key) => modulesConfig[key]?.enabled !== false);
  }, [modulesConfig]);

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
      const restartedEnvironmentId = detail?.envId;
      if (typeof restartedEnvironmentId !== "string" || restartedEnvironmentId !== agentId) return;

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
  }, [agentId]);

  // 合并 state 中的缓存 + 当前渲染中的 slot（首次访问时 effect 尚未触发，需要兜底）
  const allSlots = { ...sessionSlots };
  if (currentSessionKey && agentId) {
    allSlots[currentSessionKey] = { agentId, sessionId: sessionId ?? null };
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
          <ChatPanel agentId={slot.agentId} sessionId={slot.sessionId} />
        </div>
      </ChatPageVisibleContext.Provider>
    );
  });

  // artifacts:select-site → 展开右侧面板
  useEffect(() => {
    const handler = () => {
      if (artifactsCollapsedRef.current) {
        artifactsCollapsedRef.current = false;
        setArtifactsCollapsed(false);
      }
    };
    window.addEventListener("artifacts:select-site", handler);
    return () => window.removeEventListener("artifacts:select-site", handler);
  }, []);

  // artifacts:preview-file → 展开右侧面板
  useEffect(() => {
    const handler = () => {
      if (artifactsCollapsedRef.current) {
        artifactsCollapsedRef.current = false;
        setArtifactsCollapsed(false);
      }
    };
    window.addEventListener("artifacts:preview-file", handler);
    return () => window.removeEventListener("artifacts:preview-file", handler);
  }, []);

  // 小屏只允许浮动模式。模式选择被保留，回到大屏时恢复用户偏好。
  useEffect(() => {
    const mq = window.matchMedia(COMPACT_LAYOUT_QUERY);
    const handler = (event: MediaQueryListEvent) => setCompactLayout(event.matches);
    setCompactLayout(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const effectiveLayout: ArtifactsLayoutMode = compactLayout ? "floating" : artifactsLayout;
  const workspaceStyle: CSSProperties & { "--chat-floating-artifacts-width": string } = {
    "--chat-floating-artifacts-width":
      effectiveLayout === "floating" && !artifactsCollapsed ? `${artifactsWidth}px` : "0px",
  };

  const clampArtifactsWidth = useCallback(
    (width: number) => {
      const workspaceWidth = workspaceRef.current?.clientWidth ?? window.innerWidth;
      const viewportAllowance = effectiveLayout === "docked" ? workspaceWidth - 720 : workspaceWidth - 32;
      const maxWidth = Math.min(viewportAllowance, workspaceWidth * ARTIFACTS_MAX_WIDTH_RATIO);
      return Math.max(ARTIFACTS_MIN_WIDTH, Math.min(width, Math.max(ARTIFACTS_MIN_WIDTH, maxWidth)));
    },
    [effectiveLayout],
  );

  const updateArtifactsWidth = useCallback(
    (width: number) => {
      const next = clampArtifactsWidth(width);
      setArtifactsWidth(next);
      try {
        localStorage.setItem("fenix:artifacts-width", String(next));
      } catch {
        // Storage is an enhancement only; layout remains usable when it is unavailable.
      }
    },
    [clampArtifactsWidth],
  );

  const handleResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const start = resizeStartRef.current;
      if (!start || start.pointerId !== event.pointerId) return;
      updateArtifactsWidth(start.width + start.clientX - event.clientX);
    },
    [updateArtifactsWidth],
  );

  const stopResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current;
    if (start && event.currentTarget.hasPointerCapture(start.pointerId)) {
      event.currentTarget.releasePointerCapture(start.pointerId);
    }
    resizeStartRef.current = null;
  }, []);

  const setLayout = useCallback((layout: ArtifactsLayoutMode) => {
    setArtifactsLayout(layout);
    try {
      localStorage.setItem("fenix:artifacts-layout", layout);
    } catch {
      // Storage is an enhancement only; the selected mode still applies for this session.
    }
  }, []);

  const toggleArtifacts = useCallback(() => {
    setArtifactsCollapsed((collapsed) => {
      artifactsCollapsedRef.current = !collapsed;
      return !collapsed;
    });
  }, []);

  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        </div>
      }
    >
      <ChatPageVisibleContext.Provider value={visible}>
        <div
          className="agent-panel-content agent-panel-content--chat"
          style={{ display: visible ? undefined : "none" }}
        >
          <div
            ref={workspaceRef}
            className="agent-chat-workspace"
            data-artifacts-layout={effectiveLayout}
            style={workspaceStyle}
          >
            <div className="agent-chat-area">{chatPanels}</div>
            {hasPanelModules && (
              <>
                {artifactsCollapsed && (
                  <button
                    type="button"
                    className="artifacts-open-button"
                    onClick={toggleArtifacts}
                    title={t("showArtifacts")}
                    aria-label={t("showArtifacts")}
                  >
                    <PanelRight aria-hidden />
                  </button>
                )}
                <aside
                  className={`artifacts-shell${artifactsCollapsed ? " is-collapsed" : ""}`}
                  data-layout={effectiveLayout}
                  style={{
                    width: artifactsWidth,
                    maxWidth: `${ARTIFACTS_MAX_WIDTH_RATIO * 100}%`,
                    flexBasis: effectiveLayout === "docked" ? artifactsWidth : undefined,
                  }}
                  aria-label={t("showArtifacts")}
                >
                  <div
                    className="artifacts-shell__resizer"
                    role="separator"
                    tabIndex={0}
                    aria-orientation="vertical"
                    aria-label={t("resizeArtifacts")}
                    aria-valuemin={ARTIFACTS_MIN_WIDTH}
                    aria-valuemax={720}
                    aria-valuenow={Math.round(artifactsWidth)}
                    onPointerDown={(event) => {
                      resizeStartRef.current = {
                        pointerId: event.pointerId,
                        clientX: event.clientX,
                        width: artifactsWidth,
                      };
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={handleResizeMove}
                    onPointerUp={stopResize}
                    onPointerCancel={stopResize}
                    onKeyDown={(event) => {
                      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                      event.preventDefault();
                      updateArtifactsWidth(artifactsWidth + (event.key === "ArrowLeft" ? 16 : -16));
                    }}
                  />
                  <ArtifactsPanel
                    key={`${agentId}-${activeAgentRestartVersion}`}
                    envId={agentId}
                    agentConfigId={agentConfigId}
                    changedFiles={changedFiles}
                    modulesConfig={modulesConfig}
                    layoutMode={effectiveLayout}
                    canDock={!compactLayout}
                    onLayoutModeChange={setLayout}
                    onClose={toggleArtifacts}
                  />
                </aside>
              </>
            )}
          </div>
        </div>
      </ChatPageVisibleContext.Provider>
    </Suspense>
  );
}
