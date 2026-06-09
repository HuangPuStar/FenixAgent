import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { envApi } from "@/src/api/sdk";
import { useMetaAgent } from "@/src/hooks/useMetaAgent";
import type { WfMeta } from "../yaml-utils";

export interface UseWorkflowMetaAgentParams {
  workflowId: string | undefined;
  meta: WfMeta;
}

export interface UseWorkflowMetaAgentReturn {
  scenePrompt: string | undefined;
  chatOpen: boolean;
  setChatOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  metaAgentId: string | null;
  agentList: Array<{ name: string; description: string | null }>;
  agentOverrideOpen: boolean;
  setAgentOverrideOpen: (open: boolean) => void;
}

/**
 * Workflow 场景专用 Meta Agent hook。
 * 内部调用通用 useMetaAgent，并添加 workflow 特有的 scenePrompt/agentList 等逻辑。
 */
export function useWorkflowMetaAgent({ workflowId, meta }: UseWorkflowMetaAgentParams): UseWorkflowMetaAgentReturn {
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

  const [agentList, setAgentList] = useState<Array<{ name: string; description: string | null }>>([]);
  const [agentOverrideOpen, setAgentOverrideOpen] = useState(false);

  useEffect(() => {
    envApi
      .list()
      .then((result) => {
        if (result.ok && Array.isArray(result.data)) {
          setAgentList(
            result.data.map((env) => ({
              name: env.name,
              description: env.description ?? null,
            })),
          );
        }
      })
      .catch((err: unknown) => console.error("Failed to load environment list:", err));
  }, []);

  return {
    scenePrompt,
    chatOpen,
    setChatOpen,
    metaAgentId,
    agentList,
    agentOverrideOpen,
    setAgentOverrideOpen,
  };
}
