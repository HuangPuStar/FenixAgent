import type { Environment } from "../types";
import { StatusBadge } from "./Navbar";
import { esc, formatTime } from "../lib/utils";

interface EnvironmentListProps {
  environments: Environment[];
  onSelectEnvironment?: (env: Environment) => void;
}

export function EnvironmentList({ environments, onSelectEnvironment }: EnvironmentListProps) {
  if (!environments || environments.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface-1 px-4 py-8 text-center text-text-muted text-sm">
        No active environments
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {environments.map((env) => {
        const isAcp = env.worker_type === "acp";
        const typeLabel = isAcp ? "ACP Agent" : "Claude Code";
        const typeColor = isAcp ? "bg-brand/10 text-brand" : "bg-status-running/10 text-status-running";

        return (
          <button
            key={env.id}
            type="button"
            onClick={() => onSelectEnvironment?.(env)}
            disabled={isAcp}
            className={`flex w-full items-center justify-between rounded-lg border border-transparent bg-surface-1 px-4 py-3 text-left transition-colors ${isAcp ? "cursor-default opacity-70" : "hover:bg-surface-2 hover:border-border cursor-pointer"}`}
          >
            <div className="flex items-center gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">
                    {env.machine_name || env.id}
                  </span>
                  <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${typeColor}`}>
                    {typeLabel}
                  </span>
                </div>
                <div className="text-xs text-text-muted mt-0.5">{env.directory || ""}</div>
              </div>
            </div>
            <div className="text-right ml-4">
              <StatusBadge status={env.status} />
              <div className="mt-0.5 text-xs text-text-muted">
                {env.branch || ""}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
