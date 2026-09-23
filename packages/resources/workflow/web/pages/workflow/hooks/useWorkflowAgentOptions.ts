import { envApi } from "@fenix/agent-runtime/web/api/environments";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

/** 工作流 Agent 节点的环境选项；YAML 的 `agent` 字段存储环境名称。 */
export interface AgentNodeOption {
  envId: string;
  envName: string;
  agentName: string;
  status: string;
  instancesCount: number;
}

/** 环境 API 已包含绑定的 Agent 名称，不额外拉取 Agent 配置。 */
export function useWorkflowAgentOptions(): AgentNodeOption[] {
  const { t } = useTranslation("workflows");
  const { data: agentList = [] } = useRequest(
    async () => {
      const envsResult = await unwrap(envApi.list());
      return (envsResult as unknown as Record<string, unknown>[])
        .filter((env) => env.agentName)
        .map((env) => ({
          envId: env.id as string,
          envName: env.name as string,
          agentName: env.agentName as string,
          status: (env.status as string) ?? "idle",
          instancesCount: (env.instancesCount as number) ?? 0,
        }));
    },
    {
      onError: (err: unknown) => {
        console.error("Failed to load environment list:", err);
        toast.error(t("editor.load_agents_failed"));
      },
    },
  );
  return agentList;
}
