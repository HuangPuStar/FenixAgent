import { useNavigate } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { unwrap } from "@/src/api/request";
import { sessionApi } from "@/src/api/sessions";
import { AgentCardList } from "../shared/AgentCardList";
import { AgentPageHeader } from "../shared/AgentPageHeader";

interface SessionInfo {
  id: string;
  title?: string | null;
  agentId?: string;
  agentName?: string;
  cwd?: string;
  status?: string;
  createdAt?: number;
}

export function AgentSessionsPage() {
  const { t } = useTranslation("sessions");
  const navigate = useNavigate();

  // 加载会话列表
  const { data: sessions = [], loading } = useRequest(
    async () => {
      const list = await unwrap(sessionApi.list());
      return (Array.isArray(list) ? list : []) as SessionInfo[];
    },
    {
      onError: (err) => {
        console.error("Failed to load sessions", err);
        toast.error(t("loadError", { message: err.message }));
      },
    },
  );

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
                  <span className="font-mono text-sm font-medium text-text-bright">{session.title || session.id}</span>
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
