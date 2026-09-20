import { ensureMetaAgent } from "@fenix/agent-config/web";
import { envApi } from "@fenix/agent-runtime/web/api/environments";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
 *
 * 展开态 + Meta Agent environment 的就绪逻辑在本文件内自持（原先调用的通用 `useMetaAgent` 没有发布方：
 * 分支把它放在 agent-config 的 `web/hooks/use-meta-agent.ts`，尚未落到本仓库；宿主同名 hook
 * `apps/web/src/hooks/useMetaAgent.ts` 当前零引用、属宿主私有）。这里只保留环境就绪这一段，
 * 不再复制一份通用 hook 文件；待 agent-config 经 `@fenix/agent-config/web` 发布 `useMetaAgent` 后，
 * 本段收敛为对该导出的调用（已登记 sharedPatch）。`ensureMetaAgent` 只能从
 * `@fenix/agent-config/web`（对方根入口）取，不得走深层路径。
 *
 * `ensureMetaAgent` 只在面板展开时请求（收起状态不自建 environment），并用 ref 去重快速 toggle；
 * 失败只记录诊断，不打断编辑器——面板本身就是可选能力。
 */
export function useWorkflowMetaAgent({
  workflowId,
  meta,
  selectedNodeInfo: _selectedNodeInfo,
}: UseWorkflowMetaAgentParams): UseWorkflowMetaAgentReturn {
  const { t } = useTranslation("workflows");

  // 展开态按浏览器持久化，刷新后保持用户上次的选择（key 含场景，避免与 agent-panel 的 chat 面板串味）
  const [chatOpen, setChatOpen] = useState(() => localStorage.getItem("wf-editor:chat-open") === "true");
  const [metaAgentId, setMetaAgentId] = useState<string | null>(null);
  const metaAgentPendingRef = useRef(false);

  useEffect(() => {
    localStorage.setItem("wf-editor:chat-open", String(chatOpen));
    if (!chatOpen || metaAgentId || metaAgentPendingRef.current) return;
    metaAgentPendingRef.current = true;
    ensureMetaAgent()
      .then((res) => setMetaAgentId(res.environmentId))
      .catch((err: unknown) => console.error("Meta Agent 环境确保失败:", err))
      .finally(() => {
        metaAgentPendingRef.current = false;
      });
  }, [chatOpen, metaAgentId]);

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
      return (envsResult as unknown as Record<string, unknown>[])
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
