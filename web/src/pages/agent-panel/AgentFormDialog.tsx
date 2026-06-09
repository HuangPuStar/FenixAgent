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
import { agentApi, envApi, instanceApi, kbApi, modelApi, registryApi, skillConfigApi } from "@/src/api/sdk";
import type { AgentTemplate } from "../../../../packages/sdk/src/modules/config";
import { PermissionTab } from "../../components/PermissionTab";
import { NS } from "../../i18n";
import { canManageAgentSharing, getAgentDisplayName, isAgentWritable } from "../../lib/agent-resource-access";
import {
  buildAgentPayload,
  buildKnowledgeFormState,
  DEFAULT_AGENT_MODE,
  filterKnowledgeBaseIds,
  getDefaultKnowledgeFormState,
  isValidAgentNameInput,
  isValidStepsInput,
} from "../../lib/agent-utils";
import { dispatchConfigChange } from "../../lib/config-events";
import { getSkillOptionValue, mapSkillOptions } from "../../lib/skill-resource-access";
import type { ModelEntry, ResourceAccess } from "../../types/config";
import type { KnowledgeBaseInfo } from "../../types/knowledge";

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
  knowledgeBases?: Array<{ id: string; label: string; slug?: string | null }>;
}

export function mapModelOptions(available: ModelEntry[]): { value: string; label: string }[] {
  return available.map((model) => {
    const source = model.providerResourceAccess?.sourceOrganizationName;
    const label = source ? `${source}/${model.fullId}` : model.fullId;
    return { value: model.stableFullId ?? model.fullId, label };
  });
}

