/**
 * Chat 工作区里右侧工件面板的宿主装配（`.agent-chat-workspace` 与它的 `<aside class="artifacts-shell">`）。
 *
 * 为什么这块壳逻辑单独一个文件、且留在宿主：它是宿主页面布局与宿主偏好的装配，不是聊天域实现——
 * - 面板本体 `./artifacts/ArtifactsPanel` 是宿主页面的跨包装配层（包不得反向引用 apps）；
 * - 偏好键（`fenix:artifacts-width` / `fenix:artifacts-layout`）与两个 window 事件
 *   （`artifacts:select-site` / `artifacts:preview-file`）都是宿主页面壳的契约；
 * - `modulesConfig` 是分享页（`@fenix/resource-prod-view/web`）注入的面板开关。
 * 它此前与聊天槽位同住在 `ChatArea.tsx`：2026-09-25 随台账 `ce-standards-todo.md` D1 把聊天域实现迁入
 * `@fenix/agent-runtime/web` 后，`ChatArea.tsx` 只剩「薄壳」，这块与本文件职责不同的布局装配随之拆出。
 * 2026-09-28 归位：面板那一簇（`ArtifactsPanel` / `TopModeTabs` / `artifacts-dialogs`）从
 * `apps/web/src/shell/artifacts/` 迁到同目录 `./artifacts/`——它是**跨资源包的宿主装配**（同时 import
 * agent-config / machine / prod-view / task 四家 UI），没有任何单一包能承载（进组件库违反该包零依赖，
 * 进任一资源包违反依赖矩阵），因此仍留宿主，只是跟着唯一的生产消费者（本文件）落进页面目录，与 §1
 * 「`pages/` 宿主专有页面」的分工一致。同目录的伴随样式表 `artifacts-workspace.css` 已于同日退役：
 * 几何撤回本文件的 `className`（30×48 的展开按钮与 `-5px` / 10px 的拖拽命中区），伪元素与
 * `[data-layout]` 属性选择器等残余规则收进 `src/index.css` 的「宿主壳残余样式」段。
 *
 * 与聊天槽位的边界：本组件只提供工作区容器与右侧面板，聊天区（keep-alive 槽位）由调用方作为 children 传入。
 */

