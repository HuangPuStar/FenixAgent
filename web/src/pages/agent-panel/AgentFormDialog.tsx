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
import { agentExpertApi } from "@/src/api/agent-experts";
import { agentApi } from "@/src/api/agents";
import { envApi } from "@/src/api/environments";
import { instanceApi } from "@/src/api/instances";
import { kbApi } from "@/src/api/knowledge-bases";
import { mcpApi } from "@/src/api/mcp";
import { modelApi } from "@/src/api/models";
import { registryApi } from "@/src/api/registry";
import { unwrap } from "@/src/api/request";
import { type SandboxPoolOption, sandboxPoolApi } from "@/src/api/sandbox-pools";
import { agentSitesApi, type SiteApp } from "@/src/api/sites";
import { skillConfigApi } from "@/src/api/skills";
import { NS } from "../../i18n";
import {
  type AgentNodeSelection,
  agentNodeToSelection,
  selectionToAgentNode,
  selectionToValue,
  valueToSelection,
} from "../../lib/agent-node";
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
import type { AgentExpert, AgentNode, ModelEntry, ResourceAccess } from "../../types/config";
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
  onSuccess?: (agentConfigId?: string) => void;
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
  sandboxPoolOptions: SandboxPoolOption[];
  sandboxEnabled: boolean;
  siteOptions: SiteOption[];
  hindsightEnabled: boolean;
  modelOptions: Array<{ value: string; label: string }>;
  knowledgeOptions: KnowledgeBaseInfo[];
  skillOptions: SkillOptionView[];
  mcpOptions: AgentMcpOption[];
  templates: AgentTemplate[];
  /** 专家选项（内置 + 本组织，默认排除 disabled） */
  expertOptions?: AgentExpert[];
  // 创建模式：预选第一个模型
  initialModel?: string;
  // 编辑模式
  editState?: {
    agentId: string | null;
    displayName: string;
    modelId: string;
    prompt: string;
    description: string;
    agentNode: AgentNodeSelection;
    resourceAccess?: ResourceAccess;
    publicReadable: boolean;
    relatedResources?: AgentRelatedResourcesView;
    knowledgeBaseIds: string[];
    searchFirst: boolean;
    maxResults: string;
    skillIds: string[];
    mcpIds: string[];
    siteAppIds: string[];
    expertIds: string[];
    /** 预选模型 UUID 列表；null=未配置（存量，保持引擎自报） */
    modelIds: string[] | null;
    enableMemory: boolean;
    extra: unknown | null;
  };
}

