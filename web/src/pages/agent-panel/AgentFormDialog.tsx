import { useRequest } from "ahooks";
import { Plus, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { agentApi } from "@/src/api/agents";
import { envApi } from "@/src/api/environments";
import { instanceApi } from "@/src/api/instances";
import { kbApi } from "@/src/api/knowledge-bases";
import { mcpApi } from "@/src/api/mcp";
import { modelApi } from "@/src/api/models";
import { orgApi } from "@/src/api/organizations";
import { registryApi } from "@/src/api/registry";
import { unwrap } from "@/src/api/request";
import { agentSitesApi, type SiteApp } from "@/src/api/sites";
import { skillConfigApi } from "@/src/api/skills";
import { useOrg } from "../../contexts/OrgContext";
import { NS } from "../../i18n";
import { canManageAgentSharing, getAgentDisplayName, isAgentWritable } from "../../lib/agent-resource-access";
import {
  buildAgentPayload,
  buildKnowledgeFormState,
  filterKnowledgeBaseIds,
  getDefaultKnowledgeFormState,
  isValidAgentNameInput,
} from "../../lib/agent-utils";
import { dispatchConfigChange } from "../../lib/config-events";
import { getMcpDisplayName, getMcpKey } from "../../lib/mcp-resource-access";
import {
  getSkillOptionValue,
  normalizeSkillOptionsPayload,
  type SkillOptionView,
} from "../../lib/skill-resource-access";
import type { ModelEntry, ResourceAccess } from "../../types/config";
import type { KnowledgeBaseInfo } from "../../types/knowledge";

/** Agent 模板（从 API 返回） */
interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  skills: string[];
}

interface AgentFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  defaultName?: string;
  onSuccess?: () => void;
  agentName?: string;
}

interface AgentRelatedResourcesView {
  modelLabel?: string | null;
  machineLabel?: string | null;
  skills?: Array<{ id: string; label: string }>;
  mcps?: Array<{ id: string; label: string }>;
  knowledgeBases?: Array<{ id: string; label: string; slug?: string | null }>;
  siteApps?: Array<{ id: string; label: string; remoteAppId: string | null }>;
}

interface SiteOption {
  id: string;
  name: string;
  remoteAppId: string;
  description?: string | null;
}

interface AgentMcpOption {
  id: string;
  key: string;
  name: string;
  label: string;
  resourceAccess?: ResourceAccess;
}

/** 将可见 MCP server 列表转换为 Agent 表单选项，并过滤掉已禁用的项。 */
export function mapMcpOptions(
  servers: Array<{ id: string; name: string; enabled?: boolean; resourceAccess?: ResourceAccess }>,
): AgentMcpOption[] {
  return servers
    .filter((server) => server.enabled !== false)
    .map((server) => ({
      id: server.id,
      key: getMcpKey(server),
      name: server.name,
      label: getMcpDisplayName(server),
      resourceAccess: server.resourceAccess,
    }));
}

export function mapModelOptions(available: ModelEntry[]): { value: string; label: string }[] {
  return available.map((model) => {
    const source = model.providerResourceAccess?.sourceOrganizationName;
    const providerLabel = source ? `${source}/${model.providerDisplayName}` : model.providerDisplayName;
    return { value: model.id, label: `${providerLabel}/${model.displayName}` };
  });
}

/** 加载表单所有下拉/选项数据及编辑态回显 */
interface LoadedFormData {
  machineOptions: Array<{ id: string; agentName: string; hostname: string; name: string | null; status: string }>;
  siteOptions: SiteOption[];
  hindsightEnabled: boolean;
  modelOptions: Array<{ value: string; label: string }>;
  knowledgeOptions: KnowledgeBaseInfo[];
  skillOptions: SkillOptionView[];
  mcpOptions: AgentMcpOption[];
  templates: AgentTemplate[];
  // 创建模式：预选第一个模型
  initialModel?: string;
  // 编辑模式
  editState?: {
    agentId: string | null;
    displayName: string;
    modelId: string;
    prompt: string;
    description: string;
    machineId: string;
    engineType: string;
    resourceAccess?: ResourceAccess;
    publicReadable: boolean;
    relatedResources?: AgentRelatedResourcesView;
    knowledgeBaseIds: string[];
    searchFirst: boolean;
    maxResults: string;
    skillIds: string[];
    mcpIds: string[];
    siteAppIds: string[];
    enableMemory: boolean;
  };
}

