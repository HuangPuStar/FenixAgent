import type { Environment } from "../types";
import type { InstanceInfo } from "../api/client";
import { StatusBadge } from "./Navbar";
import { esc, formatTime } from "../lib/utils";

interface EnvironmentListProps {
  environments: Environment[];
  instances: InstanceInfo[];
  onSelectEnvironment?: (env: Environment) => void;
  onStopInstance?: (instanceId: string) => void;
}

export function EnvironmentList({ environments, instances, onSelectEnvironment, onStopInstance }: EnvironmentListProps) {
  const instanceMap = new Map<string, InstanceInfo>();
  for (const inst of instances) {
    instanceMap.set(inst.group_id, inst);
  }

  if (!environments || environments.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface-1 px-4 py-8 text-center text-text-muted text-sm">
        暂无活跃环境
      </div>
    );
  }

  const matchedGroupIds = new Set<string>();
  for (const env of environments) {
    if (env.worker_type === "acp" && env.channel_group_id && instanceMap.has(env.channel_group_id)) {
      matchedGroupIds.add(env.channel_group_id);
    }
  }
  const unmatchedInstances = instances.filter(inst => !matchedGroupIds.has(inst.group_id));

  if ((!environments || environments.length === 0) && unmatchedInstances.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface-1 px-4 py-8 text-center text-text-muted text-sm">
        暂无活跃环境
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {environments.map((env) => {
        const isAcp = env.worker_type === "acp";
        const typeLabel = isAcp ? "ACP Agent" : "智能体";
        const typeColor = isAcp ? "bg-brand/10 text-brand" : "bg-status-running/10 text-status-running";

        return (
          <button
            key={env.id}
            type="button"
            onClick={() => onSelectEnvironment?.(env)}
            className={`flex w-full items-center justify-between rounded-lg border border-transparent bg-surface-1 px-4 py-3 text-left transition-colors hover:bg-surface-2 hover:border-border cursor-pointer`}
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
            <div className="flex items-center gap-2 ml-4 shrink-0">
              <StatusBadge status={env.status} />
              {env.branch && <span className="text-xs text-text-muted">{env.branch}</span>}
              {(() => {
                const isAcp = env.worker_type === "acp";
                if (!isAcp) return null;
                const inst = instanceMap.get(env.channel_group_id || "");
                if (!inst) return null;
                return (
                  <>
                    <span className="text-xs text-text-muted">:{inst.port}</span>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onStopInstance?.(inst.id); }}
                      className="rounded px-2 py-0.5 text-[10px] font-medium text-status-error hover:bg-status-error/10 transition-colors"
                    >
                      停止
                    </button>
                  </>
                );
              })()}
            </div>
          </button>
        );
      })}
      {unmatchedInstances.map((inst) => (
        <div
          key={inst.id}
          className="flex w-full items-center justify-between rounded-lg border border-border border-dashed bg-surface-1 px-4 py-3"
        >
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary">{inst.id.slice(0, 16)}...</span>
            <span className="rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-brand/10 text-brand">
              ACP Agent
            </span>
          </div>
          <div className="flex items-center gap-2 ml-4 shrink-0">
            <StatusBadge status={inst.status === "running" ? "active" : inst.status === "error" ? "error" : "disconnected"} />
            <span className="text-xs text-text-muted">:{inst.port}</span>
            {inst.error && <span className="text-xs text-status-error">{inst.error}</span>}
            {inst.status !== "stopped" && (
              <button
                type="button"
                onClick={() => onStopInstance?.(inst.id)}
                className="rounded px-2 py-0.5 text-[10px] font-medium text-status-error hover:bg-status-error/10 transition-colors"
              >
                停止
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
