import { useRequest } from "ahooks";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { agentApi } from "../../../api/agents";
import { envApi } from "../../../api/environments";
import { hindsightApi } from "../../../api/hindsight";
import { instanceApi } from "../../../api/instances";
import { kbApi } from "../../../api/knowledge-bases";
import { mcpApi } from "../../../api/mcp";
import { modelApi } from "../../../api/models";
import { registryApi } from "../../../api/registry";
import { unwrap } from "../../../api/request";
import { sandboxPoolApi } from "../../../api/sandbox-pools";
import { agentSitesApi } from "../../../api/sites";
import { skillConfigApi } from "../../../api/skills";
import { dispatchConfigChange } from "../../../lib/config-events";
import { getSkillOptionValue, normalizeSkillOptionsPayload } from "../../../lib/skill-resource-access";
import type { AgentDetail, ResourceAccess } from "../../../types/config";
import type { KnowledgeBaseInfo } from "../../../types/knowledge";
import {
  type AgentEditorOption,
  type AgentEditorValues,
  type AgentRelatedResources,
  type AgentTemplate,
  agentDetailToEditorValues,
  buildAgentEditorPayload,
  createAgentEditorDefaults,
  filterValidKnowledgeIds,
  mapMcpOptions,
  mapModelOptions,
  mergeSelectedOptions,
} from "./agent-editor-model";

export interface AgentEditorData {
  initialValues: AgentEditorValues;
  agentId: string | null;
  resourceAccess?: ResourceAccess;
  relatedResources?: AgentRelatedResources;
  hindsightEnabled: boolean;
  sandboxEnabled: boolean;
  models: AgentEditorOption[];
  skills: AgentEditorOption[];
  mcps: AgentEditorOption[];
  sites: AgentEditorOption[];
  knowledgeBases: AgentEditorOption[];
  nodes: AgentEditorOption[];
  templates: AgentTemplate[];
  resourceErrors: string[];
}

export type UseAgentEditorOptions =
  | {
      open: boolean;
      mode: "create";
      defaultName?: string;
      onOpenChange: (open: boolean) => void;
      onSuccess?: (agentConfigId?: string) => void;
      translate: (key: string, options?: Record<string, unknown>) => string;
      translatePanel: (key: string, options?: Record<string, unknown>) => string;
    }
  | {
      open: boolean;
      mode: "edit";
      agentName: string;
      onOpenChange: (open: boolean) => void;
      onSuccess?: never;
      defaultName?: never;
      translate: (key: string, options?: Record<string, unknown>) => string;
      translatePanel: (key: string, options?: Record<string, unknown>) => string;
    };

/** 每个重启成功的 environment 都按现有事件契约单独通知。 */
export function dispatchAgentReconnect(environmentIds: string[], target: Pick<Window, "dispatchEvent"> = window): void {
  for (const envId of new Set(environmentIds)) {
    target.dispatchEvent(new CustomEvent("agent:reconnect", { detail: { envId } }));
  }
}

/** 保留当前已绑定但不可见的执行节点，避免选择器回退到默认调度。 */
export function appendUnavailableNodeOption(
  nodes: AgentEditorOption[],
  selectedNode: AgentDetail["agentNode"] | undefined,
  label?: string | null,
): void {
  if (!selectedNode || (selectedNode.kind !== "machine" && selectedNode.kind !== "sandbox")) return;
  const resourceId = selectedNode.kind === "machine" ? selectedNode.machineId : selectedNode.sandboxPoolId;
  const id = `${selectedNode.kind}:${resourceId}`;
  if (nodes.some((item) => item.id === id)) return;
  nodes.push({ id, label: label?.trim() || resourceId, unavailable: true });
}