export function AgentFormDialog({ open, onOpenChange, mode, defaultName, onSuccess, agentName }: AgentFormDialogProps) {
  const isEdit = mode === "edit";
  const { t } = useTranslation(NS.AGENTS);
  const { t: tAgentPanel } = useTranslation(NS.AGENT_PANEL);
  const { t: tComponents } = useTranslation(NS.COMPONENTS);

  // 下拉选项 state（由 loadFormData 填充）
  const [modelOptions, setModelOptions] = useState<{ value: string; label: string }[]>([]);
  const [_availableModels, setAvailableModels] = useState<ModelEntry[]>([]);
  const [knowledgeOptions, setKnowledgeOptions] = useState<KnowledgeBaseInfo[]>([]);
  const [skillOptions, setSkillOptions] = useState<SkillOptionView[]>([]);
  const [mcpOptions, setMcpOptions] = useState<AgentMcpOption[]>([]);
  const [machineOptions, setMachineOptions] = useState<
    { id: string; agentName: string; hostname: string; name: string | null; status: string }[]
  >([]);
  const [sandboxPoolOptions, setSandboxPoolOptions] = useState<SandboxPoolOption[]>([]);
  const [sandboxEnabled, setSandboxEnabled] = useState(false);

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
  // 专家（subagent）引用与预选模型（设计 §3/§5）
  const [formExpertIds, setFormExpertIds] = useState<string[]>([]);
  const [expertOptions, setExpertOptions] = useState<AgentExpert[]>([]);
  const [expertsExpanded, setExpertsExpanded] = useState(false);
  const [formModelIds, setFormModelIds] = useState<string[]>([]);
  /** 是否显式配置过预选列表（区分存量 null 与空数组单模型，保存时决定是否传 modelIds） */
  const [presetTouched, setPresetTouched] = useState(false);
  const [presetExpanded, setPresetExpanded] = useState(false);
  const [formAgentNode, setFormAgentNode] = useState<AgentNodeSelection>({ kind: "default" });
  const [formResourceAccess, setFormResourceAccess] = useState<ResourceAccess | undefined>(undefined);
  const [formPublicReadable, setFormPublicReadable] = useState(false);
  const [currentAgentId, setCurrentAgentId] = useState<string | null>(null);
  const [displayAgentName, setDisplayAgentName] = useState("");
  const [relatedResources, setRelatedResources] = useState<AgentRelatedResourcesView | undefined>(undefined);
  const [activeTab, setActiveTab] = useState<"basic" | "knowledge" | "advanced">("basic");
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [skillsExpanded, setSkillsExpanded] = useState(false);
  const [mcpsExpanded, setMcpsExpanded] = useState(false);
  const [sitesExpanded, setSitesExpanded] = useState(false);
  const [siteOptions, setSiteOptions] = useState<SiteOption[]>([]);
  const [hindsightEnabled, setHindsightEnabled] = useState(false);
  const [formEnableMemory, setFormEnableMemory] = useState(false);
  const [formExtra, setFormExtra] = useState("");

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
    setFormExpertIds([]);
    setFormModelIds([]);
    setPresetTouched(false);
    setExpertsExpanded(false);
    setPresetExpanded(false);
    setFormAgentNode({ kind: "default" });
    setFormResourceAccess(undefined);
    setFormPublicReadable(false);
    setCurrentAgentId(null);
    setDisplayAgentName("");
    setRelatedResources(undefined);
    setSelectedTemplateId(null);
    setFormEnableMemory(false);
    setFormExtra("");
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
  }, [open, isEdit, defaultName]);

  // 主数据加载：下拉选项 + 编辑态回显
  const { loading } = useRequest(
    async (): Promise<LoadedFormData> => {
      // Hindsight 状态
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

      let sandboxPoolOptionsVal: SandboxPoolOption[] = [];
      let sandboxEnabledVal = false;
      try {
        const poolData = await unwrap(sandboxPoolApi.list());
        sandboxEnabledVal = poolData?.enabled === true;
        sandboxPoolOptionsVal = poolData?.pools ?? [];
      } catch {
        // 沙盒配置不可用时不影响 Machine 选项。
      }

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
        const enableMemoryVal = Boolean(d.enableMemory);

        // 模型选项
        const modelOptionsVal = Array.isArray(modelData.available) ? (modelData.available as ModelEntry[]) : [];
        if (modelOptionsVal.length > 0) {
          setAvailableModels(modelOptionsVal);
        }

        // 知识库选项
        const knowledgeOptionsVal: KnowledgeBaseInfo[] = Array.isArray(kbData)
          ? (kbData as unknown as KnowledgeBaseInfo[])
          : [];

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

        // 专家选项（内置 + 本组织，默认排除 disabled）
        let expertOptionsVal: AgentExpert[] = [];
        try {
          const expertsData = await unwrap(agentExpertApi.list(true));
          expertOptionsVal = expertsData?.experts ?? [];
        } catch (err) {
          console.warn("[AgentFormDialog] 加载专家选项失败", err);
        }

        return {
          machineOptions: machineOptionsVal,
          sandboxPoolOptions: sandboxPoolOptionsVal,
          sandboxEnabled: sandboxEnabledVal,
          siteOptions: siteOptionsVal,
          hindsightEnabled: hindsightEnabledVal,
          modelOptions: mapModelOptions(modelOptionsVal),
          knowledgeOptions: knowledgeOptionsVal,
          skillOptions: skillOptionsVal,
          mcpOptions: mcpOptionsVal,
          templates: templatesVal,
          expertOptions: expertOptionsVal,
          editState: {
            agentId: (d.id as string) ?? null,
            displayName: String(d.name ?? agentName ?? ""),
            modelId: (d.modelId as string) || "",
            prompt: String(d.prompt ?? ""),
            description: String(d.description ?? ""),
            agentNode: agentNodeToSelection(d.agentNode as AgentNode | null | undefined),
            resourceAccess: d.resourceAccess as ResourceAccess | undefined,
            publicReadable: Boolean((d.resourceAccess as ResourceAccess | undefined)?.publicReadable),
            relatedResources: (d.relatedResources as AgentRelatedResourcesView | undefined) ?? undefined,
            knowledgeBaseIds: knowledgeState.knowledgeBaseIds,
            searchFirst: knowledgeState.searchFirst,
            maxResults: knowledgeState.maxResults,
            skillIds: Array.isArray(d.skillIds) ? (d.skillIds as string[]) : [],
            mcpIds: Array.isArray(d.mcpIds) ? (d.mcpIds as string[]) : [],
            siteAppIds: Array.isArray(d.siteAppIds) ? (d.siteAppIds as string[]) : [],
            expertIds: Array.isArray(d.expertIds) ? (d.expertIds as string[]) : [],
            // 预选模型回显：null/undefined（存量未配置）统一归一为 null，
            // 表单留空且不标记 touched，保存时不传 modelIds 保持引擎自报
            modelIds: Array.isArray(d.modelIds) ? (d.modelIds as string[]) : null,
            enableMemory: enableMemoryVal,
            extra: d.extra ?? null,
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
      if (Array.isArray(modelData.available)) {
        const entries = modelData.available as unknown as ModelEntry[];
        setAvailableModels(entries);
        setModelOptions(mapModelOptions(entries));
      }
      const modelOptionsVal = Array.isArray(modelData.available)
        ? mapModelOptions(modelData.available as ModelEntry[])
        : [];

      const kbData = await unwrap(kbApi.list());
      const knowledgeOptionsVal: KnowledgeBaseInfo[] = Array.isArray(kbData)
        ? (kbData as unknown as KnowledgeBaseInfo[])
        : [];

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

      // 专家选项（创建模式同样需要，内置 + 本组织，默认排除 disabled）
      let expertOptionsVal: AgentExpert[] = [];
      try {
        const expertsData = await unwrap(agentExpertApi.list(true));
        expertOptionsVal = expertsData?.experts ?? [];
      } catch (err) {
        console.warn("[AgentFormDialog] 加载专家选项失败", err);
      }

      return {
        machineOptions: machineOptionsVal,
        sandboxPoolOptions: sandboxPoolOptionsVal,
        sandboxEnabled: sandboxEnabledVal,
        siteOptions: siteOptionsVal,
        hindsightEnabled: hindsightEnabledVal,
        modelOptions: modelOptionsVal,
        knowledgeOptions: knowledgeOptionsVal,
        skillOptions: skillOptionsVal,
        mcpOptions: mcpOptionsVal,
        templates: templatesVal,
        expertOptions: expertOptionsVal,
        initialModel: modelOptionsVal[0]?.value || "",
      };
    },
    {
      ready: open && (!isEdit || !!agentName),
      refreshDeps: [open, isEdit, agentName, defaultName],
      onSuccess: (data) => {
        // 选项 state
        setMachineOptions(data.machineOptions);
        setSandboxPoolOptions(data.sandboxPoolOptions);
        setSandboxEnabled(data.sandboxEnabled);
        setSiteOptions(data.siteOptions);
        setHindsightEnabled(data.hindsightEnabled);
        setModelOptions(data.modelOptions);
        setKnowledgeOptions(data.knowledgeOptions);
        setSkillOptions(data.skillOptions);
        setMcpOptions(data.mcpOptions);
        setTemplates(data.templates);
        if (data.expertOptions) setExpertOptions(data.expertOptions);

        if (data.editState) {
          // 编辑模式：填充表单
          const es = data.editState;
          setCurrentAgentId(es.agentId);
          setDisplayAgentName(es.displayName);
          setFormModel(es.modelId);
          setFormPrompt(es.prompt);
          setFormDescription(es.description);
          setFormAgentNode(es.agentNode);
          setFormResourceAccess(es.resourceAccess);
          setFormPublicReadable(es.publicReadable);
          setRelatedResources(es.relatedResources);
          setFormKnowledgeBaseIds(es.knowledgeBaseIds);
          setFormKnowledgeSearchFirst(es.searchFirst);
          setFormKnowledgeMaxResults(es.maxResults);
          setFormSkillIds(es.skillIds);
          setFormMcpIds(es.mcpIds);
          setFormSiteAppIds(es.siteAppIds);
          setFormExpertIds(es.expertIds);
          // 预选模型回显：null（存量未配置）→ 表单留空且不标记 touched，
          // 保存时不传 modelIds 保持引擎自报（兼容不变量，避免 null 被改写成 []）
          setFormModelIds(es.modelIds ?? []);
          setPresetTouched(es.modelIds !== null);
          setFormEnableMemory(es.enableMemory);
          setFormExtra(es.extra ? JSON.stringify(es.extra, null, 2) : "");
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
    if (formExtra.trim()) {
      try {
        JSON.parse(formExtra);
      } catch {
        toast.error(t("form.extraValidationError"));
        return false;
      }
    }
    // 预选模型一致性（设计 §5.1）：预选列表非空时默认模型必须 ∈ 预选；
    // 空数组 = 单模型（默认模型即唯一模型），存量 null 不参与校验
    if (presetTouched && formModelIds.length > 0 && formModel && !formModelIds.includes(formModel)) {
      toast.error(t("form.defaultModelNotInPresetError"));
      return false;
    }
    return true;
  }, [isEdit, formName, formKnowledgeMaxResults, formExtra, presetTouched, formModelIds, formModel, t]);

  const agentIdentityName = agentName ?? formName ?? "agent";
  const readOnlyAgent = isEdit && !isAgentWritable({ name: agentIdentityName, resourceAccess: formResourceAccess });
  const agentNameForDisplay = isEdit ? displayAgentName || agentName || "" : formName;
  const effectiveModelOptions =
    formModel && relatedResources?.modelLabel && !modelOptions.some((option) => option.value === formModel)
      ? [...modelOptions, { value: formModel, label: relatedResources.modelLabel }]
      : modelOptions;
  const selectedMachineId = formAgentNode.kind === "machine" ? formAgentNode.machineId : null;
  const effectiveMachineOptions =
    selectedMachineId &&
    relatedResources?.machineLabel &&
    !machineOptions.some((option) => option.id === selectedMachineId)
      ? [
          ...machineOptions,
          { id: selectedMachineId, agentName: relatedResources.machineLabel, hostname: "", name: null, status: "" },
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

  // 复制 disabled 内置专家到本组织（设计 §2 恢复路径 / 决策 D3）：duplicate 成功后
  // 把复制出的组织自建专家加入选项并自动选中，替代原不可引用的内置行
  const handleDuplicateExpert = useCallback(
    async (expertId: string) => {
      try {
        const result = await unwrap(agentExpertApi.duplicate(expertId));
        if (!result?.expert) return;
        const copy = result.expert;
        setExpertOptions((current) => [...current.filter((e) => e.id !== copy.id), copy]);
        setFormExpertIds((current) => (current.includes(copy.id) ? current : [...current, copy.id]));
        setExpertsExpanded(false);
        toast.success(t("experts.duplicateSuccess", { expert: copy.name }));
      } catch (err) {
        toast.error(t("experts.duplicateFailed", { message: err instanceof Error ? err.message : String(err) }));
      }
    },
    [t],
  );

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
            modelIds: formModelIds,
            presetTouched,
            expertIds: formExpertIds,
            prompt: formPrompt,
            description: formDescription,
            knowledge: {
              knowledgeBaseIds: validKnowledgeBaseIds,
              searchFirst: formKnowledgeSearchFirst,
              maxResults: formKnowledgeMaxResults,
            },
          }),
          skillIds: formSkillIds,
          mcpIds: formMcpIds,
          siteAppIds: formSiteAppIds,
          agentNode: selectionToAgentNode(formAgentNode),
          publicReadable: formPublicReadable,
        };
        data.extra = formExtra.trim() ? JSON.parse(formExtra) : null;
        data.enableMemory = formEnableMemory;

        await unwrap(agentApi.set(agentName!, data));
        toast.success(t("save.successUpdate"));
        dispatchConfigChange("agents");
        setRestartDialogOpen(true);
      } else {
        // 创建模式
        const name = formName.trim();
        const createPayload: Record<string, unknown> = {
          ...buildAgentPayload({
            modelId: formModel,
            modelIds: formModelIds,
            presetTouched,
            expertIds: formExpertIds,
            prompt: formPrompt,
            description: formDescription,
            knowledge: {
              knowledgeBaseIds: formKnowledgeBaseIds,
              searchFirst: formKnowledgeSearchFirst,
              maxResults: formKnowledgeMaxResults,
            },
          }),
          skillIds: formSkillIds,
          mcpIds: formMcpIds,
          siteAppIds: formSiteAppIds,
          agentNode: selectionToAgentNode(formAgentNode),
          publicReadable: formPublicReadable,
        };
        if (formExtra.trim()) {
          createPayload.extra = JSON.parse(formExtra);
        }
        createPayload.enableMemory = formEnableMemory;
        const result = await unwrap(agentApi.create(name, createPayload));
        onOpenChange(false);
        onSuccess?.(result.id);
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
  // 预选模型联动（设计 §5.1）：预选列表非空时默认模型单选只展示预选内的模型；
  // 未配置预选（存量 null）或空数组（单模型）时退化为全量模型单选
  const defaultModelOptions =
    presetTouched && formModelIds.length > 0
      ? effectiveModelOptions.filter((option) => formModelIds.includes(option.value))
      : effectiveModelOptions;

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
              {(["basic", "knowledge", "advanced"] as const).map((tab) => (
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
                        {defaultModelOptions.map((m) => (
                          <SelectItem key={m.value} value={m.value}>
                            {m.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {/* 预选模型（运行时切换白名单，设计 §5）：多选 + 默认模型单选联动 */}
                  <div className="rounded-lg border border-border-subtle p-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-text-bright">{t("presetModels.tabTitle")}</p>
                        <p className="text-xs text-text-muted">
                          {presetTouched && formModelIds.length === 0
                            ? t("presetModels.singleModelHint")
                            : t("presetModels.selectedCount", { count: formModelIds.length })}
                        </p>
                      </div>
                      {!readOnlyAgent && (
                        <button
                          type="button"
                          onClick={() => setPresetExpanded(!presetExpanded)}
                          className="rounded-md p-1 hover:bg-surface-2 text-text-muted hover:text-text-primary transition-colors"
                          aria-expanded={presetExpanded}
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                    {/* 已选预选模型 badge */}
                    {formModelIds.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {formModelIds.map((mid) => {
                          const model = effectiveModelOptions.find((option) => option.value === mid);
                          return (
                            <span
                              key={mid}
                              className="inline-flex items-center gap-1 rounded bg-primary/10 text-primary text-xs px-2 py-0.5"
                            >
                              {model?.label ?? mid}
                              {!readOnlyAgent && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setPresetTouched(true);
                                    setFormModelIds((cur) => cur.filter((id) => id !== mid));
                                  }}
                                  className="hover:text-text-bright"
                                  aria-label={t("presetModels.removeModel", { model: model?.label ?? mid })}
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              )}
                            </span>
                          );
                        })}
                      </div>
                    )}
                    {/* 展开的预选模型列表 */}
                    {presetExpanded && (
                      <div className="mt-3 space-y-2 border-t border-border-subtle pt-3">
                        {effectiveModelOptions.length === 0 ? (
                          <p className="text-sm text-text-muted">{t("presetModels.noOptions")}</p>
                        ) : (
                          effectiveModelOptions.map((item) => {
                            const checked = formModelIds.includes(item.value);
                            return (
                              <label
                                key={item.value}
                                className="flex items-center justify-between gap-3 rounded-md border border-border-subtle px-3 py-2 text-sm"
                              >
                                <div>
                                  <p className="font-medium text-text-bright">{item.label}</p>
                                  {item.value === formModel && (
                                    <p className="text-xs text-text-muted">{t("presetModels.defaultBadge")}</p>
                                  )}
                                </div>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={readOnlyAgent}
                                  onChange={(e) => {
                                    setPresetTouched(true);
                                    setFormModelIds((current) =>
                                      e.target.checked
                                        ? [...current, item.value]
                                        : current.filter((id) => id !== item.value),
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
                    <Label>{t("form.executionNode", "运行节点")}</Label>
                    <Select
                      value={selectionToValue(formAgentNode)}
                      onValueChange={(value) => setFormAgentNode(valueToSelection(value))}
                      disabled={readOnlyAgent}
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder={t("form.executionNodePlaceholder", "选择运行节点")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">
                          {sandboxEnabled ? t("form.sandboxNode", "沙盒") : t("form.machineNode", "机器")} -{" "}
                          {t("form.localDefault", "本地默认")}
                        </SelectItem>
                        {sandboxEnabled &&
                          sandboxPoolOptions.length > 0 &&
                          sandboxPoolOptions.map((pool) => (
                            <SelectItem key={`sandbox:${pool.id}`} value={`sandbox:${pool.id}`}>
                              {t("form.sandboxNode", "沙盒")} - {pool.name} ({pool.id})
                            </SelectItem>
                          ))}
                        {effectiveMachineOptions.map((m) => (
                          <SelectItem key={`machine:${m.id}`} value={`machine:${m.id}`}>
                            {t("form.machineNode", "机器")} - {m.name || m.hostname || m.agentName} ({m.id.slice(0, 8)}){" "}
                            {m.status === "online"
                              ? tAgentPanel("machineStatus.online", "在线")
                              : tAgentPanel("machineStatus.offline", "离线")}
                          </SelectItem>
                        ))}
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
                  {/* 专家（Subagent）绑定 - 折叠展示（设计 §3：引用专家为 subagent） */}
                  <div className="rounded-lg border border-border-subtle p-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium text-text-bright">{t("experts.tabTitle")}</p>
                        <p className="text-xs text-text-muted">
                          {t("experts.selectedCount", { count: formExpertIds.length })}
                        </p>
                      </div>
                      {!readOnlyAgent && (
                        <button
                          type="button"
                          onClick={() => setExpertsExpanded(!expertsExpanded)}
                          className="rounded-md p-1 hover:bg-surface-2 text-text-muted hover:text-text-primary transition-colors"
                          aria-expanded={expertsExpanded}
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                    {/* 已选专家 badge */}
                    {formExpertIds.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {formExpertIds.map((eid) => {
                          const expert = expertOptions.find((item) => item.id === eid);
                          return (
                            <span
                              key={eid}
                              className="inline-flex items-center gap-1 rounded bg-primary/10 text-primary text-xs px-2 py-0.5"
                            >
                              {expert?.name ?? eid}
                              {expert?.builtin && (
                                <span className="text-[10px] text-text-muted">{t("experts.builtinBadge")}</span>
                              )}
                              {!readOnlyAgent && (
                                <button
                                  type="button"
                                  onClick={() => setFormExpertIds((cur) => cur.filter((id) => id !== eid))}
                                  className="hover:text-text-bright"
                                  aria-label={t("experts.removeExpert", { expert: expert?.name ?? eid })}
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              )}
                            </span>
                          );
                        })}
                      </div>
                    )}
                    {/* 展开的完整专家列表（含 disabled 内置专家：展示"复制到本组织"恢复路径，设计 §2/D3） */}
                    {expertsExpanded && (
                      <div className="mt-3 space-y-2 border-t border-border-subtle pt-3">
                        {expertOptions.length === 0 ? (
                          <p className="text-sm text-text-muted">{t("experts.noOptions")}</p>
                        ) : (
                          expertOptions.map((item) => {
                            const checked = formExpertIds.includes(item.id);
                            // disabled 内置专家（源文件缺失，决策 D3 软删除）：不可直接引用，
                            // 仅提供"复制到本组织"恢复路径
                            if (item.disabled) {
                              return (
                                <div
                                  key={item.id}
                                  className="flex items-center justify-between gap-3 rounded-md border border-border-subtle px-3 py-2 text-sm opacity-70"
                                >
                                  <div>
                                    <p className="font-medium text-text-bright">
                                      {item.name}
                                      <span className="ml-1.5 text-[10px] text-text-muted">
                                        {t("experts.disabledBadge")}
                                      </span>
                                    </p>
                                    {item.description && (
                                      <p className="text-xs text-text-muted line-clamp-2">{item.description}</p>
                                    )}
                                  </div>
                                  {!readOnlyAgent && (
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      onClick={() => handleDuplicateExpert(item.id)}
                                      className="shrink-0"
                                    >
                                      {t("experts.duplicateAction")}
                                    </Button>
                                  )}
                                </div>
                              );
                            }
                            return (
                              <label
                                key={item.id}
                                className="flex items-center justify-between gap-3 rounded-md border border-border-subtle px-3 py-2 text-sm"
                              >
                                <div>
                                  <p className="font-medium text-text-bright">
                                    {item.name}
                                    {item.builtin && (
                                      <span className="ml-1.5 text-[10px] text-text-muted">
                                        {t("experts.builtinBadge")}
                                      </span>
                                    )}
                                  </p>
                                  {item.description && (
                                    <p className="text-xs text-text-muted line-clamp-2">{item.description}</p>
                                  )}
                                </div>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={readOnlyAgent}
                                  onChange={(e) => {
                                    setFormExpertIds((current) =>
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
                        onCheckedChange={(checked) => {
                          setFormEnableMemory(checked);
                        }}
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
              {activeTab === "advanced" && (
                <div className="space-y-2">
                  <Label>{t("form.extraLabel")}</Label>
                  <Textarea
                    value={formExtra}
                    onChange={(e) => setFormExtra(e.target.value)}
                    placeholder={t("form.extraPlaceholder")}
                    rows={8}
                    className="font-mono text-sm"
                    disabled={readOnlyAgent}
                  />
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