import { envApi } from "@fenix/agent-runtime/web/api/environments";
import type { ProdViewModulesConfig } from "@fenix/resource-prod-view/web";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useChangedFilesFromStats } from "@fenix/web-runtime/hooks/use-changed-files-stats";
import {
  ARTIFACTS_PREVIEW_FILE_EVENT,
  getArtifactsPreviewFileDetail,
} from "@fenix/web-runtime/lib/artifacts-preview-events";
import { useRequest } from "ahooks";
import { PanelRight } from "lucide-react";
import {
  type CSSProperties,
  lazy,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";

const ArtifactsPanel = lazy(() => import("./artifacts/ArtifactsPanel").then((m) => ({ default: m.ArtifactsPanel })));

interface ChatWorkspaceArtifactsProps {
  /** 当前活跃 Environment；为 null 时不拉取实例详情。 */
  agentId: string | null;
  /** 实例重启版本：重启后 ArtifactsPanel 必须重建（挂在它的 `key` 上）。 */
  agentRestartVersion: number;
  /** ProdView 模块配置，控制右侧附加面板的显示/隐藏 */
  modulesConfig?: ProdViewModulesConfig;
  /** 聊天区（keep-alive 槽位）。 */
  children: ReactNode;
}

type ArtifactsLayoutMode = "floating" | "docked";

const ARTIFACTS_MIN_WIDTH = 356;
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
 * 工件面板容器：折叠、浮动/停靠切换、拖拽改宽与偏好持久化。
 *
 * 首次访问即从 `localStorage` 读取偏好（`useState(readArtifactsWidth)` 语义与迁移前逐字一致）；
 * 存储不可用（隐私模式）时降级为默认值，不影响布局可用性。
 */
export function ChatWorkspaceArtifacts({
  agentId,
  agentRestartVersion,
  modulesConfig,
  children,
}: ChatWorkspaceArtifactsProps) {
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
  // 按 agentName 过滤：跨 agent 的 keep-alive 槽位里，后台隐藏槽位（延迟节流 flush / 重连收流中）
  // 派发的 chat:stats 不得污染当前 agent 的面板。
  const changedFiles = useChangedFilesFromStats(agentId);

  // ProdView 模块配置：若所有附加面板都被禁用，则不渲染右侧面板区域
  const hasPanelModules = useMemo(() => {
    if (!modulesConfig) return true;
    const panelKeys = ["filesPanel", "sitesPanel", "tasksPanel", "viewsPanel"] as const;
    return panelKeys.some((key) => modulesConfig[key]?.enabled !== false);
  }, [modulesConfig]);

  // 展开右侧面板：`artifacts:select-site` 与 `artifacts:preview-file` 两个事件共用。
  // ref 与 state 必须一起改——只 setState 的话，同一轮里读 ref 的分支仍会看到「已折叠」。
  const expandArtifacts = useCallback(() => {
    if (!artifactsCollapsedRef.current) return;
    artifactsCollapsedRef.current = false;
    setArtifactsCollapsed(false);
  }, []);

  // artifacts:select-site → 展开右侧面板
  useEffect(() => {
    window.addEventListener("artifacts:select-site", expandArtifacts);
    return () => window.removeEventListener("artifacts:select-site", expandArtifacts);
  }, [expandArtifacts]);

  // artifacts:preview-file → 展开右侧面板
  useEffect(() => {
    const handler = (event: Event) => {
      if (!getArtifactsPreviewFileDetail(event, agentId)) return;
      expandArtifacts();
    };
    window.addEventListener(ARTIFACTS_PREVIEW_FILE_EVENT, handler);
    return () => window.removeEventListener(ARTIFACTS_PREVIEW_FILE_EVENT, handler);
  }, [agentId, expandArtifacts]);

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
    <div
      ref={workspaceRef}
      className="agent-chat-workspace relative flex h-full w-full flex-1 min-w-0 min-h-0 gap-0 overflow-hidden bg-white"
      style={workspaceStyle}
    >
      {children}
      {hasPanelModules && (
        <>
          {/* 展开按钮：尺寸 30×48（`w-7.5` / `h-12`）、左圆角 8px（`rounded-l`，`--radius` = 8px）与图标
              16px（`size-4`）都在 `className` 里；带色投影（多段 rgba，无同值令牌）留在 `src/index.css`
              的「宿主壳残余样式」段。 */}
          {artifactsCollapsed && (
            <button
              type="button"
              className="artifacts-open-button absolute top-1/2 right-0 z-25 grid h-12 w-7.5 -translate-y-1/2 place-items-center rounded-l border border-border-subtle border-r-0 bg-surface-1 text-text-muted hover:text-brand focus-visible:text-brand"
              onClick={toggleArtifacts}
              title={t("showArtifacts")}
              aria-label={t("showArtifacts")}
            >
              <PanelRight className="size-4" aria-hidden />
            </button>
          )}
          {/* 折叠态走 `hidden` 工具类（原为同目录 CSS 的 `.is-collapsed { display: none }`）：显示开关只
              需一个扁平工具类，留在 CSS 里属伪深层。 */}
          <aside
            // 末尾留空格再拼 `${…}`：Tailwind 的扫描器按原文取候选词，紧贴的 `min-w-80${` 会被当成一个
            // 非法词丢掉（`min-w-80` 不再生成任何声明，且静态检查与构建期都不报错）。
            className={`artifacts-shell relative z-30 min-h-0 shrink-0 min-w-80 ${artifactsCollapsed ? "hidden" : ""}`}
            data-layout={effectiveLayout}
            style={{
              width: artifactsWidth,
              maxWidth: `${ARTIFACTS_MAX_WIDTH_RATIO * 100}%`,
              flexBasis: effectiveLayout === "docked" ? artifactsWidth : undefined,
            }}
            aria-label={t("showArtifacts")}
          >
            {/* 手柄的命中区：10px 宽（`w-2.5`）、`left: -5px`（`-left-1.25`）跨面板边界；指示线是伪元素，
                留在 `src/index.css` 的「宿主壳残余样式」段。 */}
            <div
              className="artifacts-shell__resizer absolute inset-y-0 -left-1.25 w-2.5 z-40 cursor-col-resize outline-none"
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
              key={`${agentId}-${agentRestartVersion}`}
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
  );
}
