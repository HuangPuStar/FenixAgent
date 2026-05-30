import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { agentApi, kbApi, modelApi, registryApi, skillConfigApi } from "@/src/api/sdk";
import {
  buildAgentPayload,
  buildKnowledgeFormState,
  DEFAULT_AGENT_MODE,
  filterKnowledgeBaseIds,
  getDefaultKnowledgeFormState,
  isValidStepsInput,
} from "@/src/lib/agent-utils";
import { PermissionTab } from "../../components/PermissionTab";
import { dispatchConfigChange } from "../../lib/config-events";
import type { KnowledgeBaseInfo } from "../../types/knowledge";

interface AgentConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentName: string;
}

export function AgentConfigDialog({ open, onOpenChange, agentName }: AgentConfigDialogProps) {
  const { t } = useTranslation("agents");
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [machineOptions, setMachineOptions] = useState<
    Array<{ id: string; agentName: string; machineInfo: Record<string, unknown> | null }>
  >([]);
  const [knowledgeOptions, setKnowledgeOptions] = useState<KnowledgeBaseInfo[]>([]);
  const [skillOptions, setSkillOptions] = useState<{ id: string; name: string; description: string }[]>([]);
  const [loading, setLoading] = useState(false);

  const [formModel, setFormModel] = useState("");
  const [formMachineId, setFormMachineId] = useState("");
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
  const [activeTab, setActiveTab] = useState<"basic" | "knowledge" | "permission" | "skills">("basic");

  useEffect(() => {
    if (!open || !agentName) return;

    setLoading(true);
    setActiveTab("basic");

    const knowledgeDefaults = getDefaultKnowledgeFormState();
    setFormKnowledgeBaseIds(knowledgeDefaults.knowledgeBaseIds);
    setFormKnowledgeSearchFirst(knowledgeDefaults.searchFirst);
    setFormKnowledgeMaxResults(knowledgeDefaults.maxResults);
    setFormPermission(null);
    setFormSkillIds([]);

    Promise.all([agentApi.get(agentName), modelApi.get(), kbApi.list(), skillConfigApi.list()])
      .then(([agentResult, modelsResult, kbResult, skillsResult]) => {
        const agentError = agentResult.error;
        if (agentError) {
          console.error("Failed to load agent config:", agentError);
          toast.error(t("knowledge.loadError", { message: agentError.message }));
          return;
        }
        const d = agentResult.data as unknown as Record<string, unknown>;
        setFormMachineId((d.machineId as string) || "");
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
        const kbList = Array.isArray(kbData) ? (kbData as unknown as KnowledgeBaseInfo[]) : [];
        setKnowledgeOptions(kbList);

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

        // Load machine options
        registryApi
          .list({ status: "online" })
          .then(({ data: mData, error: mError }: { data?: unknown; error?: unknown }) => {
            if (mError) return;
            const listData = mData as { data?: Array<{ id: string; agentName: string; machineInfo: unknown }> };
            if (listData.data && Array.isArray(listData.data)) {
              const options = listData.data.map((m: { id: string; agentName: string; machineInfo: unknown }) => ({
                id: m.id,
                agentName: m.agentName,
                machineInfo: m.machineInfo as Record<string, unknown> | null,
              }));
              setMachineOptions(options);
            }
          });
      })
      .catch((err) => {
        console.error("Failed to load agent config:", err);
        toast.error(t("knowledge.loadError", { message: (err as Error).message }));
      })
      .finally(() => setLoading(false));
  }, [open, agentName, t]);

  const handleSave = useCallback(async () => {
    if (!isValidStepsInput(formSteps)) {
      toast.error(t("form.stepsValidationError"));
      return;
    }
    if (formTemperature !== "") {
      const tv = parseFloat(formTemperature);
      if (Number.isNaN(tv) || tv < 0 || tv > 2) {
        toast.error(t("form.temperatureValidationError"));
        return;
      }
    }
    if (formTopP !== "") {
      const p = parseFloat(formTopP);
      if (Number.isNaN(p) || p < 0 || p > 1) {
        toast.error(t("form.topPValidationError"));
        return;
      }
    }
    const knowledgeMaxResults = parseInt(formKnowledgeMaxResults, 10);
    if (Number.isNaN(knowledgeMaxResults) || knowledgeMaxResults < 1 || knowledgeMaxResults > 20) {
      toast.error(t("knowledge.maxResultsValidationError"));
      return;
    }
    setFormSaving(true);
    try {
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
        machineId: formMachineId,
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
      };
      const { error } = await agentApi.set(agentName, data);
      if (error) {
        toast.error(t("save.errorGeneric", { message: error.message }));
        return;
      }
      toast.success(t("save.successUpdate"));
      onOpenChange(false);
      dispatchConfigChange("agents");
    } catch (e) {
      console.error(t("save.errorGeneric", { message: "" }), e);
      toast.error(t("save.errorGeneric", { message: e instanceof Error ? e.message : t("unknownError") }));
    } finally {
      setFormSaving(false);
    }
  }, [
    formModel,
    formMachineId,
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
    agentName,
    knowledgeOptions,
    onOpenChange,
    t,
  ]);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-surface-0 rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col border border-border-subtle">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle flex-shrink-0">
          <h3 className="text-lg font-semibold text-text-bright">{t("dialog.editTitle")}</h3>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="text-text-muted hover:text-text-primary text-lg cursor-pointer"
          >
            ✕
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-12 text-text-muted text-sm">
            {t("knowledge.loadError", { message: "" }).replace(": {{message}}", "")}...
          </div>
        ) : (
          <>
            <div className="flex gap-1 rounded-lg bg-surface-2 p-1 m-6 mb-0 flex-shrink-0">
              <button
                type="button"
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${activeTab === "basic" ? "bg-surface-1 text-text-primary shadow-sm" : "text-text-muted hover:text-text-secondary"}`}
                onClick={() => setActiveTab("basic")}
              >
                {t("dialog.tabs.basic")}
              </button>
              <button
                type="button"
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${activeTab === "knowledge" ? "bg-surface-1 text-text-primary shadow-sm" : "text-text-muted hover:text-text-secondary"}`}
                onClick={() => setActiveTab("knowledge")}
              >
                {t("dialog.tabs.knowledge")}
              </button>
              <button
                type="button"
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${activeTab === "permission" ? "bg-surface-1 text-text-primary shadow-sm" : "text-text-muted hover:text-text-secondary"}`}
                onClick={() => setActiveTab("permission")}
              >
                {t("dialog.tabs.permission")}
              </button>
              <button
                type="button"
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${activeTab === "skills" ? "bg-surface-1 text-text-primary shadow-sm" : "text-text-muted hover:text-text-secondary"}`}
                onClick={() => setActiveTab("skills")}
              >
                {t("dialog.tabs.skills")}
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {activeTab === "basic" && (
                <div className="space-y-4">
                  <div>
                    <Label>{t("form.name")}</Label>
                    <Input value={agentName} disabled className="mt-1" />
                  </div>
                  <div>
                    <Label>
                      {t("form.machine")} <span className="text-red-500">*</span>
                    </Label>
                    <Select value={formMachineId} onValueChange={setFormMachineId}>
                      <SelectTrigger className="mt-1">
                        <SelectValue placeholder={t("form.machinePlaceholder")} />
                      </SelectTrigger>
                      <SelectContent>
                        {machineOptions.map((m) => {
                          const mi = m.machineInfo as Record<string, string> | null;
                          const ip = mi?.ip ?? "";
                          const os = mi?.os ?? "";
                          const mac = mi?.mac ?? "";
                          const label = `${m.agentName} (${os} / ${ip} / ${mac})`;
                          return (
                            <SelectItem key={m.id} value={m.id}>
                              {label}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
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
                  key={agentName}
                  agentName={agentName}
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
            </div>

            <div className="flex justify-end gap-3 px-6 py-4 border-t border-border-subtle flex-shrink-0">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("dialog.cancel") ?? "Cancel"}
              </Button>
              <Button onClick={handleSave} disabled={formSaving}>
                {formSaving ? "..." : t("actions.edit")}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