/** 集中处理编辑器加载、保存及实例重启，视图不直接消费协议 DTO。 */
export function useAgentEditor(options: UseAgentEditorOptions) {
  const agentName = options.mode === "edit" ? options.agentName : undefined;
  const defaultName = options.mode === "create" ? options.defaultName : undefined;
  const { open, mode, onOpenChange, onSuccess, translate: t, translatePanel: tp } = options;
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const [savedAgentId, setSavedAgentId] = useState<string | null>(null);

  const loadService = useCallback(async (): Promise<AgentEditorData> => {
    if (mode === "edit" && !agentName) throw new Error(t("editor.missingTarget"));
    setLoadError(null);

    const resourceErrors: string[] = [];
    const optional = async <T>(promise: Promise<T>, fallback: T, label: string): Promise<T> => {
      try {
        return await promise;
      } catch {
        resourceErrors.push(label);
        return fallback;
      }
    };

    const [
      detail,
      modelData,
      kbData,
      skillsData,
      mcpsData,
      machinesData,
      poolsData,
      sitesData,
      templatesData,
      hindsight,
    ] = await Promise.all([
      mode === "edit" ? unwrap(agentApi.get(agentName!)) : Promise.resolve(null),
      unwrap(modelApi.get()),
      unwrap(kbApi.list()),
      unwrap(skillConfigApi.list()),
      unwrap(mcpApi.list()),
      (async () => {
        const first = await unwrap(registryApi.list({ status: "online", limit: 100, offset: 0 }));
        const items = [...first.items];
        while (items.length < first.total) {
          const page = await unwrap(registryApi.list({ status: "online", limit: 100, offset: items.length }));
          if (!page.items.length) break;
          items.push(...page.items);
        }
        return { ...first, items };
      })(),
      optional(unwrap(sandboxPoolApi.list()), { enabled: false, pools: [] }, "sandbox pools unavailable"),
      optional(unwrap(agentSitesApi.list()), [], "sites unavailable"),
      optional(
        agentApi.templates().then(async (response) => unwrap(Promise.resolve(response))),
        { templates: [] },
        "templates unavailable",
      ),
      optional(hindsightApi.getStatus(), null, "hindsight unavailable"),
    ]);

    const typedDetail = detail as AgentDetail | null;
    const related = typedDetail?.relatedResources;
    const rawModelOptions = mapModelOptions(modelData.available ?? []);
    const modelOptions = rawModelOptions.map((option) => ({ id: option.value, label: option.label }));
    const skillViews = normalizeSkillOptionsPayload(skillsData);
    const knowledge = (Array.isArray(kbData) ? kbData : []) as KnowledgeBaseInfo[];
    const machineItems = machinesData?.items ?? [];
    const nodes: AgentEditorOption[] = [
      { id: "default", label: poolsData.enabled ? t("form.sandboxDefault") : t("form.machineDefault") },
      ...(poolsData.enabled
        ? poolsData.pools.map((pool) => ({ id: `sandbox:${pool.id}`, label: pool.name, meta: pool.id }))
        : []),
      ...machineItems.map((machine) => ({
        id: `machine:${machine.id}`,
        label: machine.name || String(machine.machineInfo?.hostname ?? machine.agentName),
        meta: machine.id,
      })),
    ];
    const selectedNode = typedDetail?.agentNode;
    const selectedNodeLabel =
      selectedNode?.kind === "machine"
        ? related?.machineLabel
        : selectedNode?.kind === "sandbox"
          ? poolsData.pools.find((pool) => pool.id === selectedNode.sandboxPoolId)?.name
          : undefined;
    appendUnavailableNodeOption(nodes, selectedNode, selectedNodeLabel);

    const initialValues = typedDetail
      ? agentDetailToEditorValues(typedDetail)
      : { ...createAgentEditorDefaults(defaultName), modelId: modelOptions[0]?.id ?? "" };

    return {
      initialValues,
      agentId: typedDetail?.id ?? null,
      resourceAccess: typedDetail?.resourceAccess,
      relatedResources: related,
      hindsightEnabled: Boolean(hindsight?.enabled),
      sandboxEnabled: poolsData.enabled,
      models: mergeSelectedOptions(
        modelOptions,
        typedDetail?.modelId && related?.modelLabel
          ? [{ id: typedDetail.modelId, label: related.modelLabel }]
          : undefined,
      ),
      skills: mergeSelectedOptions(
        skillViews.map((skill) => ({
          id: getSkillOptionValue(skill),
          label: skill.label,
          description: skill.description,
          meta: skill.key,
        })),
        related?.skills,
      ),
      mcps: mergeSelectedOptions(
        mapMcpOptions(mcpsData.servers).map((mcp) => ({ id: mcp.id, label: mcp.label, meta: mcp.key })),
        related?.mcps,
      ),
      sites: mergeSelectedOptions(
        sitesData.map((site) => ({
          id: site.id,
          label: site.name,
          description: site.description ?? undefined,
          meta: site.remoteAppId,
        })),
        related?.siteApps,
      ),
      knowledgeBases: mergeSelectedOptions(
        knowledge.map((item) => ({
          id: item.id,
          label: item.name,
          description: item.description ?? undefined,
          meta: item.slug,
        })),
        related?.knowledgeBases,
      ),
      nodes,
      templates: templatesData.templates,
      resourceErrors,
    };
  }, [agentName, defaultName, mode, t]);

  const loadRequest = useRequest(loadService, {
    ready: open && (mode === "create" || !!agentName),
    refreshDeps: [open, mode, agentName, defaultName],
    onError: (error) => setLoadError(error instanceof Error ? error : new Error(String(error))),
  });

  const saveRequest = useRequest(
    async (values: AgentEditorValues) => {
      if (loadError || !loadRequest.data) throw new Error(t("editor.loadRequired"));
      const cleanValues = { ...values };
      const latest = (await unwrap(kbApi.list())) as KnowledgeBaseInfo[];
      cleanValues.knowledgeBaseIds = filterValidKnowledgeIds(values.knowledgeBaseIds, latest);
      const payload = buildAgentEditorPayload(cleanValues, mode);
      if (mode === "create") {
        const result = await unwrap(agentApi.create(values.name.trim(), payload));
        toast.success(t("save.successCreate"));
        dispatchConfigChange("agents");
        onOpenChange(false);
        onSuccess?.(result.id);
        return;
      }
      if (options.mode !== "edit") return;
      const result = await unwrap(agentApi.set(options.agentName, payload));
      setSavedAgentId(result.id ?? loadRequest.data.agentId);
      toast.success(t("save.successUpdate"));
      dispatchConfigChange("agents");
      setRestartDialogOpen(true);
    },
    {
      manual: true,
      onError: (error) => {
        console.error("Failed to save agent configuration", error);
        toast.error(t("save.errorGeneric", { message: error instanceof Error ? error.message : t("unknownError") }));
      },
    },
  );

  const restartRequest = useRequest(
    async () => {
      const agentId = savedAgentId ?? loadRequest.data?.agentId;
      if (!agentId) throw new Error(tp("noInstancesToRestart"));
      const environments = await unwrap(envApi.list({ agentConfigId: agentId }));
      const targets = await Promise.all(
        environments.map(async (environment) => {
          const data = await unwrap(envApi.listInstances({ id: environment.id }));
          return (data.instances ?? [])
            .filter((instance) => instance.status === "running" || instance.status === "starting")
            .map((instance) => ({ environmentId: environment.id, instanceId: instance.id }));
        }),
      );
      const active = targets.flat();
      if (!active.length) {
        toast.info(tp("noInstancesToRestart"));
        setRestartDialogOpen(false);
        onOpenChange(false);
        return;
      }
      const results = await Promise.allSettled(
        active.map(async ({ environmentId, instanceId }) => {
          await unwrap(instanceApi.del({ id: instanceId }));
          await unwrap(instanceApi.spawn({ environmentId }));
        }),
      );
      const successfulEnvironmentIds = results.flatMap((result, index) =>
        result.status === "fulfilled" ? [active[index].environmentId] : [],
      );
      const failed = results.length - successfulEnvironmentIds.length;
      dispatchAgentReconnect(successfulEnvironmentIds);
      if (failed) throw new Error(tp("restartPartialFailed", { failed, total: active.length }));
      toast.success(tp("restartSuccess"));
      setRestartDialogOpen(false);
      onOpenChange(false);
    },
    {
      manual: true,
      onError: (error) =>
        toast.error(tp("restartFailedSaved", { message: error instanceof Error ? error.message : String(error) })),
    },
  );

  return useMemo(
    () => ({
      data: loadRequest.data,
      loading: loadRequest.loading,
      loadError: loadError ?? (open && mode === "edit" && !agentName ? new Error(t("editor.missingTarget")) : null),
      retry: loadRequest.refresh,
      save: saveRequest.runAsync,
      saving: saveRequest.loading,
      restartDialogOpen,
      setRestartDialogOpen,
      restart: restartRequest.run,
      restarting: restartRequest.loading,
    }),
    [
      agentName,
      loadError,
      loadRequest,
      mode,
      open,
      restartDialogOpen,
      restartRequest.loading,
      restartRequest.run,
      saveRequest.loading,
      saveRequest.runAsync,
      t,
    ],
  );
}
