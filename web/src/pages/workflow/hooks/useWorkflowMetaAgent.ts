import { useRequest } from "ahooks";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { envApi } from "@/src/api/environments";
import { unwrap } from "@/src/api/request";
import { useMetaAgent } from "@/src/hooks/useMetaAgent";
import type { WfMeta } from "../yaml-utils";

export interface UseWorkflowMetaAgentParams {
  workflowId: string | undefined;
  meta: WfMeta;
  /** 当前选中的节点信息（id + type），用于 context queue */
  selectedNodeInfo?: { id: string; type: string } | null;
}

/**
 * Agent 节点下拉项。
 *
 * 从环境（Environment）维度构建选项，每个环境是一个独立的运行时实例。
 * 选中后写入 yaml 的 `agent` 字段值为环境名称（environment.name），
 * 运行时由 ChannelFactory 按 envName 解析到对应环境。
 */
export interface AgentNodeOption {
  /** Environment ID，作为列表项的 key */
  envId: string;
  /** Environment name，写入 YAML `agent` 字段的值 */
  envName: string;
  /** Agent 配置名称，UI 展示用 */
  agentName: string;
  /** Environment 当前状态（idle / running） */
  status: string;
  /** Environment 实例数量 */
  instancesCount: number;
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
  selectedNodeInfo: _selectedNodeInfo,
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

  const [agentOverrideOpen, setAgentOverrideOpen] = useState(false);

  // 从环境列表构建 agent 节点选项（每个环境视为一个独立的 agent 实例可选项）。
  // 环境 API 响应已包含 agentName 字段（LEFT JOIN agentConfig），无需额外拉取 agent 配置。
  const { data: agentList = [] } = useRequest(
    async () => {
      const envsResult = await unwrap(envApi.list());
      return (envsResult as Record<string, unknown>[])
        .filter((env) => env.agentName) // 只保留已绑定 Agent 配置的环境
        .map((env) => ({
          envId: env.id as string,
          envName: env.name as string,
          agentName: env.agentName as string,
          status: (env.status as string) ?? "idle",
          instancesCount: (env.instancesCount as number) ?? 0,
        }));
    },
    {
      onError: (err: unknown) => console.error("Failed to load environment list:", err),
    },
  );

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