export function AgentFormDialog({ open, onOpenChange, mode, defaultName, onSuccess, agentName }: AgentFormDialogProps) {
  const isEdit = mode === "edit";
  const { t } = useTranslation(NS.AGENTS);
  const { t: tAgentPanel } = useTranslation(NS.AGENT_PANEL);
  const { t: tComponents } = useTranslation(NS.COMPONENTS);

  const [modelOptions, setModelOptions] = useState<{ value: string; label: string }[]>([]);
  const [knowledgeOptions, setKnowledgeOptions] = useState<KnowledgeBaseInfo[]>([]);
  const [skillOptions, setSkillOptions] = useState<
    { id: string; key: string; name: string; label: string; description: string; resourceAccess?: ResourceAccess }[]
  >([]);
  const [machineOptions, setMachineOptions] = useState<{ id: string; agentName: string; hostname: string }[]>([]);

  const [formName, setFormName] = useState("");
  const [formModel, setFormModel] = useState("");
  const [formMode, setFormMode] = useState(DEFAULT_AGENT_MODE);
  const [formSteps, setFormSteps] = useState("50");
  const [formPrompt, setFormPrompt] = useState("");
  const [formSaving, setFormSaving] = useState(false);
  const [formDescription, setFormDescription] = useState("");
  const [formVariant, setFormVariant] = useState("");
  const [formTemperature, setFormTemperature] = useState("");
  const [formTopP, setFormTopP] = useState("");
  const [formColor, setFormColor] = useState("");
  const [formHidden, setFormHidden] = useState(false);
  const [formDisable, setFormDisable] = useState(false);
  const [formKnowledgeBaseIds, setFormKnowledgeBaseIds] = useState<string[]>([]);
  const [formKnowledgeSearchFirst, setFormKnowledgeSearchFirst] = useState(true);
  const [formKnowledgeMaxResults, setFormKnowledgeMaxResults] = useState("5");
  const [formPermission, setFormPermission] = useState<Record<string, unknown> | null>(null);
  const [formSkillIds, setFormSkillIds] = useState<string[]>([]);
  const [formMachineId, setFormMachineId] = useState<string>("local");
  const [formEngineType, setFormEngineType] = useState<string>("opencode");
  const [formResourceAccess, setFormResourceAccess] = useState<ResourceAccess | undefined>(undefined);
  const [formPublicReadable, setFormPublicReadable] = useState(false);
  const [currentAgentId, setCurrentAgentId] = useState<string | null>(null);
  const [displayAgentName, setDisplayAgentName] = useState("");
  const [relatedResources, setRelatedResources] = useState<AgentRelatedResourcesView | undefined>(undefined);
  const [activeTab, setActiveTab] = useState<"basic" | "knowledge" | "permission" | "more">("basic");
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [skillsExpanded, setSkillsExpanded] = useState(false);

  const [loading, setLoading] = useState(false);
  const [restartDialogOpen, setRestartDialogOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (isEdit && !agentName) return;

    setActiveTab("basic");
    const knowledgeDefaults = getDefaultKnowledgeFormState();
    setFormKnowledgeBaseIds(knowledgeDefaults.knowledgeBaseIds);
    setFormKnowledgeSearchFirst(knowledgeDefaults.searchFirst);
    setFormKnowledgeMaxResults(knowledgeDefaults.maxResults);
    setFormPermission(null);
    setFormSkillIds([]);
    setFormMachineId("local");
    setFormResourceAccess(undefined);
    setFormPublicReadable(false);
    setCurrentAgentId(null);
    setDisplayAgentName("");
    setRelatedResources(undefined);
    setSelectedTemplateId(null);

    // 加载在线机器列表
    registryApi.list({ status: "online", limit: 100 }).then(({ data, error }) => {
      if (error) return;
      const machines =
        (data as { data?: { id: string; agentName: string; machineInfo: { hostname?: string } | null }[] } | null)
          ?.data ?? [];
      setMachineOptions(
        machines.map((m) => ({ id: m.id, agentName: m.agentName, hostname: m.machineInfo?.hostname ?? "" })),
      );
    });

    if (isEdit) {
      setLoading(true);
      Promise.all([agentApi.get(agentName!), modelApi.get(), kbApi.list(), skillConfigApi.list()])
        .then(([agentResult, modelsResult, kbResult, skillsResult]) => {
          if (agentResult.error) {
            console.error("Failed to load agent config:", agentResult.error);
            toast.error(t("knowledge.loadError", { message: agentResult.error.message }));
            return;
          }
          const d = agentResult.data as unknown as Record<string, unknown>;
          setCurrentAgentId((d.id as string) ?? null);
          setDisplayAgentName(String(d.name ?? agentName ?? ""));
          setFormModel((d.model as string) || "");
          setFormMode((d.mode as string) || DEFAULT_AGENT_MODE);
          setFormSteps(String(d.steps ?? 50));
          setFormPrompt(String(d.prompt ?? ""));
          setFormDescription(String(d.description ?? ""));
          setFormVariant(String(d.variant ?? ""));
          setFormTemperature(d.temperature !== null && d.temperature !== undefined ? String(d.temperature) : "");
          setFormTopP(d.top_p !== null && d.top_p !== undefined ? String(d.top_p) : "");
          setFormColor(String(d.color ?? ""));
          setFormHidden(Boolean(d.hidden));
          setFormDisable(Boolean(d.disable));
          setFormMachineId((d.machineId as string) || "local");
          setFormEngineType((d.engineType as string) || "opencode");
          setFormResourceAccess(d.resourceAccess as ResourceAccess | undefined);
          setFormPublicReadable(Boolean((d.resourceAccess as ResourceAccess | undefined)?.publicReadable));
          setRelatedResources((d.relatedResources as AgentRelatedResourcesView | undefined) ?? undefined);

          const knowledgeState = buildKnowledgeFormState(d as Parameters<typeof buildKnowledgeFormState>[0]);
          setFormKnowledgeBaseIds(knowledgeState.knowledgeBaseIds);
          setFormKnowledgeSearchFirst(knowledgeState.searchFirst);
          setFormKnowledgeMaxResults(knowledgeState.maxResults);

          setFormPermission(
            d.permission
              ? typeof d.permission === "string"
                ? (d.permission as unknown as Record<string, unknown>)
                : (d.permission as unknown as Record<string, unknown>)
              : null,
          );
          setFormSkillIds(Array.isArray(d.skillIds) ? (d.skillIds as string[]) : []);

          const modelsData = modelsResult.data as unknown as Record<string, unknown> | null;
          const available = modelsData?.available;
          const models = Array.isArray(available) ? mapModelOptions(available as ModelEntry[]) : [];
          setModelOptions(models);

          const kbData = kbResult.data;
          setKnowledgeOptions(Array.isArray(kbData) ? (kbData as unknown as KnowledgeBaseInfo[]) : []);

          const skillsData = skillsResult.data as unknown as Record<string, unknown> | null;
          const skillsRaw = skillsData?.skills;
          const skills = Array.isArray(skillsRaw)
            ? mapSkillOptions(
                skillsRaw as Array<{ id: string; name: string; description?: string; resourceAccess?: ResourceAccess }>,
              )
            : [];
          setSkillOptions(skills);
        })
        .catch((err) => {
          console.error("Failed to load agent config:", err);
          toast.error(t("knowledge.loadError", { message: (err as Error).message }));
        })
        .finally(() => setLoading(false));

      agentApi.templates().then(({ data, error }) => {
        if (!error && data?.templates) {
          setTemplates(data.templates);
        }
      });
    } else {
      setFormName(defaultName ?? "");
      setFormSteps("50");
      setFormPrompt("");
      setFormDescription("");
      setFormVariant("");
      setFormTemperature("");
      setFormTopP("");
      setFormColor("");
      setFormHidden(false);
      setFormDisable(false);
      setFormPublicReadable(false);
      setSelectedTemplateId(null);

      agentApi.templates().then(({ data, error }) => {
        if (!error && data?.templates) {
          setTemplates(data.templates);
        }
      });

      modelApi.get().then(({ data, error }) => {
        if (error) return;
        const available = (data as unknown as Record<string, unknown>)?.available;
        const models = Array.isArray(available) ? mapModelOptions(available as ModelEntry[]) : [];
        setModelOptions(models);
        setFormModel(models[0]?.value || "");
      });

      kbApi.list().then(({ data, error }) => {
        if (error) return;
        setKnowledgeOptions(Array.isArray(data) ? (data as unknown as KnowledgeBaseInfo[]) : []);
      });

      skillConfigApi.list().then(({ data, error }) => {
        if (error) return;
        const skills = (data as unknown as Record<string, unknown>)?.skills;
        setSkillOptions(
          Array.isArray(skills)
            ? mapSkillOptions(
                skills as Array<{ id: string; name: string; description?: string; resourceAccess?: ResourceAccess }>,
              )
            : [],
        );
      });
    }
  }, [open, isEdit, agentName, defaultName, t]);

  const validateForm = useCallback((): boolean => {
    if (!isEdit) {
      const name = formName.trim();
      if (!isValidAgentNameInput(name)) {
        toast.error(t("form.nameValidationError"));
        return false;
      }
    }
    if (!isValidStepsInput(formSteps)) {
      toast.error(t("form.stepsValidationError"));
      return false;
    }
    if (formTemperature !== "") {
      const tv = parseFloat(formTemperature);
      if (Number.isNaN(tv) || tv < 0 || tv > 2) {
        toast.error(t("form.temperatureValidationError"));
        return false;
      }
    }
    if (formTopP !== "") {
      const p = parseFloat(formTopP);
      if (Number.isNaN(p) || p < 0 || p > 1) {
        toast.error(t("form.topPValidationError"));
        return false;
      }
    }
    const knowledgeMaxResults = parseInt(formKnowledgeMaxResults, 10);
    if (Number.isNaN(knowledgeMaxResults) || knowledgeMaxResults < 1 || knowledgeMaxResults > 20) {
      toast.error(t("knowledge.maxResultsValidationError"));
      return false;
    }
    return true;
  }, [isEdit, formName, formSteps, formTemperature, formTopP, formKnowledgeMaxResults, t]);

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
      ? [...machineOptions, { id: formMachineId, agentName: relatedResources.machineLabel, hostname: "" }]
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

  const handleSave = useCallback(async () => {
    if (readOnlyAgent) return;
    if (!validateForm()) return;
    setFormSaving(true);
    try {
      if (isEdit) {
        let latestKnowledgeOptions = knowledgeOptions;
        const { data: kbData } = await kbApi.list();
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
            model: formModel,
            mode: formMode,
            steps: formSteps,
            prompt: formPrompt,
            description: formDescription,
            variant: formVariant,
            temperature: formTemperature,
            topP: formTopP,
            color: formColor,
            hidden: formHidden,
            disable: formDisable,
            permission: formPermission,
            engineType: formEngineType,
            knowledge: {
              knowledgeBaseIds: validKnowledgeBaseIds,
              searchFirst: formKnowledgeSearchFirst,
              maxResults: formKnowledgeMaxResults,
            },
          }),
          skillIds: formSkillIds,
          machineId: formMachineId === "local" ? null : formMachineId,
          publicReadable: formPublicReadable,
        };
        const { error } = await agentApi.set(agentName!, data);
        if (error) {
          toast.error(t("save.errorGeneric", { message: error.message }));
          return;
        }
        toast.success(t("save.successUpdate"));
        dispatchConfigChange("agents");
        setRestartDialogOpen(true);
      } else {
        const name = formName.trim();
        const { error } = await agentApi.create(name, {
          ...buildAgentPayload({
            model: formModel,
            mode: formMode,
            steps: formSteps,
            prompt: formPrompt,
            description: formDescription,
            variant: formVariant,
            temperature: formTemperature,
            topP: formTopP,
            color: formColor,
            hidden: formHidden,
            disable: formDisable,
            permission: formPermission,
            knowledge: {
              knowledgeBaseIds: formKnowledgeBaseIds,
              searchFirst: formKnowledgeSearchFirst,
              maxResults: formKnowledgeMaxResults,
            },
          }),
          skillIds: formSkillIds,
          machineId: formMachineId === "local" ? null : formMachineId,
          publicReadable: formPublicReadable,
        });
        if (error) {
          console.error(t("save.errorGeneric", { message: "" }), error);
          toast.error(t("save.errorGeneric", { message: error.message }));
        } else {
          toast.success(t("save.successCreate"));
          onOpenChange(false);
          onSuccess?.();
          dispatchConfigChange("agents");
        }
      }
    } catch (e) {
      console.error(t("save.errorGeneric", { message: "" }), e);
      toast.error(t("save.errorGeneric", { message: e instanceof Error ? e.message : t("unknownError") }));
    } finally {
      setFormSaving(false);
    }
  }, [
    validateForm,
    isEdit,
    formName,
    formModel,
    formMode,
    formSteps,
    formPrompt,
    formDescription,
    formVariant,
    formTemperature,
    formTopP,
    formColor,
    formHidden,
    formDisable,
    formPermission,
    formKnowledgeBaseIds,
    formKnowledgeSearchFirst,
    formKnowledgeMaxResults,
    formSkillIds,
    formMachineId,
    agentName,
    knowledgeOptions,
    onOpenChange,
    onSuccess,
    t,
    readOnlyAgent,
    formPublicReadable,
  ]);

  const getRunningInstanceIds = useCallback(async () => {
    if (!agentName) return [];
    try {
      const { data: agentsResult } = await agentApi.list();
      const rawAgents = (
        agentsResult as unknown as { agents?: { id: string; name: string; resourceAccess?: ResourceAccess }[] } | null
      )?.agents;
      const agents = Array.isArray(rawAgents) ? rawAgents : [];
      const matchedAgent =
        agents.find((a) => currentAgentId && a.id === currentAgentId) ??
        agents.find((a) => a.name === agentName && a.resourceAccess?.resourceKey === formResourceAccess?.resourceKey) ??
        agents.find((a) => a.name === agentName);
      if (!matchedAgent) return [];

      const { data: envsData } = await envApi.list();
      const envs = Array.isArray(envsData)
        ? (envsData as { id: string; agent_config_id?: string; instances_count?: number }[])
        : [];
      const matchedEnv = envs.find((e) => e.agent_config_id === matchedAgent.id);
      if (!matchedEnv || (matchedEnv.instances_count ?? 0) <= 0) return [];

      const { data: instData } = await envApi.listInstances({ id: matchedEnv.id });
      const instances = (instData as { instances?: { id: string; status: string }[] } | null)?.instances ?? [];
      return instances
        .filter((inst) => inst.status === "running" || inst.status === "starting")
        .map((inst) => ({ id: inst.id, environmentId: matchedEnv.id }));
    } catch (err) {
      console.error("Failed to get running instances:", err);
      return [];
    }
  }, [agentName, currentAgentId, formResourceAccess?.resourceKey]);

  const handleRestartAfterSave = useCallback(async () => {
    setRestarting(true);
    try {
      const runningInstances = await getRunningInstanceIds();
      for (const inst of runningInstances) {
        await instanceApi.delete({ id: inst.id });
        await instanceApi.spawn({ environmentId: inst.environmentId });
      }
      toast.success(tAgentPanel("restartSuccess"));
    } catch (err) {
      console.error("Failed to restart:", err);
      toast.error(tAgentPanel("restartFailed", { message: (err as Error).message }));
    } finally {
      setRestarting(false);
      setRestartDialogOpen(false);
      onOpenChange(false);
    }
  }, [getRunningInstanceIds, tAgentPanel, onOpenChange]);

  if (!open) return null;

  const title = isEdit ? (readOnlyAgent ? t("dialog.detailTitle") : t("dialog.editTitle")) : t("dialog.createTitle");
  const confirmLabel = formSaving ? "..." : isEdit ? t("actions.save") : t("dialog.createConfirm");
  const dialogKey = isEdit ? agentName : "__new__";
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
              {(["basic", "knowledge", "permission", "more"] as const).map((tab) => (
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
                    <Label>{t("form.machine")}</Label>
                    <Select value={formMachineId} onValueChange={setFormMachineId} disabled={readOnlyAgent}>
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder={t("form.machinePlaceholder")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="local">{t("form.machineLocal")}</SelectItem>
                        {effectiveMachineOptions.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.hostname || m.agentName} ({m.id.slice(0, 8)})
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
              {activeTab === "permission" && (
                <div className={readOnlyAgent ? "pointer-events-none opacity-60" : undefined}>
                  <PermissionTab
                    key={dialogKey}
                    agentName={isEdit ? agentName! : formName}
                    permission={formPermission}
                    onPermissionChange={setFormPermission}
                  />
                </div>
              )}
              {activeTab === "more" && (
                <div className="space-y-4">
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
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label>{t("form.mode")}</Label>
                      <Select value={formMode} onValueChange={setFormMode} disabled={readOnlyAgent}>
                        <SelectTrigger className="mt-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="primary">primary</SelectItem>
                          <SelectItem value="subagent">subagent</SelectItem>
                          <SelectItem value="all">all</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>{t("form.steps")}</Label>
                      <Input
                        type="number"
                        value={formSteps}
                        onChange={(e) => setFormSteps(e.target.value)}
                        min={1}
                        max={200}
                        className="mt-1"
                        disabled={readOnlyAgent}
                      />
                      <p className="text-xs text-text-muted mt-1">{t("form.stepsHint")}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
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
                      <Label>{t("form.variant")}</Label>
                      <Input
                        value={formVariant}
                        onChange={(e) => setFormVariant(e.target.value)}
                        placeholder={t("form.variantPlaceholder")}
                        className="mt-1"
                        disabled={readOnlyAgent}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label>{t("form.temperature")}</Label>
                      <Input
                        type="number"
                        value={formTemperature}
                        onChange={(e) => setFormTemperature(e.target.value)}
                        min={0}
                        max={2}
                        step={0.1}
                        placeholder={t("form.temperaturePlaceholder")}
                        className="mt-1"
                        disabled={readOnlyAgent}
                      />
                    </div>
                    <div>
                      <Label>{t("form.topP")}</Label>
                      <Input
                        type="number"
                        value={formTopP}
                        onChange={(e) => setFormTopP(e.target.value)}
                        min={0}
                        max={1}
                        step={0.1}
                        placeholder={t("form.topPPPlaceholder")}
                        className="mt-1"
                        disabled={readOnlyAgent}
                      />
                    </div>
                  </div>
                  <div>
                    <Label>{t("form.color")}</Label>
                    <div className="flex gap-2 mt-1">
                      <Input
                        type="color"
                        value={formColor || "#000000"}
                        onChange={(e) => setFormColor(e.target.value)}
                        className="w-12 h-9 p-1 cursor-pointer"
                        disabled={readOnlyAgent}
                      />
                      <Input
                        value={formColor}
                        onChange={(e) => setFormColor(e.target.value)}
                        placeholder={t("form.colorPlaceholder")}
                        className="flex-1"
                        disabled={readOnlyAgent}
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-6">
                    <label className="flex items-center gap-2 text-sm" title={t("form.hiddenTitle")}>
                      <input
                        type="checkbox"
                        checked={formHidden}
                        disabled={readOnlyAgent}
                        onChange={(e) => setFormHidden(e.target.checked)}
                      />
                      {t("form.hidden")}
                    </label>
                    <label className="flex items-center gap-2 text-sm" title={t("form.disableTitle")}>
                      <input
                        type="checkbox"
                        checked={formDisable}
                        disabled={readOnlyAgent}
                        onChange={(e) => setFormDisable(e.target.checked)}
                      />
                      {t("form.disable")}
                    </label>
                  </div>
                </div>
              )}
            </div>

            {/* 底部 */}
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-border-subtle flex-shrink-0">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("dialog.cancel") ?? "Cancel"}
              </Button>
              <Button onClick={handleSave} disabled={formSaving || readOnlyAgent}>
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
              <AlertDialogAction onClick={handleRestartAfterSave} disabled={restarting}>
                {restarting ? tAgentPanel("restarting") : tAgentPanel("restart")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
