import { Bot, Loader2, Power, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { client } from "../../api/client";
import type { Environment, EnvironmentInstance } from "../../types/index";

interface AgentSidebarTreeProps {
  collapsed: boolean;
  selectedInstanceId: string | null;
  onSelectInstance: (instanceId: string, envId: string, sessionId: string | null) => void;
}

export function AgentSidebarTree({ collapsed, selectedInstanceId, onSelectInstance }: AgentSidebarTreeProps) {
  const [envs, setEnvs] = useState<Environment[]>([]);
  const [instancesMap, setInstancesMap] = useState<Record<string, EnvironmentInstance[]>>({});
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const { data, error: err } = await client.web.environments.get();
      if (err) {
        console.error("Failed to load environments:", err);
        return;
      }
      const list = Array.isArray(data) ? (data as unknown as Environment[]) : [];
      setEnvs(list);

      const activeEnvs = list.filter((e: Environment) => (e.instances_count ?? 0) > 0);
      if (activeEnvs.length > 0) {
        const results = await Promise.allSettled(
          activeEnvs.map((env: Environment) => client.web.environments({ id: env.id }).instances.get()),
        );
        const newMap: Record<string, EnvironmentInstance[]> = {};
        activeEnvs.forEach((env: Environment, i: number) => {
          const r = results[i];
          if (r.status === "fulfilled") {
            const instData = r.value.data as { instances?: EnvironmentInstance[] } | null;
            newMap[env.id] = instData?.instances ?? [];
          }
        });
        setInstancesMap((prev) => ({ ...prev, ...newMap }));
      }
    } catch (err) {
      console.error("Failed to load agent tree:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 15_000);
    return () => clearInterval(interval);
  }, [loadData]);

  const tree = useMemo(() => {
    return envs.map((env) => ({
      env,
      instances: instancesMap[env.id] ?? [],
    }));
  }, [envs, instancesMap]);

  const getInstanceStatus = (instance: EnvironmentInstance) => {
    if (instance.status === "running") return "running";
    if (instance.status === "starting") return "starting";
    if (instance.status === "error") return "error";
    return "stopped";
  };

  const handleStopInstance = useCallback(
    async (instanceId: string) => {
      try {
        await client.web.instances({ id: instanceId }).delete();
        await loadData();
      } catch (err) {
        console.error("停止实例失败:", err);
        toast.error(`停止实例失败: ${(err as Error).message}`);
      }
    },
    [loadData],
  );

  const handleEnterInstance = useCallback(
    async (env: Environment, instanceNumber?: number) => {
      try {
        const body = instanceNumber !== undefined ? { instance_number: instanceNumber } : {};
        const { data, error: err } = await client.web.environments({ id: env.id }).enter.post(body);
        if (err) throw new Error(err.message ?? "进入失败");
        const result = data as { session_id: string; instance_id: string; environment_id: string } | null;
        onSelectInstance(result?.instance_id ?? "", result?.environment_id ?? env.id, result?.session_id ?? null);
      } catch (err) {
        console.error("进入实例失败:", err);
        toast.error(`进入实例失败: ${(err as Error).message}`);
      }
    },
    [onSelectInstance],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className="py-2 flex flex-col items-center gap-1">
        {tree.flatMap(({ env, instances }) =>
          instances.length > 0
            ? instances.map((inst) => (
                <button
                  key={inst.id}
                  type="button"
                  title={`实例 #${inst.instance_number}`}
                  onClick={() => handleEnterInstance(env, inst.instance_number)}
                  className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-hover cursor-pointer transition-colors"
                >
                  <span className={`status-dot ${getInstanceStatus(inst)}`} />
                </button>
              ))
            : [
                <button
                  key={env.id}
                  type="button"
                  title={env.name}
                  onClick={() => handleEnterInstance(env)}
                  className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-hover cursor-pointer transition-colors"
                >
                  <span className="status-dot stopped" />
                </button>,
              ],
        )}
      </div>
    );
  }

  if (tree.length === 0) {
    return (
      <div className="px-4 py-4 text-center">
        <Bot className="h-8 w-8 mx-auto mb-2 text-text-muted opacity-30" />
        <p className="text-xs text-text-muted">暂无智能体</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-1">
      <div className="px-5 pt-2 pb-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-dim">智能体</span>
      </div>
      {tree.map(({ env, instances }) => (
        <div key={env.id}>
          <div className="agent-tree-template">{env.name}</div>
          {instances.length > 0 ? (
            instances.map((inst) => (
              <div
                key={inst.id}
                className={`agent-tree-instance ${selectedInstanceId === inst.id ? "selected" : ""}`}
                onClick={() => handleEnterInstance(env, inst.instance_number)}
              >
                <span className={`status-dot ${getInstanceStatus(inst)}`} />
                <span className="truncate">实例 #{inst.instance_number}</span>
              </div>
            ))
          ) : (
            <div className="agent-tree-instance" onClick={() => handleEnterInstance(env)}>
              <span className="status-dot stopped" />
              <span className="truncate">{env.name}</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
