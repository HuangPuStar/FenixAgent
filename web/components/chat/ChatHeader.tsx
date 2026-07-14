import { ChevronDown, Loader2, MessageSquare, Pin, Plus, RefreshCw, Search } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { retryWithBackoff } from "@/src/lib/retry";
import type { ACPClient } from "../../src/acp/client";
import type { AgentSessionInfo } from "../../src/acp/types";
import { cn } from "../../src/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { groupByRecency } from "./session-grouping";

interface ChatHeaderProps {
  /** ACP 客户端实例，用于拉取会话列表和监听能力/连接变化 */
  client: ACPClient;
  /** 当前激活的会话 ID（与 ChatInterface 内 activeSessionId 对齐） */
  activeSessionId: string | null;
  /** 在 popover 中选中某个历史会话时回调，由父组件负责调用 loadSession/resumeSession */
  onSelectSession: (session: AgentSessionInfo) => void | Promise<void>;
  /** 新建会话回调，由父组件调用 newSession 流程 */
  onNewSession?: () => void;
  /** 切换左侧会话面板开/关。提供时显示最左侧的 PanelLeft 切换按钮（readonly / hideSidebar 场景不传） */
  onToggleSidebar?: () => void;
  /** 当前会话面板是否展开（true 显示 PanelLeftClose，false 显示 PanelLeft） */
  sidebarOpen?: boolean;
  /** 手动控制弹窗打开状态（从外部控制弹窗打开） */
  forceOpen?: boolean;
  /** 弹窗状态变化回调 */
  onPopoverChange?: (open: boolean) => void;
  className?: string;
}

/**
 * ChatHeader —— 顶部会话标题栏。
 *
 * 横跨整个 chat 子页面顶部，最左侧（可选）为会话面板切换按钮，紧接着是当前会话标题按钮，
 * 点击标题按钮触发 popover，展开按"今天/昨天/更早"分组的历史会话列表。与 ACPMain 左侧
 * SidebarSessionList 共享同一份分组逻辑，但视觉风格改为 popover 形式以适配无侧边栏场景。
 *
 * 数据自包含：组件内部独立监听 capabilitiesChange / connectionState / 30s 轮询，
 * 避免与 ChatInterface 的会话状态耦合。
 */
