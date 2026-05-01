import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  apiFetchSession,
  apiSendControl,
  apiInterrupt,
} from "../api/client";
import type { Session, SessionEvent } from "../types";
import { isClosedSessionStatus, formatTime, cn } from "../lib/utils";
import { ArrowLeft, Info, Cpu, Hash, Wrench, Clock } from "lucide-react";
import { RCSChatAdapter } from "../lib/rcs-chat-adapter";
import type { ThreadEntry, PendingPermission } from "../lib/types";
import { TaskPanel } from "../components/TaskPanel";
import { ContextPanel } from "../../components/ContextPanel";
import {
  PermissionPromptView,
  AskUserPanelView,
  PlanPanelView,
} from "../components/PermissionViews";

// Unified chat components
import { ChatView } from "../../components/chat/ChatView";
import { ChatInput } from "../../components/chat/ChatInput";
import { TooltipProvider } from "../../components/ui/tooltip";

// ACP chat components
import { ACPClient, DisconnectRequestedError } from "../acp/client";
import { createRelayClient } from "../acp/relay-client";
import { ACPMain } from "../../components/ACPMain";

interface SessionDetailProps {
  sessionId: string;
  initialCwd?: string;
}

export function SessionDetail({ sessionId, initialCwd }: SessionDetailProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  const [entries, setEntries] = useState<ThreadEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([]);
  const [contextPanelOpen, setContextPanelOpen] = useState(true);
  const adapterRef = useRef<RCSChatAdapter | null>(null);

  // Create RCSChatAdapter
  const adapter = useMemo(
    () =>
      new RCSChatAdapter(sessionId, setEntries, {
        onStatusChange: (status) => {
          setSessionStatus(status);
        },
        onError: (err) => {
          console.error("[RCSChatAdapter] error:", err);
        },
        onPermissionRequest: (permission) => {
          setPendingPermissions((prev) => {
            if (prev.some((p) => p.requestId === permission.requestId)) return prev;
            return [...prev, permission];
          });
        },
      }),
    [sessionId],
  );

  useEffect(() => {
    adapterRef.current = adapter;
    return () => {
      adapter.disconnect();
    };
  }, [adapter]);

  // Load session data and initialize adapter
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setError("");

      try {
        const sess = await apiFetchSession(sessionId);
        if (cancelled) return;
        setSession(sess);
        setSessionStatus(sess.status);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load session");
        return;
      }

      try {
        await adapter.init();
      } catch (err) {
        console.warn("Failed to init adapter:", err);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [sessionId, adapter]);

  const closed = isClosedSessionStatus(sessionStatus);

  // Session stats computed from entries (declared before early returns to satisfy hooks rules)
  const stats = useMemo(() => {
    const toolCalls = entries.filter((e) => e.type === "tool_call").length;
    const userMessages = entries.filter((e) => e.type === "user_message");
    const totalChars = entries.reduce((sum, e) => {
      if (e.type === "assistant_message") {
        return sum + e.chunks.reduce((s, c) => s + (c.text?.length || 0), 0);
      }
      if (e.type === "user_message") {
        return sum + (e.content?.length || 0);
      }
      return sum;
    }, 0);
    // Rough token estimate: ~4 chars per token
    const estimatedTokens = Math.round(totalChars / 4);
    // Duration from entries
    const duration = session?.created_at ? Date.now() / 1000 - session.created_at : 0;
    const durationStr = duration > 3600
      ? `${Math.floor(duration / 3600)}h ${Math.floor((duration % 3600) / 60)}m`
      : duration > 60
        ? `${Math.floor(duration / 60)}m`
        : `${Math.round(duration)}s`;

    return { toolCalls, estimatedTokens, userMessages: userMessages.length, durationStr };
  }, [entries, session?.created_at]);

  // Send message via ChatInput
  const handleSubmit = useCallback(
    async (message: import("../../src/lib/types").ChatInputMessage) => {
      const text = message.text.trim();
      if (!text || closed) return;
      setIsLoading(true);
      try {
        await adapter.sendMessage(text, message.images);
      } catch (err) {
        console.error("Send failed:", err);
      }
    },
    [adapter, closed],
  );

  // Interrupt
  const handleInterrupt = useCallback(async () => {
    try {
      await adapter.interrupt();
    } catch (err) {
      console.error("Interrupt failed:", err);
    } finally {
      setIsLoading(false);
    }
  }, [adapter]);

  // Mark loading done when last assistant message stops streaming
  useEffect(() => {
    if (entries.length === 0) return;
    const last = entries[entries.length - 1];
    if (last?.type === "assistant_message" || last?.type === "tool_call") {
      // If the last entry is no longer a streaming tool, consider loading done
      if (last.type === "tool_call" && last.toolCall.status === "running") return;
      setIsLoading(false);
    }
  }, [entries]);

  // Permission actions
  const handleApprovePermission = useCallback(
    async (requestId: string) => {
      try {
        await adapter.respondPermission(requestId, true);
      } catch (err) {
        console.error("Failed to approve:", err);
      }
      setPendingPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
    },
    [adapter],
  );

  const handleRejectPermission = useCallback(
    async (requestId: string) => {
      try {
        await adapter.respondPermission(requestId, false);
      } catch (err) {
        console.error("Failed to reject:", err);
      }
      setPendingPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
    },
    [adapter],
  );

  const handleSubmitAnswers = useCallback(
    async (
      requestId: string,
      answers: Record<string, unknown>,
      questions: import("../types").Question[],
    ) => {
      try {
        await apiSendControl(sessionId, {
          type: "permission_response",
          approved: true,
          request_id: requestId,
          updated_input: { questions, answers },
        });
      } catch (err) {
        console.error("Failed to submit answers:", err);
      }
      setPendingPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
    },
    [sessionId],
  );

  const handleSubmitPlanResponse = useCallback(
    async (requestId: string, value: string, feedback?: string) => {
      try {
        if (value === "no") {
          await apiSendControl(sessionId, {
            type: "permission_response",
            approved: false,
            request_id: requestId,
            ...(feedback ? { message: feedback } : {}),
          });
        } else {
          const modeMap: Record<string, string> = {
            "yes-accept-edits": "acceptEdits",
            "yes-default": "default",
          };
          await apiSendControl(sessionId, {
            type: "permission_response",
            approved: true,
            request_id: requestId,
            updated_permissions: [
              { type: "setMode", mode: modeMap[value] || "default", destination: "session" },
            ],
          });
        }
      } catch (err) {
        console.error("Failed to submit plan response:", err);
      }
      setPendingPermissions((prev) => prev.filter((p) => p.requestId !== requestId));
    },
    [sessionId],
  );

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="text-status-error">{error}</p>
          <a href="/ctrl/" className="mt-4 inline-block text-brand hover:underline">
            &larr; Back to Dashboard
          </a>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-text-muted">Loading session...</div>
      </div>
    );
  }

  // ACP session — render ACP relay chat
  if (session.source === "acp" && session.environment_id) {
    return <ACPSessionDetail sessionId={sessionId} agentId={session.environment_id} initialCwd={initialCwd} />;
  }

  return (
    <TooltipProvider>
      <div className="flex flex-1 flex-col overflow-hidden">
        <h1 className="sr-only">{session.title || session.id}</h1>
        {/* Session Header — Nexus Indigo style */}
        <div className="session-header border-b border-border-subtle bg-surface-1 px-4 py-3">
          <div className="mx-auto max-w-5xl">
            {/* Back button */}
            <a
              href="/ctrl/"
              className="session-header-back inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-brand transition-colors no-underline mb-2"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span className="font-display">返回</span>
            </a>

            {/* Title + Status row */}
            <div className="flex items-start justify-between">
              <div className="min-w-0">
                <h2 className="font-display text-lg font-semibold text-text-primary tracking-tight">
                  {session.agent_name
                    ? `${session.agent_name} / ${session.id.slice(0, 12)}`
                    : (session.title || session.id)}
                </h2>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  {/* Status pulse dot + label */}
                  {sessionStatus && (
                    <span className="session-status-badge inline-flex items-center gap-1.5">
                      <span className={cn(
                        "session-status-dot inline-block h-2 w-2 rounded-full",
                        sessionStatus === "running" || sessionStatus === "active"
                          ? "bg-status-running animate-pulse-subtle"
                          : sessionStatus === "error"
                            ? "bg-status-error"
                            : "bg-text-muted",
                      )} />
                      <span className={cn(
                        "text-[11px] font-medium font-display",
                        sessionStatus === "running" || sessionStatus === "active"
                          ? "text-status-running"
                          : sessionStatus === "error"
                            ? "text-status-error"
                            : "text-text-muted",
                      )}>
                        {sessionStatus === "running" ? "Running" :
                         sessionStatus === "active" ? "Active" :
                         sessionStatus === "idle" ? "Idle" :
                         sessionStatus === "error" ? "Error" :
                         sessionStatus.charAt(0).toUpperCase() + sessionStatus.slice(1)}
                      </span>
                    </span>
                  )}
                  {session.created_at && (
                    <span className="text-[11px] text-text-muted font-display">
                      Started {formatRelativeTime(session.created_at)}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setShowMeta(!showMeta)}
                  className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-text-muted hover:bg-surface-2 hover:text-text-secondary transition-colors"
                  title="Session info"
                >
                  <Info className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setTaskPanelOpen(!taskPanelOpen)}
                  className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-display font-medium text-text-secondary hover:bg-surface-2 transition-colors"
                >
                  Tasks
                </button>
              </div>
            </div>

            {/* Session Stats Row — 4 cards */}
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 session-stats-row">
              <SessionStatCard
                icon={<Cpu className="h-3.5 w-3.5" />}
                label="Model"
                value={session.agent_name || "default"}
                colorClass="stat-brand"
              />
              <SessionStatCard
                icon={<Hash className="h-3.5 w-3.5" />}
                label="Tokens"
                value={stats.estimatedTokens > 0 ? `~${stats.estimatedTokens.toLocaleString()}` : "—"}
                colorClass="stat-green"
              />
              <SessionStatCard
                icon={<Wrench className="h-3.5 w-3.5" />}
                label="Tools"
                value={String(stats.toolCalls)}
                colorClass="stat-cyan"
              />
              <SessionStatCard
                icon={<Clock className="h-3.5 w-3.5" />}
                label="Duration"
                value={stats.durationStr}
                colorClass="stat-amber"
              />
            </div>

            {showMeta && (
              <div className="mt-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-text-muted space-y-1 font-mono">
                <div><span className="text-text-secondary font-sans font-medium">Session</span> {session.id}</div>
                {session.environment_id && (
                  <div><span className="text-text-secondary font-sans font-medium">Environment</span> {session.environment_id}</div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Chat + Context Panel row — responsive: flex-col on small screens */}
        <div className="flex flex-col md:flex-row flex-1 min-h-0 relative">
          <div className="flex flex-1 flex-col min-w-0 min-h-0">
            {/* Chat messages — unified ChatView */}
            <ChatView
              entries={entries}
              isLoading={isLoading}
              emptyTitle="开始对话"
              emptyDescription="输入消息开始聊天"
            />

            {/* Unified Permission Panel — above input */}
            {pendingPermissions.length > 0 && (
              <div className="border-t bg-surface-1 px-4 py-3">
                <div className="mx-auto max-w-3xl space-y-3">
                  {pendingPermissions.map((req) => (
                    <PermissionEventView
                      key={req.requestId}
                      request={req}
                      onApprove={() => handleApprovePermission(req.requestId)}
                      onReject={() => handleRejectPermission(req.requestId)}
                      onSubmitAnswers={handleSubmitAnswers}
                      onSubmitPlan={handleSubmitPlanResponse}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Unified ChatInput — claude.ai style */}
            <ChatInput
              onSubmit={handleSubmit}
              isLoading={isLoading}
              onInterrupt={handleInterrupt}
              disabled={closed || !!error || !session}
              placeholder={error ? "会话加载失败" : closed ? "会话已关闭" : "输入消息..."}
              sessionId={sessionId}
            />
          </div>

          {/* Context Panel */}
          <ContextPanel
            entries={entries}
            agentName={session.agent_name}
            duration={stats.durationStr}
            collapsed={!contextPanelOpen}
            onToggle={() => setContextPanelOpen(!contextPanelOpen)}
          />
        </div>

        {/* Task Panel */}
        {taskPanelOpen && <TaskPanel onClose={() => setTaskPanelOpen(false)} />}
      </div>
    </TooltipProvider>
  );
}

// ============================================================
// Session Stat Card — 4-grid stats row
// ============================================================

function SessionStatCard({
  icon,
  label,
  value,
  colorClass,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  colorClass: string;
}) {
  return (
    <div className="session-stat-card flex items-center gap-2.5 rounded-lg border border-border-subtle bg-surface-1 px-3 py-2">
      <div className={cn("session-stat-icon flex items-center justify-center h-7 w-7 rounded-md", colorClass)}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-[10px] font-display font-semibold uppercase tracking-wider text-text-muted">{label}</div>
        <div className="text-sm font-display font-medium text-text-primary truncate">{value}</div>
      </div>
    </div>
  );
}

// ============================================================
// Relative time formatter
// ============================================================

function formatRelativeTime(ts: number | null | undefined): string {
  if (!ts) return "";
  const seconds = Math.floor(Date.now() / 1000 - ts);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// ============================================================
// Permission Event View — routes to correct UI
// ============================================================

function PermissionEventView({
  request,
  onApprove,
  onReject,
  onSubmitAnswers,
  onSubmitPlan,
}: {
  request: PendingPermission;
  onApprove: () => void;
  onReject: () => void;
  onSubmitAnswers: (requestId: string, answers: Record<string, unknown>, questions: import("../types").Question[]) => void;
  onSubmitPlan: (requestId: string, value: string, feedback?: string) => void;
}) {
  const toolName = request.toolName;
  const toolInput = request.toolInput;
  const description = request.description || "";

  if (toolName === "AskUserQuestion") {
    const questions = (toolInput.questions as import("../types").Question[]) || [];
    return (
      <AskUserPanelView
        requestId={request.requestId}
        questions={questions}
        description={description}
        onSubmit={(answers) => onSubmitAnswers(request.requestId, answers, questions)}
        onSkip={onReject}
      />
    );
  }

  if (toolName === "ExitPlanMode") {
    const planContent = (toolInput.plan as string) || "";
    return (
      <PlanPanelView
        requestId={request.requestId}
        planContent={planContent}
        description={description}
        onSubmit={(value, feedback) => onSubmitPlan(request.requestId, value, feedback)}
      />
    );
  }

  return (
    <PermissionPromptView
      requestId={request.requestId}
      toolName={toolName}
      toolInput={toolInput}
      description={description}
      onApprove={onApprove}
      onReject={onReject}
    />
  );
}

// ============================================================
// ACP Session Detail — renders ACP relay chat in session page
// ============================================================

function ACPSessionDetail({ sessionId, agentId, initialCwd }: { sessionId: string; agentId: string; initialCwd?: string }) {
  const [client, setClient] = useState<ACPClient | null>(null);
  const [connectionState, setConnectionState] = useState<"disconnected" | "connecting" | "connected" | "error">("disconnected");
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<ACPClient | null>(null);

  useEffect(() => {
    const relayClient = createRelayClient(agentId, sessionId);

    relayClient.setConnectionStateHandler((state, err) => {
      setConnectionState(state);
      setError(err || null);
    });

    clientRef.current = relayClient;
    setClient(relayClient);

    relayClient.connect().catch((e) => {
      if (e instanceof DisconnectRequestedError) return;
      setError((e as Error).message);
      setConnectionState("error");
    });

    return () => {
      relayClient.disconnect();
      clientRef.current = null;
      setClient(null);
      setConnectionState("disconnected");
    };
  }, [agentId]);

  return (
    <TooltipProvider>
      <div className="flex flex-1 flex-col overflow-hidden">
        {connectionState === "connecting" && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="animate-spin h-8 w-8 border-2 border-brand border-t-transparent rounded-full mx-auto mb-3" />
              <p className="text-text-muted text-sm">正在连接 Agent...</p>
            </div>
          </div>
        )}

        {connectionState === "connected" && client && (
          <div className="flex-1 min-h-0">
            <ACPMain client={client} agentId={agentId} initialCwd={initialCwd} rcsSessionId={sessionId} />
          </div>
        )}

        {(connectionState === "error" || connectionState === "disconnected") && connectionState !== "connecting" && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-md">
              <p className="font-medium mb-2">Agent 未连接</p>
              <p className="text-text-muted text-sm mb-4">
                {error || "Agent 尚未上线，请确保 acp-link 已启动并连接到服务器"}
              </p>
              <a
                href="/ctrl/"
                className="inline-block rounded-md bg-brand px-4 py-2 text-sm text-white hover:bg-brand/90 transition-colors no-underline"
              >
                返回仪表盘
              </a>
            </div>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