export function AgentFormDialog({ open, onOpenChange, mode, defaultName, onSuccess, agentName }: AgentFormDialogProps) {
  const isEdit = mode === "edit";
  const { org } = useOrg();
  const { t } = useTranslation(NS.AGENTS);
  const { t: tAgentPanel } = useTranslation(NS.AGENT_PANEL);
  const { t: tComponents } = useTranslation(NS.COMPONENTS);

  // 下拉选项 state（由 loadFormData 填充）
  const [modelOptions, setModelOptions] = useState<{ value: string; label: string }[]>([]);
  const [knowledgeOptions, setKnowledgeOptions] = useState<KnowledgeBaseInfo[]>([]);
  const [skillOptions, setSkillOptions] = useState<SkillOptionView[]>([]);
  const [mcpOptions, setMcpOptions] = useState<AgentMcpOption[]>([]);
  const [machineOptions, setMachineOptions] = useState<
    { id: string; agentName: string; hostname: string; name: string | null; status: string }[]
  >([]);

  // 表单字段 state
  const [formName, setFormName] = useState("");
  const [formModel, setFormModel] = useState("");
  const [formPrompt, setFormPrompt] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formKnowledgeBaseIds, setFormKnowledgeBaseIds] = useState<string[]>([]);
  const [formKnowledgeSearchFirst, setFormKnowledgeSearchFirst] = useState(true);
  const [formKnowledgeMaxResults, setFormKnowledgeMaxResults] = useState("5");
  const [formSkillIds, setFormSkillIds] = useState<string[]>([]);
  const [formMcpIds, setFormMcpIds] = useState<string[]>([]);
  const [formSiteAppIds, setFormSiteAppIds] = useState<string[]>([]);
  const [formMachineId, setFormMachineId] = useState<string>("local");
  const [formEngineType, setFormEngineType] = useState<string>("opencode");
  const [formResourceAccess, setFormResourceAccess] = useState<ResourceAccess | undefined>(undefined);
  const [formPublicReadable, setFormPublicReadable] = useState(false);
  const [currentAgentId, setCurrentAgentId] = useState<string | null>(null);
  const [displayAgentName, setDisplayAgentName] = useState("");
  const [relatedResources, setRelatedResources] = useState<AgentRelatedResourcesView | undefined>(undefined);
  const [activeTab, setActiveTab] = useState<"basic" | "knowledge">("basic");
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [skillsExpanded, setSkillsExpanded] = useState(false);
  const [mcpsExpanded, setMcpsExpanded] = useState(false);
  const [sitesExpanded, setSitesExpanded] = useState(false);
  const [siteOptions, setSiteOptions] = useState<SiteOption[]>([]);
  const [hindsightEnabled, setHindsightEnabled] = useState(false);
  const [formEnableMemory, setFormEnableMemory] = useState(false);

  const [restartDialogOpen, setRestartDialogOpen] = useState(false);

  // 对话框打开时立即重置表单状态
  useEffect(() => {
    if (!open) return;
    setActiveTab("basic");
    const knowledgeDefaults = getDefaultKnowledgeFormState();
    setFormKnowledgeBaseIds(knowledgeDefaults.knowledgeBaseIds);
    setFormKnowledgeSearchFirst(knowledgeDefaults.searchFirst);
    setFormKnowledgeMaxResults(knowledgeDefaults.maxResults);
    setFormSkillIds([]);
    setFormMcpIds([]);
    setFormSiteAppIds([]);
    // 从组织 metadata 读取默认引擎设置
    if (!isEdit && org?.id) {
      (async () => {
        try {
          const detail = (await unwrap(orgApi.get(org.id))) as unknown as Record<string, unknown>;
          const metadata = detail.metadata as
            | { defaultEngine?: { engineType?: string; machineId?: string } }
            | null
            | undefined;
          const def = metadata?.defaultEngine;
          if (def?.machineId && def.machineId !== "") {
            setFormMachineId(def.machineId);
          } else {
            setFormMachineId("local");
          }
          if (def?.engineType) {
            setFormEngineType(def.engineType);
          }
        } catch {
          setFormMachineId("local");
        }
      })();
    } else {
      setFormMachineId("local");
      if (!isEdit) {
        setFormEngineType("opencode");
      }
    }
    setFormResourceAccess(undefined);
    setFormPublicReadable(false);
    setCurrentAgentId(null);
    setDisplayAgentName("");
    setRelatedResources(undefined);
    setSelectedTemplateId(null);
    setFormEnableMemory(false);
    setSkillsExpanded(false);
    setMcpsExpanded(false);
    setSitesExpanded(false);

    if (!isEdit) {
      setFormName(defaultName ?? "");
      setFormPrompt("");
      setFormDescription("");
      setFormPublicReadable(false);
      setSelectedTemplateId(null);
    }
  }, [open, isEdit, defaultName, org?.id]);

  // 主数据加载：下拉选项 + 编辑态回显
  const { loading } = useRequest(
    async (): Promise<LoadedFormData> => {
      // Hindsight 记忆 MCP 可用性
      let hindsightEnabledVal = false;
      try {
        const r = await fetch("/web/hindsight/status");
        const json = await r.json();
        hindsightEnabledVal = !!(json.success && json.data?.enabled);
      } catch {
        // 静默失败
      }

      // 在线机器列表
      const machines = (await unwrap(registryApi.list({ status: "online", limit: 100 })))?.items ?? [];
      const machineOptionsVal = machines.map((m) => ({
        id: m.id,
        agentName: m.agentName,
        hostname: (m.machineInfo as { hostname?: string } | null)?.hostname ?? "",
        name: m.name,
        status: m.status,
      }));

      // 可用 sites 选项
      let siteOptionsVal: SiteOption[] = [];
      try {
        const sites = (await unwrap(agentSitesApi.list())) as SiteApp[] | null;
        siteOptionsVal = (Array.isArray(sites) ? sites : [])
          .map((item) => ({
            id: item.id,
            name: item.name,
            remoteAppId: item.remoteAppId,
            description: item.description,
          }))
          .filter((item) => item.id && item.remoteAppId);
      } catch (err) {
        console.warn("[AgentFormDialog] 加载 sites 选项失败", err);
      }

      if (isEdit && agentName) {
        // 编辑模式：并行加载所有配置
        const [agentDetail, modelData, kbData, skillsData, mcpsData] = await Promise.all([
          unwrap(agentApi.get(agentName)),
          unwrap(modelApi.get()),
          unwrap(kbApi.list()),
          unwrap(skillConfigApi.list()),
          unwrap(mcpApi.list()),
        ]);

        const d = agentDetail as unknown as Record<string, unknown>;

        // 编辑模式回显：检查是否已关联 hindsight MCP
        let enableMemoryVal = false;
        try {
          const mcpCheck = await unwrap(mcpApi.list());
          const raw = mcpCheck as unknown as { servers?: Array<{ name: string }> } | Array<{ name: string }>;
          const servers = Array.isArray(raw) ? raw : (raw?.servers ?? []);
          const hasHindsight = servers.some((s) => s.name.toLowerCase().includes("hindsight"));
          enableMemoryVal = hasHindsight;
        } catch {
          // 静默失败
        }

        // 模型选项
        const modelOptionsVal = Array.isArray(modelData.available)
          ? mapModelOptions(modelData.available as ModelEntry[])
          : [];

        // 知识库选项
        const knowledgeOptionsVal = Array.isArray(kbData) ? (kbData as unknown as KnowledgeBaseInfo[]) : [];

        // Skill 选项
        const skillOptionsVal = normalizeSkillOptionsPayload(skillsData);

        // MCP 选项
        const mcpServers = Array.isArray(mcpsData)
          ? mcpsData
          : mcpsData && typeof mcpsData === "object" && Array.isArray((mcpsData as { servers?: unknown }).servers)
            ? ((mcpsData as { servers: Array<{ id?: string; name: string; resourceAccess?: ResourceAccess }> })
                .servers ?? [])
            : [];
        const mcpOptionsVal = mapMcpOptions(
          mcpServers.filter(
            (item): item is { id: string; name: string; enabled?: boolean; resourceAccess?: ResourceAccess } =>
              typeof item.id === "string" && item.id.length > 0,
          ),
        );

        // 模板列表
        let templatesVal: AgentTemplate[] = [];
        try {
          const tplData = await agentApi.templates();
          if (!tplData.error && tplData.data?.templates) {
            templatesVal = tplData.data.templates;
          }
        } catch {
          // 静默失败
        }

        const knowledgeState = buildKnowledgeFormState(d as Parameters<typeof buildKnowledgeFormState>[0]);

        return {
          machineOptions: machineOptionsVal,
          siteOptions: siteOptionsVal,
          hindsightEnabled: hindsightEnabledVal,
          modelOptions: modelOptionsVal,
          knowledgeOptions: knowledgeOptionsVal,
          skillOptions: skillOptionsVal,
          mcpOptions: mcpOptionsVal,
          templates: templatesVal,
          editState: {
            agentId: (d.id as string) ?? null,
            displayName: String(d.name ?? agentName ?? ""),
            modelId: (d.modelId as string) || "",
            prompt: String(d.prompt ?? ""),
            description: String(d.description ?? ""),
            machineId: (d.machineId as string) || "local",
            engineType: (d.engineType as string) ?? "opencode",
            resourceAccess: d.resourceAccess as ResourceAccess | undefined,
            publicReadable: Boolean((d.resourceAccess as ResourceAccess | undefined)?.publicReadable),
            relatedResources: (d.relatedResources as AgentRelatedResourcesView | undefined) ?? undefined,
            knowledgeBaseIds: knowledgeState.knowledgeBaseIds,
            searchFirst: knowledgeState.searchFirst,
            maxResults: knowledgeState.maxResults,
            skillIds: Array.isArray(d.skillIds) ? (d.skillIds as string[]) : [],
            mcpIds: Array.isArray(d.mcpIds) ? (d.mcpIds as string[]) : [],
            siteAppIds: Array.isArray(d.siteAppIds) ? (d.siteAppIds as string[]) : [],
            enableMemory: enableMemoryVal,
          },
        };
      }

      // 创建模式：分别加载各项选项
      let templatesVal: AgentTemplate[] = [];
      try {
        const tplData = await agentApi.templates();
        if (!tplData.error && tplData.data?.templates) {
          templatesVal = tplData.data.templates;
        }
      } catch {
        // 静默失败
      }

      const modelData = await unwrap(modelApi.get());
      const modelOptionsVal = Array.isArray(modelData.available)
        ? mapModelOptions(modelData.available as ModelEntry[])
        : [];

      const kbData = await unwrap(kbApi.list());
      const knowledgeOptionsVal = Array.isArray(kbData) ? (kbData as unknown as KnowledgeBaseInfo[]) : [];

      const skillsData = await unwrap(skillConfigApi.list());
      const skillOptionsVal = normalizeSkillOptionsPayload(skillsData);

      const mcpsData = await unwrap(mcpApi.list());
      const mcpServers = Array.isArray(mcpsData)
        ? mcpsData
        : mcpsData && typeof mcpsData === "object" && Array.isArray((mcpsData as { servers?: unknown }).servers)
          ? ((mcpsData as { servers: Array<{ id?: string; name: string; resourceAccess?: ResourceAccess }> }).servers ??
            [])
          : [];
      const mcpOptionsVal = mapMcpOptions(
        mcpServers.filter(
          (item): item is { id: string; name: string; enabled?: boolean; resourceAccess?: ResourceAccess } =>
            typeof item.id === "string" && item.id.length > 0,
        ),
      );

      return {
        machineOptions: machineOptionsVal,
        siteOptions: siteOptionsVal,
        hindsightEnabled: hindsightEnabledVal,
        modelOptions: modelOptionsVal,
        knowledgeOptions: knowledgeOptionsVal,
        skillOptions: skillOptionsVal,
        mcpOptions: mcpOptionsVal,
        templates: templatesVal,
        initialModel: modelOptionsVal[0]?.value || "",
      };
    },
    {
      ready: open && (!isEdit || !!agentName),
      refreshDeps: [open, isEdit, agentName, defaultName],
      onSuccess: (data) => {
        // 选项 state
        setMachineOptions(data.machineOptions);
        setSiteOptions(data.siteOptions);
        setHindsightEnabled(data.hindsightEnabled);
        setModelOptions(data.modelOptions);
        setKnowledgeOptions(data.knowledgeOptions);
        setSkillOptions(data.skillOptions);
        setMcpOptions(data.mcpOptions);
        setTemplates(data.templates);

        if (data.editState) {
          // 编辑模式：填充表单
          const es = data.editState;
          setCurrentAgentId(es.agentId);
          setDisplayAgentName(es.displayName);
          setFormModel(es.modelId);
          setFormPrompt(es.prompt);
          setFormDescription(es.description);
          setFormMachineId(es.machineId);
          setFormEngineType(es.engineType);
          setFormResourceAccess(es.resourceAccess);
          setFormPublicReadable(es.publicReadable);
          setRelatedResources(es.relatedResources);
          setFormKnowledgeBaseIds(es.knowledgeBaseIds);
          setFormKnowledgeSearchFirst(es.searchFirst);
          setFormKnowledgeMaxResults(es.maxResults);
          setFormSkillIds(es.skillIds);
          setFormMcpIds(es.mcpIds);
          setFormSiteAppIds(es.siteAppIds);
          setFormEnableMemory(es.enableMemory);
        } else if (!isEdit) {
          // 创建模式：预选第一个模型
          setFormModel(data.initialModel ?? "");
        }
      },
      onError: (err) => {
        console.error("Failed to load agent config:", err);
        toast.error(t("knowledge.loadError", { message: (err as Error).message }));
      },
    },
  );

  const validateForm = useCallback((): boolean => {
    if (!isEdit) {
      const name = formName.trim();
      if (!isValidAgentNameInput(name)) {
        toast.error(t("form.nameValidationError"));
        return false;
      }
    }
    const knowledgeMaxResults = parseInt(formKnowledgeMaxResults, 10);
    if (Number.isNaN(knowledgeMaxResults) || knowledgeMaxResults < 1 || knowledgeMaxResults > 20) {
      toast.error(t("knowledge.maxResultsValidationError"));
      return false;
    }
    return true;
  }, [isEdit, formName, formKnowledgeMaxResults, t]);

  const agentIdentityName = agentName ?? formName ?? "agent";
  const readOnlyAgent = isEdit && !isAgentWritable({ name: agentIdentityName, resourceAccess: formResourceAccess });
  const agentNameForDisplay = isEdit ? displayAgentName || agentName || "" : formName;
  const effectiveModelOptions =
    formModel && relatedResources?.modelLabel && !modelOptions.some((option) => option.value === formModel)
      ? [...modelOptions, { value: formModel, label: relatedResources.modelLabel }]
      : modelOptions;
  const effectiveMachineOptions =
    formMachineId &&
    formMachineId !== "local" &&
    relatedResources?.machineLabel &&
    !machineOptions.some((option) => option.id === formMachineId)
      ? [
          ...machineOptions,
          { id: formMachineId, agentName: relatedResources.machineLabel, hostname: "", name: null, status: "" },
        ]
      : machineOptions;
  const effectiveKnowledgeOptions =
    relatedResources?.knowledgeBases && relatedResources.knowledgeBases.length > 0
      ? [
          ...knowledgeOptions,
          ...relatedResources.knowledgeBases
            .filter((item) => !knowledgeOptions.some((option) => option.id === item.id))
            .map((item) => ({
              id: item.id,
              name: item.label,
              slug: item.slug ?? item.label,
              description: null,
              provider: "shared",
              remoteId: null,
              status: "ready",
              lastError: null,
              bindingsCount: 0,
              resourcesCount: 0,
              createdAt: 0,
              updatedAt: 0,
            })),
        ]
      : knowledgeOptions;
  const effectiveSkillOptions =
    relatedResources?.skills && relatedResources.skills.length > 0
      ? [
          ...skillOptions,
          ...relatedResources.skills
            .filter((item) => !skillOptions.some((option) => option.id === item.id || option.key === item.id))
            .map((item) => ({
              id: item.id,
              key: item.id,
              name: item.label,
              label: item.label,
              description: "",
              resourceAccess: undefined,
            })),
        ]
      : skillOptions;
  const selectedMcpOptions =
    relatedResources?.mcps && relatedResources.mcps.length > 0
      ? [
          ...mcpOptions,
          ...relatedResources.mcps
            .filter((item) => !mcpOptions.some((option) => option.id === item.id || option.key === item.id))
            .map((item) => ({
              id: item.id,
              key: item.id,
              name: item.label,
              label: item.label,
              resourceAccess: undefined,
            })),
        ]
      : mcpOptions;

  // 保存（创建/更新）
  const { run: runSave, loading: formSaving } = useRequest(
    async () => {
      if (readOnlyAgent) return;
      if (!validateForm()) return;

      if (isEdit) {
        // 编辑模式：先拉取最新知识库列表验证 ID
        let latestKnowledgeOptions = knowledgeOptions;
        const kbData = await unwrap(kbApi.list());
        if (kbData) {
          latestKnowledgeOptions = (Array.isArray(kbData) ? kbData : []) as unknown as typeof knowledgeOptions;
          setKnowledgeOptions(latestKnowledgeOptions);
        }
        const validKnowledgeBaseIds = filterKnowledgeBaseIds(formKnowledgeBaseIds, latestKnowledgeOptions);
        if (validKnowledgeBaseIds.length !== formKnowledgeBaseIds.length) {
          setFormKnowledgeBaseIds(validKnowledgeBaseIds);
        }
        const data: Record<string, unknown> = {
          ...buildAgentPayload({
            modelId: formModel,
            prompt: formPrompt,
            description: formDescription,
            engineType: formEngineType,
            knowledge: {
              knowledgeBaseIds: validKnowledgeBaseIds,
              searchFirst: formKnowledgeSearchFirst,
              maxResults: formKnowledgeMaxResults,
            },
          }),
          skillIds: formSkillIds,
          mcpIds: formMcpIds,
          siteAppIds: formSiteAppIds,
          machineId: formMachineId === "local" ? null : formMachineId,
          publicReadable: formPublicReadable,
          ...(formEnableMemory ? { enableMemory: true } : {}),
        };

        await unwrap(agentApi.set(agentName!, data));
        toast.success(t("save.successUpdate"));
        dispatchConfigChange("agents");
        setRestartDialogOpen(true);
      } else {
        // 创建模式
        const name = formName.trim();
        await unwrap(
          agentApi.create(name, {
            ...buildAgentPayload({
              modelId: formModel,
              prompt: formPrompt,
              description: formDescription,
              engineType: formEngineType,
              knowledge: {
                knowledgeBaseIds: formKnowledgeBaseIds,
                searchFirst: formKnowledgeSearchFirst,
                maxResults: formKnowledgeMaxResults,
              },
            }),
            skillIds: formSkillIds,
            mcpIds: formMcpIds,
            siteAppIds: formSiteAppIds,
            machineId: formMachineId === "local" ? null : formMachineId,
            publicReadable: formPublicReadable,
            ...(formEnableMemory ? { enableMemory: true } : {}),
          }),
        );
        toast.success(t("save.successCreate"));
        onOpenChange(false);
        onSuccess?.();
        dispatchConfigChange("agents");
      }
    },
    {
      manual: true,
      onError: (e) => {
        console.error(t("save.errorGeneric", { message: "" }), e);
        toast.error(t("save.errorGeneric", { message: e instanceof Error ? e.message : t("unknownError") }));
      },
    },
  );

  // 获取运行中实例 ID 列表
  const getRunningInstanceIds = useCallback(async () => {
    if (!agentName) return [];
    try {
      const agentsResult = await unwrap(agentApi.list());
      const rawAgents = agentsResult.agents;
      const agents = Array.isArray(rawAgents) ? rawAgents : [];
      const matchedAgent =
        agents.find((a) => currentAgentId && a.id === currentAgentId) ??
        agents.find((a) => a.name === agentName && a.resourceAccess?.resourceKey === formResourceAccess?.resourceKey) ??
        agents.find((a) => a.name === agentName);
      if (!matchedAgent) return [];

      const envs = await unwrap(envApi.list());
      const matchedEnv = (envs as unknown as { id: string; agentConfigId?: string; instancesCount?: number }[]).find(
        (e) => e.agentConfigId === matchedAgent.id,
      );
      if (!matchedEnv || (matchedEnv.instancesCount ?? 0) <= 0) return [];

      const instData = await unwrap(envApi.listInstances({ id: matchedEnv.id }));
      const instances =
        (instData as unknown as { instances?: { id: string; status: string }[] } | null)?.instances ?? [];
      return instances
        .filter((inst) => inst.status === "running" || inst.status === "starting")
        .map((inst) => ({ id: inst.id, environmentId: matchedEnv.id }));
    } catch (err) {
      console.error("Failed to get running instances:", err);
      return [];
    }
  }, [agentName, currentAgentId, formResourceAccess?.resourceKey]);

  // 保存后重启
  const { run: runRestart, loading: restarting } = useRequest(
    async () => {
      const runningInstances = await getRunningInstanceIds();
      for (const inst of runningInstances) {
        await unwrap(instanceApi.delete({ id: inst.id }));
        await unwrap(instanceApi.spawn({ environmentId: inst.environmentId }));
        // 通知 ChatPanel 和 ArtifactsPanel 重新连接/重置状态
        window.dispatchEvent(new CustomEvent("agent:reconnect", { detail: { envId: inst.environmentId } }));
      }
      toast.success(tAgentPanel("restartSuccess"));
      setRestartDialogOpen(false);
      onOpenChange(false);
    },
    {
      manual: true,
      onError: (err) => {
        console.error("Failed to restart:", err);
        toast.error(tAgentPanel("restartFailed", { message: (err as Error).message }));
      },
    },
  );

  if (!open) return null;

  const title = isEdit ? (readOnlyAgent ? t("dialog.detailTitle") : t("dialog.editTitle")) : t("dialog.createTitle");
  const confirmLabel = formSaving ? "..." : isEdit ? t("actions.save") : t("dialog.createConfirm");
  const selectedModelLabel = effectiveModelOptions.find((option) => option.value === formModel)?.label;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-surface-0 rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col border border-border-subtle">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle flex-shrink-0">
          <h3 className="text-lg font-semibold text-text-bright">{title}</h3>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="text-text-muted hover:text-text-primary text-lg cursor-pointer"
          >
            ✕
          </button>
        </div>

        {isEdit && loading ? (
          <div className="flex items-center justify-center py-12 text-text-muted text-sm">
            {t("knowledge.loadError", { message: "" }).replace(": {{message}}", "")}...
          </div>
        ) : (
          <>
            {readOnlyAgent && (
              <div className="mx-6 mt-6 rounded-lg border border-border-subtle bg-surface-1 px-4 py-3 text-sm text-text-muted">
                <p className="font-medium text-text-bright">{t("resource.sharedSourceTitle")}</p>
                <p className="mt-1">
                  {t("resource.readOnlyAgent", {
                    source: getAgentDisplayName({ name: agentNameForDisplay, resourceAccess: formResourceAccess }),
                  })}
                </p>
              </div>
            )}
            {/* Tabs */}
            <div className="flex gap-1 rounded-lg bg-surface-2 p-1 m-6 mb-0 flex-shrink-0">
              {(["basic", "knowledge"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${activeTab === tab ? "bg-surface-1 text-text-primary shadow-sm" : "text-text-muted hover:text-text-secondary"}`}
                  onClick={() => setActiveTab(tab)}
                >
                  {t(`dialog.tabs.${tab}`)}
                </button>
              ))}
            </div>

            {/* 内容 */}
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {activeTab === "basic" && (
                <div className="space-y-4">
                  <div>
                    <Label>{t("form.name")}</Label>
                    {isEdit ? (
                      <Input value={agentNameForDisplay} disabled className="mt-1" />
                    ) : (
                      <Input
                        value={formName}
                        onChange={(e) => setFormName(e.target.value)}
                        placeholder={t("form.namePlaceholder")}
                        className="mt-1"
                        disabled={readOnlyAgent}
                      />
                    )}
                  </div>
                  {isEdit && currentAgentId && (
                    <div>
                      <Label>Agent ID</Label>
                      <div className="mt-1 flex items-center gap-2">
                        <Input value={currentAgentId} disabled className="flex-1 font-mono text-xs text-text-muted" />
                        <button
                          type="button"
                          className="shrink-0 px-2 py-1.5 text-xs rounded-md border border-border bg-surface-2 text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
                          onClick={() => {
                            navigator.clipboard.writeText(currentAgentId).catch(() => {});
                          }}
                          title="复制 Agent ID"
                        >
                          复制
                        </button>
                      </div>
                    </div>
                  )}
                  <div>
                    <Label>{t("form.description")}</Label>
                    <Input
                      value={formDescription}
                      onChange={(e) => setFormDescription(e.target.value)}
                      placeholder={t("form.descriptionPlaceholder")}
                      className="mt-1"
                      disabled={readOnlyAgent}
                    />
                  </div>
                  <div>
                    <Label>{t("form.model")}</Label>
                    <Select value={formModel} onValueChange={setFormModel} disabled={readOnlyAgent}>
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder={t("form.modelPlaceholder")}>
                          {selectedModelLabel ?? formModel}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {effectiveModelOptions.map((m) => (
                          <SelectItem key={m.value} value={m.value}>
                            {m.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>{t("form.prompt")}</Label>
                    <Textarea
                      value={formPrompt}
                      onChange={(e) => setFormPrompt(e.target.value)}
                      rows={4}
                      placeholder={t("form.promptPlaceholder")}
                      className="mt-1"
                      disabled={readOnlyAgent}
                    />
                  </div>
                  <div>
                    <Label>{t("form.machine")}</Label>
                    <Select value={formMachineId} onValueChange={setFormMachineId} disabled={readOnlyAgent}>
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder={t("form.machinePlaceholder")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="local">{t("form.machineLocal")}</SelectItem>
                        {effectiveMachineOptions.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.name || m.hostname || m.agentName} ({m.id.slice(0, 8)}){" "}
                            {m.status === "online"
                              ? tAgentPanel("machineStatus.online", "在线")
                              : tAgentPanel("machineStatus.offline", "离线")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>{t("form.engineType")}</Label>
                    <Select value={formEngineType} onValueChange={setFormEngineType} disabled={readOnlyAgent}>
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder={t("form.engineTypePlaceholder")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="opencode">OpenCode</SelectItem>
                        <SelectItem value="ccb">CCB</SelectItem>
                        <SelectItem value="claude-code">Claude Code</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {templates.length > 0 && (
                    <div>
                      <Label className="mb-2 block">{t("templates.title")}</Label>
                      <div className="grid grid-cols-2 gap-2">
                        {templates.map((tpl) => (
                          <button
                            key={tpl.id}
                            type="button"
                            onClick={() => {
                              setFormPrompt(tpl.prompt);
                              if (!isEdit) setFormName(tpl.name);
                              setSelectedTemplateId(tpl.id);
                              if (tpl.skills.length > 0) {
                                const matchedSkillIds = tpl.skills
                                  .map((skillName) => {
                                    const found = effectiveSkillOptions.find(
                                      (s) => s.name === skillName || s.label === skillName,
                                    );
                                    return found ? getSkillOptionValue(found) : null;
                                  })
                                  .filter((v): v is string => v !== null);
                                if (matchedSkillIds.length > 0) {
                                  setFormSkillIds(matchedSkillIds);
                                }
                              }
                            }}
                            className={`text-left rounded-lg border px-3 py-2.5 transition-colors cursor-pointer ${
                              selectedTemplateId === tpl.id
                                ? "border-primary bg-primary/5 text-text-bright"
                                : "border-border-subtle hover:border-primary/40 text-text-secondary hover:text-text-bright"
                            }`}
                          >
                            <p className="text-sm font-medium">{tpl.name}</p>
                            <p className="text-xs text-text-muted mt-0.5 line-clamp-2">{tpl.description}</p>
                            {tpl.skills.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-1">
                                {tpl.skills.map((s) => (
                                  <span
                                    key={s}
                                    className="inline-block rounded bg-primary/10 text-primary text-[10px] px-1.5 py-0.5"
                                  >
                                    {s}
                                  </span>
                                ))}
                              </div>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* 技能绑定 - 折叠展示 */}
                  <div className="rounded-lg border border-border-subtle p-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-text-bright">{t("skills.tabTitle")}</p>
                        <p className="text-xs text-text-muted">
                          {t("skills.selectedCount", { count: formSkillIds.length })}
                        </p>
                      </div>
                      {!readOnlyAgent && (
                        <button
                          type="button"
                          onClick={() => setSkillsExpanded(!skillsExpanded)}
                          className="rounded-md p-1 hover:bg-surface-2 text-text-muted hover:text-text-primary transition-colors"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                    {/* 已选技能 badge */}
                    {formSkillIds.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {formSkillIds.map((sid) => {
                          const skill = effectiveSkillOptions.find((s) => getSkillOptionValue(s) === sid);
                          return (
                            <span
                              key={sid}
                              className="inline-flex items-center gap-1 rounded bg-primary/10 text-primary text-xs px-2 py-0.5"
                            >
                              {skill?.label ?? sid}
                              {!readOnlyAgent && (
                                <button
                                  type="button"
                                  onClick={() => setFormSkillIds((cur) => cur.filter((id) => id !== sid))}
                                  className="hover:text-text-bright"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              )}
                            </span>
                          );
                        })}
                      </div>
                    )}
                    {/* 展开的完整技能列表 */}
                    {skillsExpanded && (
                      <div className="mt-3 space-y-2 border-t border-border-subtle pt-3">
                        {effectiveSkillOptions.length === 0 ? (
                          <p className="text-sm text-text-muted">{t("skills.noOptions")}</p>
                        ) : (
                          effectiveSkillOptions.map((item) => {
                            const value = getSkillOptionValue(item);
                            const checked = formSkillIds.includes(value);
                            return (
                              <label
                                key={item.key}
                                className="flex items-center justify-between gap-3 rounded-md border border-border-subtle px-3 py-2 text-sm"
                              >
                                <div>
                                  <p className="font-medium text-text-bright">{item.label}</p>
                                  {item.description && <p className="text-xs text-text-muted">{item.description}</p>}
                                </div>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={readOnlyAgent}
                                  onChange={(e) => {
                                    setFormSkillIds((current) =>
                                      e.target.checked ? [...current, value] : current.filter((id) => id !== value),
                                    );
                                  }}
                                />
                              </label>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                  <div className="rounded-lg border border-border-subtle p-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-text-bright">{t("mcps.tabTitle")}</p>
                        <p className="text-xs text-text-muted">
                          {t("mcps.selectedCount", { count: formMcpIds.length })}
                        </p>
                      </div>
                      {!readOnlyAgent && (
                        <button
                          type="button"
                          onClick={() => setMcpsExpanded(!mcpsExpanded)}
                          className="rounded-md p-1 hover:bg-surface-2 text-text-muted hover:text-text-primary transition-colors"
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                    {formMcpIds.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {formMcpIds.map((mcpId) => {
                          const mcp = selectedMcpOptions.find((item) => item.id === mcpId);
                          return (
                            <span
                              key={mcpId}
                              className="inline-flex items-center gap-1 rounded bg-primary/10 text-primary text-xs px-2 py-0.5"
                            >
                              {mcp?.label ?? mcpId}
                              {!readOnlyAgent && (
                                <button
                                  type="button"
                                  onClick={() => setFormMcpIds((current) => current.filter((id) => id !== mcpId))}
                                  className="hover:text-text-bright"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              )}
                            </span>
                          );
                        })}
                      </div>
                    )}
                    {mcpsExpanded && (
                      <div className="mt-3 space-y-2 border-t border-border-subtle pt-3">
                        {mcpOptions.length === 0 ? (
                          <p className="text-sm text-text-muted">{t("mcps.noOptions")}</p>
                        ) : (
                          mcpOptions.map((item) => {
                            const checked = formMcpIds.includes(item.id);
                            return (
                              <label
                                key={item.key}
                                className="flex items-center justify-between gap-3 rounded-md border border-border-subtle px-3 py-2 text-sm"
                              >
                                <div>
                                  <p className="font-medium text-text-bright">{item.label}</p>
                                </div>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={readOnlyAgent}
                                  onChange={(e) => {
                                    setFormMcpIds((current) =>
                                      e.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id),
                                    );
                                  }}
                                />
                              </label>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                  <div className="rounded-lg border border-border-subtle p-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-text-bright">{t("sites.tabTitle")}</p>
                        <p className="text-xs text-text-muted">
                          {t("sites.selectedCount", { count: formSiteAppIds.length })}
                        </p>
                      </div>
                      {!readOnlyAgent && (
                        <button
                          type="button"
                          onClick={() => setSitesExpanded(!sitesExpanded)}
                          className="rounded-md p-1 hover:bg-surface-2 text-text-muted hover:text-text-primary transition-colors"
                          aria-label={t("sites.toggleList")}
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                    {formSiteAppIds.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {formSiteAppIds.map((siteId) => {
                          const site = siteOptions.find((item) => item.id === siteId);
                          return (
                            <span
                              key={siteId}
                              className="inline-flex items-center gap-1 rounded bg-primary/10 text-primary text-xs px-2 py-0.5"
                            >
                              {site?.name ?? siteId}
                              {!readOnlyAgent && (
                                <button
                                  type="button"
                                  onClick={() => setFormSiteAppIds((current) => current.filter((id) => id !== siteId))}
                                  className="hover:text-text-bright"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              )}
                            </span>
                          );
                        })}
                      </div>
                    )}
                    {sitesExpanded && (
                      <div className="mt-3 space-y-2 border-t border-border-subtle pt-3">
                        {siteOptions.length === 0 ? (
                          <p className="text-sm text-text-muted">{t("sites.noOptions")}</p>
                        ) : (
                          siteOptions.map((item) => {
                            const checked = formSiteAppIds.includes(item.id);
                            return (
                              <label
                                key={item.id}
                                className="flex items-center justify-between gap-3 rounded-md border border-border-subtle px-3 py-2 text-sm"
                              >
                                <div className="min-w-0">
                                  <p className="font-medium text-text-bright truncate">{item.name}</p>
                                  <p className="text-xs text-text-muted truncate font-mono">{item.remoteAppId}</p>
                                </div>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={readOnlyAgent}
                                  onChange={(e) => {
                                    setFormSiteAppIds((current) =>
                                      e.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id),
                                    );
                                  }}
                                />
                              </label>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                  {hindsightEnabled && (
                    <label className="flex items-center justify-between gap-3 rounded-md border border-border-subtle px-3 py-2 text-sm">
                      <div>
                        <p className="font-medium text-text-bright">{t("memory.enableTitle")}</p>
                        <p className="text-xs text-text-muted">{t("memory.enableDescription")}</p>
                      </div>
                      <Switch
                        checked={formEnableMemory}
                        disabled={readOnlyAgent}
                        onCheckedChange={setFormEnableMemory}
                      />
                    </label>
                  )}
                  {(canManageAgentSharing({ name: agentIdentityName, resourceAccess: formResourceAccess }) ||
                    !isEdit) && (
                    <label className="flex items-center justify-between gap-3 rounded-md border border-border-subtle px-3 py-2 text-sm">
                      <div>
                        <p className="font-medium text-text-bright">{tComponents("resource.public")}</p>
                        <p className="text-xs text-text-muted">{t("resource.publicDescription")}</p>
                      </div>
                      <Switch
                        checked={formPublicReadable}
                        disabled={
                          readOnlyAgent ||
                          (isEdit &&
                            !canManageAgentSharing({ name: agentIdentityName, resourceAccess: formResourceAccess }))
                        }
                        onCheckedChange={setFormPublicReadable}
                      />
                    </label>
                  )}
                </div>
              )}
              {activeTab === "knowledge" && (
                <div className="space-y-4">
                  <div className="rounded-lg border border-border-subtle p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-text-bright">{t("knowledge.bindTitle")}</p>
                        <p className="text-xs text-text-muted">
                          {t("knowledge.selectedCount", { count: formKnowledgeBaseIds.length })}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 space-y-2">
                      {effectiveKnowledgeOptions.length === 0 ? (
                        <p className="text-sm text-text-muted">{t("knowledge.noOptions")}</p>
                      ) : (
                        effectiveKnowledgeOptions.map((item) => {
                          const checked = formKnowledgeBaseIds.includes(item.id);
                          return (
                            <label
                              key={item.id}
                              className="flex items-center justify-between gap-3 rounded-md border border-border-subtle px-3 py-2 text-sm"
                            >
                              <div>
                                <p className="font-medium text-text-bright">{item.name}</p>
                                <p className="text-xs text-text-muted">{item.slug}</p>
                              </div>
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={readOnlyAgent}
                                onChange={(e) => {
                                  setFormKnowledgeBaseIds((current) =>
                                    e.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id),
                                  );
                                }}
                              />
                            </label>
                          );
                        })
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={formKnowledgeSearchFirst}
                        disabled={readOnlyAgent}
                        onChange={(e) => setFormKnowledgeSearchFirst(e.target.checked)}
                      />
                      {t("knowledge.searchFirst")}
                    </label>
                    <div>
                      <Label>{t("knowledge.maxResults")}</Label>
                      <Input
                        type="number"
                        min={1}
                        max={20}
                        value={formKnowledgeMaxResults}
                        disabled={readOnlyAgent}
                        onChange={(e) => setFormKnowledgeMaxResults(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 底部 */}
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-border-subtle flex-shrink-0">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("dialog.cancel") ?? "Cancel"}
              </Button>
              <Button onClick={() => runSave()} disabled={formSaving || readOnlyAgent}>
                {readOnlyAgent ? t("actions.view") : confirmLabel}
              </Button>
            </div>
          </>
        )}
      </div>

      {/* 编辑后重启确认 */}
      {isEdit && (
        <AlertDialog
          open={restartDialogOpen}
          onOpenChange={(open) => {
            if (!open) {
              setRestartDialogOpen(false);
              onOpenChange(false);
            }
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{tAgentPanel("configSavedRestartTitle")}</AlertDialogTitle>
              <AlertDialogDescription>{tAgentPanel("configSavedRestartDescription")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                onClick={() => {
                  setRestartDialogOpen(false);
                  onOpenChange(false);
                }}
              >
                {tAgentPanel("restartLater")}
              </AlertDialogCancel>
              <AlertDialogAction onClick={() => runRestart()} disabled={restarting}>
                {restarting ? tAgentPanel("restarting") : tAgentPanel("restart")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
