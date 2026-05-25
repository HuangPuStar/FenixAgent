import { useTranslation } from "react-i18next";
import { formatTime } from "../lib/utils";
import type { Session } from "../types";
import { StatusBadge } from "./Navbar";

interface SessionListProps {
  sessions: Session[];
  onSelect: (sessionId: string) => void;
}

export function SessionList({ sessions, onSelect }: SessionListProps) {
  const { t } = useTranslation("components");

  if (!sessions || sessions.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface-1 px-4 py-8 text-center text-text-muted text-sm">
        {t("sessionList.noSessions")}
      </div>
    );
  }

  const sorted = [...sessions].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));

  return (
    <div className="space-y-1">
      {sorted.map((session) => (
        <button
          key={session.id}
          type="button"
          onClick={() => onSelect(session.id)}
          className="flex w-full items-center justify-between rounded-lg border border-transparent bg-surface-1 px-4 py-3 text-left transition-colors hover:bg-surface-2 hover:border-border"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium text-text-primary">{session.title || session.id}</span>
              {session.source === "acp" && (
                <span className="rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-medium text-brand">ACP</span>
              )}
            </div>
            <div className="truncate text-xs text-text-muted mt-0.5">{session.id}</div>
          </div>
          <div className="flex items-center gap-3 ml-4">
            <StatusBadge status={session.status} />
            <span className="text-xs text-text-muted whitespace-nowrap">
              {formatTime(session.created_at || session.updated_at)}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}
