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
import { Textarea } from "@/components/ui/textarea";
import { agentApi, envApi, instanceApi, kbApi, modelApi, registryApi, skillConfigApi } from "@/src/api/sdk";
import { PermissionTab } from "../../components/PermissionTab";
import { NS } from "../../i18n";
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
import type { KnowledgeBaseInfo } from "../../types/knowledge";

interface AgentFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  defaultName?: string;
  onSuccess?: () => void;
  agentName?: string;
}

export function AgentFormDialog({ open, onOpenChange, mode, defaultName, onSuccess, agentName }: AgentFormDialogProps) {
  const isEdit = mode === "edit";
  const { t } = useTranslation("agents");
  const { t: tAgentPanel } = useTranslation(NS.AGENT_PANEL);

  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [knowledgeOptions, setKnowledgeOptions] = useState<KnowledgeBaseInfo[]>([]);
  const [skillOptions, setSkillOptions] = useState<{ id: string; name: string; description: string }[]>([]);
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
  const [activeTab, setActiveTab] = useState<"basic" | "knowledge" | "permission" | "skills" | "more">("basic");

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
          const models = Array.isArray(available) ? (available as Array<{ fullId: string }>).map((m) => m.fullId) : [];
          setModelOptions(models);

          const kbData = kbResult.data;
          setKnowledgeOptions(Array.isArray(kbData) ? (kbData as unknown as KnowledgeBaseInfo[]) : []);

          const skillsData = skillsResult.data as unknown as Record<string, unknown> | null;
          const skillsRaw = skillsData?.skills;
          const skills = Array.isArray(skillsRaw)
            ? (skillsRaw as Array<{ id: string; name: string; description?: string }>).map((s) => ({
                id: s.id,
                name: s.name,
                description: s.description ?? "",
              }))
            : [];
          setSkillOptions(skills);
        })
        .catch((err) => {
          console.error("Failed to load agent config:", err);
          toast.error(t("knowledge.loadError", { message: (err as Error).message }));
        })
        .finally(() => setLoading(false));
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

      modelApi.get().then(({ data, error }) => {
        if (error) return;
        const available = (data as unknown as Record<string, unknown>)?.available;
        const models = Array.isArray(available) ? (available as Array<{ fullId: string }>).map((m) => m.fullId) : [];
        setModelOptions(models);
        setFormModel(models[0] || "");
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
            ? (skills as Array<{ id: string; name: string; description?: string }>).map((s) => ({
                id: s.id,
                name: s.name,
                description: s.description ?? "",
              }))
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

  const handleSave = useCallback(async () => {
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
            knowledge: {
              knowledgeBaseIds: validKnowledgeBaseIds,
              searchFirst: formKnowledgeSearchFirst,
              maxResults: formKnowledgeMaxResults,
            },
          }),
          skillIds: formSkillIds,
          machineId: formMachineId === "local" ? null : formMachineId,
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
  ]);

  const getRunningInstanceIds = useCallback(async () => {
    if (!agentName) return [];
    try {
      const { data: agentsResult } = await agentApi.list();
      const rawAgents = (agentsResult as unknown as { agents?: { id: string; name: string }[] } | null)?.agents;
      const agents = Array.isArray(rawAgents) ? rawAgents : [];
      const matchedAgent = agents.find((a) => a.name === agentName);
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
  }, [agentName]);

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

  const title = isEdit ? t("dialog.editTitle") : t("dialog.createTitle");
  const confirmLabel = formSaving ? "..." : isEdit ? t("actions.save") : t("dialog.createConfirm");
  const dialogKey = isEdit ? agentName : "__new__";

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
            {/* Tabs */}
            <div className="flex gap-1 rounded-lg bg-surface-2 p-1 m-6 mb-0 flex-shrink-0">
              {(["basic", "knowledge", "permission", "skills", "more"] as const).map((tab) => (
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
                      <Input value={agentName} disabled className="mt-1" />
                    ) : (
                      <Input
                        value={formName}
                        onChange={(e) => setFormName(e.target.value)}
                        placeholder={t("form.namePlaceholder")}
                        className="mt-1"
                      />
                    )}
                  </div>
                  <div>
                    <Label>{t("form.model")}</Label>
                    <Select value={formModel} onValueChange={setFormModel}>
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder={t("form.modelPlaceholder")} />
                      </SelectTrigger>
                      <SelectContent>
                        {modelOptions.map((m) => (
                          <SelectItem key={m} value={m}>
                            {m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>{t("form.machine")}</Label>
                    <Select value={formMachineId} onValueChange={setFormMachineId}>
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder={t("form.machinePlaceholder")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="local">{t("form.machineLocal")}</SelectItem>
                        {machineOptions.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.hostname || m.agentName} ({m.id.slice(0, 8)})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
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
                      {knowledgeOptions.length === 0 ? (
                        <p className="text-sm text-text-muted">{t("knowledge.noOptions")}</p>
                      ) : (
                        knowledgeOptions.map((item) => {
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
                        onChange={(e) => setFormKnowledgeMaxResults(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              )}
              {activeTab === "permission" && (
                <PermissionTab
                  key={dialogKey}
                  agentName={isEdit ? agentName! : formName}
                  permission={formPermission}
                  onPermissionChange={setFormPermission}
                />
              )}
              {activeTab === "skills" && (
                <div className="space-y-4">
                  <div className="rounded-lg border border-border-subtle p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium text-text-bright">{t("skills.tabTitle")}</p>
                        <p className="text-xs text-text-muted">
                          {t("skills.selectedCount", { count: formSkillIds.length })}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 space-y-2">
                      {skillOptions.length === 0 ? (
                        <p className="text-sm text-text-muted">{t("skills.noOptions")}</p>
                      ) : (
                        skillOptions.map((item) => {
                          const checked = formSkillIds.includes(item.id);
                          return (
                            <label
                              key={item.id}
                              className="flex items-center justify-between gap-3 rounded-md border border-border-subtle px-3 py-2 text-sm"
                            >
                              <div>
                                <p className="font-medium text-text-bright">{item.name}</p>
                                {item.description && <p className="text-xs text-text-muted">{item.description}</p>}
                              </div>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => {
                                  setFormSkillIds((current) =>
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
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label>{t("form.mode")}</Label>
                      <Select value={formMode} onValueChange={setFormMode}>
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
                      />
                    </div>
                    <div>
                      <Label>{t("form.variant")}</Label>
                      <Input
                        value={formVariant}
                        onChange={(e) => setFormVariant(e.target.value)}
                        placeholder={t("form.variantPlaceholder")}
                        className="mt-1"
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
                      />
                      <Input
                        value={formColor}
                        onChange={(e) => setFormColor(e.target.value)}
                        placeholder={t("form.colorPlaceholder")}
                        className="flex-1"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-6">
                    <label className="flex items-center gap-2 text-sm" title={t("form.hiddenTitle")}>
                      <input type="checkbox" checked={formHidden} onChange={(e) => setFormHidden(e.target.checked)} />
                      {t("form.hidden")}
                    </label>
                    <label className="flex items-center gap-2 text-sm" title={t("form.disableTitle")}>
                      <input type="checkbox" checked={formDisable} onChange={(e) => setFormDisable(e.target.checked)} />
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
              <Button onClick={handleSave} disabled={formSaving}>
                {confirmLabel}
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
