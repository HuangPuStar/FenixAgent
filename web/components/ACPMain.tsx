import { MessageSquare, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { retryWithBackoff } from "@/src/lib/retry";
import type { ACPClient } from "../src/acp/client";
import type { AgentSessionInfo } from "../src/acp/types";
import { cn } from "../src/lib/utils";
import { ChatInterface, type ChatInterfaceHandle } from "./ChatInterface";
import { ChatHeader } from "./chat/ChatHeader";
import { groupByRecency } from "./chat/session-grouping";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";

interface ACPMainProps {
  client: ACPClient;
  agentId?: string;
  initialCwd?: string;
  readonly?: boolean;
  hideSidebar?: boolean;
  rcsSessionId?: string;
  scenePrompt?: string;
  onPromptComplete?: () => void;
}

/**
 * Main container — Anthropic sidebar + chat layout.
 * Sidebar: sectioned by recency, orange active state, warm raised bg.
 */
export function ACPMain({
  client,
  agentId,
  readonly,
  hideSidebar,
  rcsSessionId,
  scenePrompt,
  onPromptComplete,
}: ACPMainProps) {
  const { t } = useTranslation("components");
  // 默认 false：进入 chat 子页面时左侧会话面板默认收起，需通过 ChatHeader 上的
  // PanelLeft 切换按钮主动打开；与 Anthropic / ChatGPT 等默认隐藏历史会话的体验对齐
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [initialActiveSessionId, setInitialActiveSessionId] = useState<string | null>(null);
  const chatRef = useRef<ChatInterfaceHandle>(null);
  const bootstrappedRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: client 变更时需重置 bootstrap 状态，否则新连接不会加载会话
  useEffect(() => {
    bootstrappedRef.current = false;
  }, [client]);

  // Handle session selection
  // 历史会话切换由 ChatHeader popover 和 SidebarSessionList 共用：
  // 调用 client 的 loadSession/resumeSession 后必须同步更新 initialActiveSessionId，
  // 否则 ChatHeader 顶部展示的会话标题与 SidebarSessionList 的高亮会停留在旧值。
  // （ChatInterface 内部的 activeSessionId 由 client.sessionLoaded handler 单独维护，
  // 这里只是把当前选中 id 暴露给 header / sidebar。）
  const handleSelectSession = useCallback(
    async (session: AgentSessionInfo) => {
      try {
        if (client.supportsLoadSession) {
          await client.loadSession({ sessionId: session.sessionId, cwd: session.cwd });
        } else if (client.supportsResumeSession) {
          await client.resumeSession({ sessionId: session.sessionId, cwd: session.cwd });
        } else {
          throw new Error("Loading or resuming sessions is not supported by this agent.");
        }
        // 立即同步激活会话 id，让 ChatHeader 标题与 SidebarSessionList 高亮跟随切换
        setInitialActiveSessionId(session.sessionId);
      } catch (error) {
        console.error("Failed to load/resume session:", error);
      }
    },
    [client],
  );

  // Bootstrap: load latest session or create new one.
  useEffect(() => {
    if (client.getState() !== "connected") return;
    if (bootstrappedRef.current) return;

    let cancelled = false;

    const bootstrap = async () => {
      try {
        // Wait for capabilities with exponential backoff
        await retryWithBackoff(
          async () => {
            if (cancelled) return;
            if (!client.supportsSessionList) {
              throw new Error("Capabilities not ready");
            }
          },
          { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 8000 },
        );
        if (cancelled) return;

        bootstrappedRef.current = true;
        const response = await client.listSessions();
        if (cancelled) return;

        const sessions = Array.isArray(response?.sessions) ? response.sessions : [];
        const latest = [...sessions].sort((a, b) => {
          const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          return timeB - timeA;
        })[0];

        if (latest) {
          setInitialActiveSessionId(latest.sessionId);
          await handleSelectSession(latest);
          return;
        }

        console.log("[ACPMain] No existing sessions found, creating new session");
        chatRef.current?.newSession();
      } catch (error) {
        // Capabilities never became available — create session directly
        if (!client.supportsSessionList && !cancelled) {
          console.log("[ACPMain] Session list not supported, creating new session directly");
          bootstrappedRef.current = true;
          chatRef.current?.newSession();
          return;
        }
        bootstrappedRef.current = false;
        console.warn("[ACPMain] Failed to bootstrap latest session:", error);
      }
    };

    bootstrap();

    return () => {
      cancelled = true;
    };
  }, [client, handleSelectSession]);

  return (
    // root 加 p-3 gap-3：让顶部 ChatHeader 浮动卡片与下方内容统一外边距，
    // 形成上下两个玻璃磨砂卡片悬浮在子页面背景上的视觉效果
    <div className="flex h-full w-full flex-col gap-3 p-3">
      {/* 顶部 ChatHeader — 跨整个宽度，承担会话面板开关 + 当前会话标题 + popover 历史会话列表 */}
      {/* readonly 模式下整体隐藏，保持分享视图简洁 */}
      {!readonly && (
        <ChatHeader
          client={client}
          activeSessionId={initialActiveSessionId}
          onSelectSession={handleSelectSession}
          onNewSession={() => chatRef.current?.newSession()}
          // hideSidebar 场景（嵌入到外部）下不提供切换按钮，避免出现"开关一个永远不显示的面板"
          onToggleSidebar={!hideSidebar ? () => setSidebarOpen((v) => !v) : undefined}
          sidebarOpen={sidebarOpen}
        />
      )}

      {/* 主体：横向 sidebar + chat */}
      <div className="flex flex-1 min-h-0 gap-3">
        {/* 左侧 sidebar — 仅在 sidebarOpen 且非 readonly/hideSidebar 时渲染，关闭时完全不占位 */}
        {!readonly && !hideSidebar && sidebarOpen && (
          <div
            className="hidden md:flex flex-col bg-surface-1 transition-all duration-200 flex-shrink-0 w-64 rounded-xl"
            style={{ boxShadow: "var(--shadow-card)" }}
          >
            {/* 头部：标题 + 新会话按钮（PanelLeft 切换按钮在 ChatHeader 中） */}
            <div className="flex items-center justify-between px-3 py-4">
              <span className="text-xs font-display font-semibold text-text-muted uppercase tracking-widest px-1">
                {t("acpMain.sessions")}
              </span>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => chatRef.current?.newSession()}
                className="h-7 w-7 text-text-muted hover:text-brand hover:bg-brand/10"
                title={t("acpMain.newSession")}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            {/* 会话列表 */}
            <ScrollArea className="flex-1">
              <SidebarSessionList
                client={client}
                initialActiveSessionId={initialActiveSessionId}
                onSelectSession={handleSelectSession}
              />
            </ScrollArea>
          </div>
        )}

        {/* 聊天区域 */}
        <div className="flex-1 flex flex-col min-w-0">
          <ChatInterface
            ref={chatRef}
            client={client}
            agentId={agentId}
            readonly={readonly}
            hideContextPanel={true}
            rcsSessionId={rcsSessionId}
            scenePrompt={scenePrompt}
            onSessionCreated={(sessionId) => setInitialActiveSessionId(sessionId)}
            onPromptComplete={onPromptComplete}
          />
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// 侧边栏会话列表 — Anthropic 分段式（今天/昨天/更早）
// =============================================================================

function SidebarSessionList({
  client,
  initialActiveSessionId,
  onSelectSession,
}: {
  client: ACPClient;
  initialActiveSessionId: string | null;
  onSelectSession: (session: AgentSessionInfo) => void;
}) {
  const { t } = useTranslation("components");
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (initialActiveSessionId) {
      setActiveId(initialActiveSessionId);
    }
  }, [initialActiveSessionId]);

  const loadSessions = useCallback(async () => {
    if (!client.supportsSessionList) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await client.listSessions();
      setSessions(Array.isArray(response?.sessions) ? response.sessions : []);
    } catch (err) {
      console.warn("[SidebarSessionList] Failed to load:", err);
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (client.getState() === "connected") {
      loadSessions();
    }
  }, [client, loadSessions]);

  // When capabilities arrive via ACP event, load sessions
  useEffect(() => {
    const onCaps = () => {
      if (client.supportsSessionList) {
        loadSessions();
      }
    };
    client.state.on("capabilitiesChange", onCaps);
    return () => client.state.off("capabilitiesChange", onCaps);
  }, [client, loadSessions]);

  useEffect(() => {
    const handler = (state: string) => {
      if (state === "connected") {
        retryWithBackoff(() => loadSessions(), {
          maxAttempts: 2,
          baseDelayMs: 300,
          maxDelayMs: 1000,
        }).catch(() => {});
      }
    };
    client.setConnectionStateHandler(handler);
    return () => client.removeConnectionStateHandler(handler);
  }, [client, loadSessions]);

  useEffect(() => {
    const interval = setInterval(loadSessions, 30_000);
    return () => clearInterval(interval);
  }, [loadSessions]);

  const sorted = useMemo(
    () =>
      [...sessions].sort((a, b) => {
        const dateA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
        const dateB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
        return dateB - dateA;
      }),
    [sessions],
  );

  if (loading && sessions.length === 0) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="h-5 w-5 rounded-full border-2 border-brand border-t-transparent animate-spin" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-1">
        <span className="text-xs text-text-muted font-display">{t("acpMain.noSessions")}</span>
        <span className="text-[10px] text-text-muted">{t("acpMain.clickToCreate")}</span>
      </div>
    );
  }

  // 按日期分组（groupByRecency 内部已做 updatedAt 降序排序，sorted 变量保留供后续扩展使用）
  const groups = groupByRecency(sorted, {
    today: t("acpMain.today"),
    yesterday: t("acpMain.yesterday"),
    earlier: t("acpMain.earlier"),
  });

  return (
    <nav className="py-1" aria-label={t("acpMain.historySessions")}>
      {groups.map((group, gi) => (
        <div key={group.label}>
          {gi > 0 && <div className="mx-3 my-2 border-t border-border/40" />}
          <div className="px-4 py-2">
            <span className="text-[10px] font-display font-semibold uppercase tracking-widest text-text-muted/70">
              {group.label}
            </span>
          </div>
          {group.sessions.map((session) => (
            <Button
              key={session.sessionId}
              variant="ghost"
              onClick={() => {
                setActiveId(session.sessionId);
                onSelectSession(session);
              }}
              className={cn(
                "w-full flex items-center gap-2.5 px-4 py-2 text-left justify-start rounded-none",
                session.sessionId === activeId
                  ? "bg-brand/8 text-text-primary hover:bg-brand/8"
                  : "text-text-secondary hover:bg-surface-2/60 hover:text-text-primary",
              )}
              title={session.title || session.sessionId}
            >
              <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 opacity-50" />
              <span className="text-[13px] font-display truncate leading-snug">
                {session.title?.trim() ? session.title : t("acpMain.newSession")}
              </span>
            </Button>
          ))}
        </div>
      ))}
    </nav>
  );
}

// =============================================================================
// 按日期分组：今天 / 昨天 / 更早
// 分组逻辑已抽到 ./chat/session-grouping，ChatHeader 与 SidebarSessionList 共享
// =============================================================================
