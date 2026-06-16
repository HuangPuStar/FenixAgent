import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { sessionApi } from "@/src/api/sdk";
import { AgentCardList } from "../shared/AgentCardList";
import { AgentPageHeader } from "../shared/AgentPageHeader";

interface SessionInfo {
  id: string;
  agentId?: string;
  agentName?: string;
  cwd?: string;
  status?: string;
  createdAt?: number;
}

export function AgentSessionsPage() {
  const { t } = useTranslation("sessions");
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    try {
      const { data: list, error } = await sessionApi.list();
      if (error) {
        toast.error(t("loadError", { message: error.message }));
        return;
      }
      setSessions(Array.isArray(list) ? list : []);
    } catch (e) {
      console.error("Failed to load sessions", e);
      toast.error(t("loadError", { message: e instanceof Error ? e.message : "Unknown error" }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  if (loading) {
    return (
      <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <Skeleton className="h-[22px] w-28 rounded-md" />
            <Skeleton className="mt-1.5 h-3 w-56 rounded-md" />
          </div>
        </div>
        <div className="mb-3.5 h-px bg-[#e8edf4]" />
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
      <AgentPageHeader title={t("title")} subtitle={t("subtitle")} />
      <AgentCardList
        items={sessions}
        cardKey={(s) => s.id}
        searchPlaceholder={t("searchPlaceholder")}
        searchFn={(s, q) => s.id.toLowerCase().includes(q) || (s.agentName?.toLowerCase().includes(q) ?? false)}
        emptyMessage={t("emptyMessage")}
        renderCard={(session) => (
          <div className="group rounded-lg border border-border-light bg-surface-1 px-4 py-3 transition-colors hover:border-border-active hover:shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-medium text-text-bright">{session.id}</span>
                  {session.status && (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-surface-2 text-text-muted">
                      {session.status}
                    </span>
                  )}
                </div>
                <p className="text-xs text-text-secondary mt-1 truncate">
                  {session.agentName ?? session.agentId ?? "—"} · {session.cwd ?? "—"}
                </p>
              </div>
              {session.agentId && (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    void navigate({
                      to: "/agent/chat/$agentId/$sessionId",
                      params: { agentId: session.agentId!, sessionId: session.id },
                    })
                  }
                >
                  {t("actions.view")}
                </Button>
              )}
            </div>
          </div>
        )}
      />
    </div>
  );
}