export function ChatHeader({
  client,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onToggleSidebar,
  sidebarOpen = false,
  forceOpen = false,
  onPopoverChange,
  className,
}: ChatHeaderProps) {
  const { t } = useTranslation("components");
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // 钉子状态与侧边栏状态同步：侧边栏打开时即为钉住状态
  const pinned = sidebarOpen;

  // 会话列表加载：supportsSessionList 未就绪时静默退出，避免 capabilities 还未到位时报错
  const loadSessions = useCallback(async () => {
    if (!client.supportsSessionList) return;
    setLoading(true);
    try {
      const response = await client.listSessions();
      setSessions(Array.isArray(response?.sessions) ? response.sessions : []);
    } catch (err) {
      // 拉取失败保留旧列表，仅记录日志；上层会通过 connectionState 重连后重试
      console.warn("[ChatHeader] Failed to load sessions:", err);
    } finally {
      setLoading(false);
    }
  }, [client]);

  // 初次连接 / capabilities 就绪后立即加载
  useEffect(() => {
    if (client.getState() === "connected") {
      loadSessions();
    }
  }, [client, loadSessions]);

  // capabilitiesChange：ACP 协议能力可能在连接后才广播，需在此触发首次加载
  useEffect(() => {
    const onCaps = () => {
      if (client.supportsSessionList) {
        loadSessions();
      }
    };
    client.state.on("capabilitiesChange", onCaps);
    return () => client.state.off("capabilitiesChange", onCaps);
  }, [client, loadSessions]);

  // 重连后自动重试加载（带退避，防止反复失败）
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

  // 周期性刷新，让 popover 内的 updatedAt / 新会话保持新鲜
  useEffect(() => {
    const interval = setInterval(loadSessions, 30_000);
    return () => clearInterval(interval);
  }, [loadSessions]);

  // popover 打开时主动刷新一次，避免停留在 30s 间隔之外的数据
  useEffect(() => {
    if (open) {
      loadSessions();
    }
  }, [open, loadSessions]);

  // 外部控制弹窗打开
  useEffect(() => {
    if (forceOpen) {
      setOpen(true);
    }
  }, [forceOpen]);

  // 当前会话标题：从 sessions 中按 activeSessionId 命中；缺失则用默认文案兜底
  const activeSession = useMemo(
    () => sessions.find((s) => s.sessionId === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );
  const activeTitle = activeSession?.title?.trim() || t("chatHeader.newSession");

  // 搜索过滤 + 按"今天/昨天/更早"分组（共享 SidebarSessionList 同款逻辑）
  const filteredSessions = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return sessions;
    return sessions.filter((s) => s.title?.toLowerCase().includes(query) || s.sessionId.toLowerCase().includes(query));
  }, [sessions, searchQuery]);

  const groups = useMemo(
    () =>
      groupByRecency(filteredSessions, {
        today: t("acpMain.today"),
        yesterday: t("acpMain.yesterday"),
        earlier: t("acpMain.earlier"),
      }),
    [filteredSessions, t],
  );

  // 选中会话：交由父组件执行 loadSession/resumeSession，关闭 popover
  const handleSelect = useCallback(
    async (session: AgentSessionInfo) => {
      try {
        await onSelectSession(session);
        setOpen(false);
        setSearchQuery("");
      } catch (err) {
        console.error("[ChatHeader] Failed to select session:", err);
      }
    },
    [onSelectSession],
  );

  const handleNewSession = useCallback(() => {
    setOpen(false);
    setSearchQuery("");
    onNewSession?.();
  }, [onNewSession]);

  // 在 popover 内按 Esc 时同时清空搜索，恢复全量列表
  const handleSearchKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape" && searchQuery) {
        e.stopPropagation();
        setSearchQuery("");
      }
    },
    [searchQuery],
  );

  // 钉子按钮处理逻辑
  const handlePinToggle = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (pinned) {
        // 已钉住状态：收起侧边栏（相当于解除钉住）
        onToggleSidebar?.();
      } else {
        // 未钉住状态：展开侧边栏（相当于钉住），然后关闭弹窗
        if (!sidebarOpen) {
          onToggleSidebar?.();
        }
        setOpen(false); // 关闭弹窗
      }
    },
    [pinned, sidebarOpen, onToggleSidebar],
  );

  return (
    <div
      className={cn(
        // chat-header-card：玻璃磨砂浮动卡片（圆角 + 阴影），替代原 border-b 横条；
        // 外层 ACPMain 的 padding 负责让卡片悬浮于子页面顶部
        "chat-header-card flex items-center gap-2 h-11 px-3 flex-shrink-0",
        className,
      )}
    >
      {/* 会话切换 Popover（整合历史对话和面板控制） */}
      <Popover
        open={open}
        onOpenChange={(newOpen) => {
          setOpen(newOpen);
          onPopoverChange?.(newOpen);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5 px-2 text-text-primary hover:bg-surface-2/60 max-w-[70%]"
            // 顶住布局右侧不被截断：title 提供原生 tooltip 兜底
            title={activeTitle}
          >
            <MessageSquare className="h-3.5 w-3.5 text-text-muted flex-shrink-0" />
            <span className="text-[13px] font-display truncate min-w-0">{activeTitle}</span>
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 text-text-muted flex-shrink-0 transition-transform duration-150",
                open && "rotate-180",
              )}
            />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          // 触发器下边缘 + 4px 间距，宽度足够展示分组与时间戳
          sideOffset={4}
          className="w-80 p-0 overflow-hidden"
        >
          <div className="flex flex-col max-h-[60vh]">
            {/* 顶部：搜索 + 刷新 + 新建 + 钉子按钮 */}
            <div className="flex items-center gap-1.5 p-2 border-b border-border/40">
              <Search className="h-3.5 w-3.5 text-text-muted flex-shrink-0 ml-1" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder={t("chatHeader.searchPlaceholder")}
                className="h-7 border-0 focus-visible:ring-0 shadow-none text-xs"
              />
              {loading ? (
                <Loader2 className="h-3.5 w-3.5 text-text-muted animate-spin flex-shrink-0" />
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={loadSessions}
                  className="h-7 w-7 text-text-muted hover:text-text-primary flex-shrink-0"
                  title={t("chatHeader.refresh")}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              )}
              {onNewSession && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleNewSession}
                  className="h-7 w-7 text-text-muted hover:text-brand hover:bg-brand/10 flex-shrink-0"
                  title={t("acpMain.newSession")}
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              )}
              {/* 钉子按钮：钉住/解除钉住左侧栏 */}
              {onToggleSidebar && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handlePinToggle}
                  className={cn(
                    "h-7 w-7 flex-shrink-0",
                    pinned
                      ? "text-brand bg-brand/10 hover:bg-brand/20"
                      : "text-text-muted hover:text-text-primary hover:bg-surface-2/60",
                  )}
                  title={t(pinned ? "chatHeader.unpinSessions" : "chatHeader.pinSessions")}
                  aria-label={t(pinned ? "chatHeader.unpinSessions" : "chatHeader.pinSessions")}
                  aria-pressed={pinned}
                >
                  <Pin className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>

            {/* 会话列表 */}
            <ScrollArea className="flex-1 min-h-0">
              {sessions.length === 0 && !loading && (
                <div className="flex flex-col items-center justify-center py-8 gap-1">
                  <span className="text-xs text-text-muted font-display">{t("acpMain.noSessions")}</span>
                  <span className="text-[10px] text-text-muted">{t("acpMain.clickToCreate")}</span>
                </div>
              )}

              {filteredSessions.length === 0 && searchQuery && (
                <div className="flex flex-col items-center justify-center py-8">
                  <span className="text-xs text-text-muted">{t("chatHeader.noResults")}</span>
                </div>
              )}

              {groups.map((group, gi) => (
                <div key={group.label}>
                  {gi > 0 && <div className="mx-3 my-1.5 border-t border-border/40" />}
                  <div className="px-4 pt-2 pb-1">
                    <span className="text-[10px] font-display font-semibold uppercase tracking-widest text-text-muted/70">
                      {group.label}
                    </span>
                  </div>
                  {group.sessions.map((session) => {
                    const isActive = session.sessionId === activeSessionId;
                    return (
                      <Button
                        key={session.sessionId}
                        variant="ghost"
                        onClick={() => handleSelect(session)}
                        className={cn(
                          "w-full flex items-center gap-2 px-4 py-2 text-left justify-start rounded-none",
                          isActive
                            ? "bg-brand/8 text-text-primary hover:bg-brand/8"
                            : "text-text-secondary hover:bg-surface-2/60 hover:text-text-primary",
                        )}
                        title={session.title || session.sessionId}
                      >
                        <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 opacity-50" />
                        <span className="text-[13px] font-display truncate leading-snug flex-1 min-w-0">
                          {session.title?.trim() ? session.title : t("acpMain.newSession")}
                        </span>
                        {isActive && <span className="h-1.5 w-1.5 rounded-full bg-brand flex-shrink-0" aria-hidden />}
                      </Button>
                    );
                  })}
                </div>
              ))}
            </ScrollArea>
          </div>
        </PopoverContent>
      </Popover>

      {/* 右侧占位：留给后续模型/连接状态展示，保持 header 布局稳定 */}
      <div className="flex-1" />
    </div>
  );
}
