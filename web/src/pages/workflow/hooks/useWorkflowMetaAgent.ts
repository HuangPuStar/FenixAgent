import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { agentApi, envApi } from "@/src/api/sdk";
import { useMetaAgent } from "@/src/hooks/useMetaAgent";
import type { WfMeta } from "../yaml-utils";

export interface UseWorkflowMetaAgentParams {
  workflowId: string | undefined;
  meta: WfMeta;
  /** 当前选中的节点信息（id + type），用于 context queue */
  selectedNodeInfo?: { id: string; type: string } | null;
}

/**
 * agent 节点下拉项。
 *
 * 这里展示的是"智能体"（AgentConfig）维度，与左侧 AgentSidebar 一致；
 * 但 yaml 里 agent 节点的 `agent` 字段语义是 environment 名字（运行时按 envName 解析，
 * 见 src/services/workflow/index.ts 的 ChannelFactory），所以选中后写入 yaml 的实际是 envName。
 * 没有绑定 environment 的智能体 envName 为 null，前端需要禁选。
 */
export interface AgentNodeOption {
  /** AgentConfig 名称，仅用于展示 */
  name: string;
  description: string | null;
  /** 该智能体绑定的 environment 名；null 表示未绑定，运行时无法解析 */
  envName: string | null;
}

export interface UseWorkflowMetaAgentReturn {
  scenePrompt: string | undefined;
  chatOpen: boolean;
  setChatOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  metaAgentId: string | null;
  agentList: AgentNodeOption[];
  agentOverrideOpen: boolean;
  setAgentOverrideOpen: (open: boolean) => void;
  /** 上下文标识（workflowId），变化时触发新会话 */
  contextKey: string | undefined;
}

/**
 * Workflow 场景专用 Meta Agent hook。
 * 内部调用通用 useMetaAgent，并添加 workflow 特有的 scenePrompt/agentList 等逻辑。
 */
export function useWorkflowMetaAgent({
  workflowId,
  meta,
  selectedNodeInfo,
}: UseWorkflowMetaAgentParams): UseWorkflowMetaAgentReturn {
  const { t } = useTranslation("workflows");
  const { metaAgentId, chatOpen, setChatOpen } = useMetaAgent({ storageKey: "wf-editor:chat-open" });

  const scenePrompt = useMemo(() => {
    if (!workflowId) return;
    const lines = [
      t("editor.workflow_context"),
      `- ${t("editor.workflow_id")}: ${workflowId}`,
      `- ${t("editor.workflow_name")}: ${meta.name || t("editor.workflow_unnamed")}`,
      `- ${t("editor.workflow_desc_label")}: ${meta.description || t("editor.workflow_no_desc")}`,
      t("editor.workflow_api_prompt"),
    ];
    return lines.join("\n");
  }, [workflowId, meta.name, meta.description, t]);

  const [agentList, setAgentList] = useState<AgentNodeOption[]>([]);
  const [agentOverrideOpen, setAgentOverrideOpen] = useState(false);

  useEffect(() => {
    // 并行拉 AgentConfig 列表（智能体）+ environment 列表，建立 AgentConfig → envName 映射。
    // 与左侧 AgentSidebarTree 的数据组装方式一致：过滤掉内置智能体，每个智能体关联到绑定的 environment。
    Promise.all([agentApi.list(), envApi.list()])
      .then(([agentResult, envResult]) => {
        const raw = agentResult.ok
          ? (
              agentResult.data as {
                agents?: Array<{ id: string; name: string; description?: string; builtIn?: boolean }>;
              } | null
            )?.agents
          : null;
        const agents = Array.isArray(raw) ? raw : [];
        const envs = envResult.ok && Array.isArray(envResult.data) ? envResult.data : [];

        // agentConfigId → environment.name，用于把"智能体"翻译成 yaml 需要的 envName
        const envNameByConfigId = new Map<string, string>();
        for (const env of envs) {
          if (env.agent_config_id) {
            envNameByConfigId.set(env.agent_config_id, env.name);
          }
        }

        const list: AgentNodeOption[] = agents
          .filter((a) => !a.builtIn)
          .map((a) => ({
            name: a.name,
            description: a.description ?? null,
            envName: envNameByConfigId.get(a.id) ?? null,
          }));

        setAgentList(list);
      })
      .catch((err: unknown) => console.error("Failed to load agent list:", err));
  }, []);

  return {
    scenePrompt,
    contextKey: workflowId,
    chatOpen,
    setChatOpen,
    metaAgentId,
    agentList,
    agentOverrideOpen,
    setAgentOverrideOpen,
  };
}
