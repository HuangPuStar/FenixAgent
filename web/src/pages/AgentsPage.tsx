import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { BatchActionBar } from "@/components/config/BatchActionBar";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { type Column, DataTable } from "@/components/config/DataTable";
import { FormDialog } from "@/components/config/FormDialog";
import { StatusBadge } from "@/components/config/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { client } from "../api/client";
import { unwrapConfigData } from "../api/config-response";
import { PermissionTab } from "../components/PermissionTab";
import { dispatchConfigChange } from "../lib/config-events";
import type { AgentDetail, AgentInfo } from "../types/config";
import type { KnowledgeBaseInfo } from "../types/knowledge";

export const DEFAULT_AGENT_MODE = "primary";

export function isValidAgentNameInput(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length >= 1 && name.length <= 64;
}

export function isValidStepsInput(steps: string): boolean {
  const n = parseInt(steps);
  return !isNaN(n) && n >= 1 && n <= 200;
}

export function filterSubagents(agents: AgentInfo[]): AgentInfo[] {
  return agents.filter((a) => a.mode === "subagent");
}

export function getDisplayAgents(agents: AgentInfo[], pageTab: "all" | "primary" | "subagent"): AgentInfo[] {
  if (pageTab === "subagent") return agents.filter((a) => a.mode === "subagent");
  if (pageTab === "primary") return agents.filter((a) => a.mode !== "subagent");
  return agents;
}

export function getSubagentColumnKeys(): string[] {
  return ["name", "builtIn", "model", "description"];
}

export function getFullAgentColumnKeys(): string[] {
  return ["name", "builtIn", "model", "mode", "default"];
}

export function buildSubagentFormData(params: {
  name: string;
  model: string;
  description: string;
  prompt: string;
  steps: string;
  disable: boolean;
}): Record<string, unknown> {
  return {
    mode: "subagent",
    model: params.model || undefined,
    steps: parseInt(params.steps),
    prompt: params.prompt || undefined,
    description: params.description || undefined,
    disable: params.disable,
  };
}

export interface AgentKnowledgeFormState {
  knowledgeBaseIds: string[];
  searchFirst: boolean;
  maxResults: string;
}

export function getDefaultKnowledgeFormState(): AgentKnowledgeFormState {
  return {
    knowledgeBaseIds: [],
    searchFirst: true,
    maxResults: "5",
  };
}

export function buildKnowledgeFormState(detail: Pick<AgentDetail, "knowledge">): AgentKnowledgeFormState {
  return {
    knowledgeBaseIds: detail.knowledge?.knowledgeBaseIds ?? [],
    searchFirst: detail.knowledge?.policy?.searchFirst ?? true,
    maxResults: String(detail.knowledge?.policy?.maxResults ?? 5),
  };
}

export function filterKnowledgeBaseIds(selectedIds: string[], knowledgeOptions: Pick<KnowledgeBaseInfo, "id">[]) {
  const validIds = new Set(knowledgeOptions.map((item) => item.id));
  return selectedIds.filter((id) => validIds.has(id));
}

export function buildAgentPayload(input: {
  model: string;
  mode: string;
  steps: string;
  prompt: string;
  description: string;
  variant: string;
  temperature: string;
  topP: string;
  color: string;
  hidden: boolean;
  disable: boolean;
  permission: Record<string, unknown> | null;
  knowledge: AgentKnowledgeFormState;
}) {
  return {
    model: input.model || undefined,
    mode: input.mode,
    steps: parseInt(input.steps),
    prompt: input.prompt || undefined,
    description: input.description || undefined,
    variant: input.variant || undefined,
    temperature: input.temperature !== "" ? parseFloat(input.temperature) : undefined,
    top_p: input.topP !== "" ? parseFloat(input.topP) : undefined,
    color: input.color || undefined,
    hidden: input.hidden,
    disable: input.disable,
    permission: input.permission,
    knowledge: {
      knowledgeBaseIds: input.knowledge.knowledgeBaseIds,
      policy: {
        searchFirst: input.knowledge.searchFirst,
        maxResults: Number(input.knowledge.maxResults || 5),
      },
    },
  };
}

export function AgentsPage() {
  const { t } = useTranslation("agents");
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [defaultAgent, setDefaultAgent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentInfo | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [selected, setSelected] = useState<AgentInfo[]>([]);
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [knowledgeOptions, setKnowledgeOptions] = useState<KnowledgeBaseInfo[]>([]);
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
  const [skillOptions, setSkillOptions] = useState<{ id: string; name: string; description: string }[]>([]);
  const [activeTab, setActiveTab] = useState<"basic" | "knowledge" | "permission" | "skills">("basic");

  const loadAgents = useCallback(async () => {
    setLoading(true);
    try {
      const { data: listData, error: listErr } = await client.web.config.agents.post({ action: "list" });
      if (listErr) throw new Error(listErr.message ?? t("loadErrorShort"));
      const data = unwrapConfigData(listData) ?? listData;
      setAgents(Array.isArray(data?.agents) ? data.agents : []);
      setDefaultAgent(data?.default_agent ?? null);
    } catch (e) {
      console.error(t("loadErrorShort"), e);
      toast.error(t("loadError", { message: e instanceof Error ? e.message : t("unknownError") }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadModelOptions = useCallback(async () => {
    try {
      const { data: modelsData, error: modelsErr } = await client.web.config.models.post({ action: "get" });
      if (modelsErr) return;
      const data = unwrapConfigData(modelsData) ?? modelsData;
      setModelOptions(Array.isArray(data?.available) ? data.available.map((m: { fullId: string }) => m.fullId) : []);
    } catch {
      /* silent */
    }
  }, []);

  const loadKnowledgeOptions = useCallback(async () => {
    try {
      const { data: kbData, error: kbErr } = await client.web.knowledgeBases.get();
      if (kbErr) return;
      setKnowledgeOptions(kbData as unknown as KnowledgeBaseInfo[]);
    } catch {
      /* silent */
    }
  }, []);

  const loadSkillOptions = useCallback(async () => {
    try {
      const { data: skillsData, error: skillsErr } = await client.web.config.skills.post({ action: "list" });
      if (skillsErr) return;
      const data = unwrapConfigData(skillsData) ?? skillsData;
      setSkillOptions(
        Array.isArray(data?.skills)
          ? data.skills.map((s: any) => ({ id: s.id, name: s.name, description: s.description ?? "" }))
          : [],
      );
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    loadAgents();
    loadModelOptions();
    loadKnowledgeOptions();
    loadSkillOptions();
  }, [loadAgents, loadModelOptions, loadKnowledgeOptions, loadSkillOptions]);

  const columns: Column<AgentInfo>[] = [
    { key: "name", header: t("columns.name"), sortable: true, filterable: true },
    {
      key: "builtIn",
      header: t("columns.type"),
      filterable: true,
      render: (row) => <StatusBadge status={row.builtIn ? "builtIn" : "custom"} />,
    },
    { key: "model", header: t("columns.model"), sortable: true },
    {
      key: "mode",
      header: t("columns.mode"),
      filterable: true,
      render: (row) => (row.mode ? <StatusBadge status={row.mode} /> : "\u2014"),
    },
    {
      key: "knowledgeBaseCount",
      header: t("columns.knowledgeBase"),
      sortable: true,
      render: (row) => `${row.knowledgeBaseCount ?? 0}`,
    },
    {
      key: "default",
      header: t("columns.default"),
      render: (row) => (row.name === defaultAgent ? "\u2605" : ""),
    },
  ];

  const handleOpenCreate = async () => {
    await loadKnowledgeOptions();
    setEditingAgent(null);
    setFormName("");
    setFormModel(modelOptions[0] || "");
    setFormMode(DEFAULT_AGENT_MODE);
    setFormSteps("50");
    setFormPrompt("");
    setFormDescription("");
    setFormVariant("");
    setFormTemperature("");
    setFormTopP("");
    setFormColor("");
    setFormHidden(false);
    setFormDisable(false);
    const knowledgeDefaults = getDefaultKnowledgeFormState();
    setFormKnowledgeBaseIds(knowledgeDefaults.knowledgeBaseIds);
    setFormKnowledgeSearchFirst(knowledgeDefaults.searchFirst);
    setFormKnowledgeMaxResults(knowledgeDefaults.maxResults);
    setFormPermission(null);
    setFormSkillIds([]);
    setActiveTab("basic");
    setDialogOpen(true);
  };

  const handleOpenEdit = async (agent: AgentInfo) => {
    await loadKnowledgeOptions();
    setEditingAgent(agent);
    setFormName(agent.name);
    setFormModel(agent.model || "");
    setFormMode(agent.mode || DEFAULT_AGENT_MODE);
    setFormPrompt("");
    setFormDescription("");
    setFormVariant("");
    setFormTemperature("");
    setFormTopP("");
    setFormColor("");
    setFormHidden(false);
    setFormDisable(false);
    const knowledgeDefaults = getDefaultKnowledgeFormState();
    setFormKnowledgeBaseIds(knowledgeDefaults.knowledgeBaseIds);
    setFormKnowledgeSearchFirst(knowledgeDefaults.searchFirst);
    setFormKnowledgeMaxResults(knowledgeDefaults.maxResults);
    setFormPermission(null);
    try {
      const { data: agentData, error: agentErr } = await client.web.config.agents.post({
        action: "get",
        name: agent.name,
      });
      if (agentErr) throw new Error(agentErr.message ?? t("knowledge.loadError", { message: "" }));
      const detail = unwrapConfigData(agentData) ?? agentData;
      setFormSteps(String(detail.steps ?? 50));
      setFormPrompt(detail.prompt || "");
      setFormDescription(detail.description || "");
      setFormVariant(detail.variant || "");
      setFormTemperature(
        detail.temperature !== null && detail.temperature !== undefined ? String(detail.temperature) : "",
      );
      setFormTopP(detail.top_p !== null && detail.top_p !== undefined ? String(detail.top_p) : "");
      setFormColor(detail.color || "");
      setFormHidden(detail.hidden ?? false);
      setFormDisable(detail.disable ?? false);
      const knowledgeState = buildKnowledgeFormState(detail);
      setFormKnowledgeBaseIds(knowledgeState.knowledgeBaseIds);
      setFormKnowledgeSearchFirst(knowledgeState.searchFirst);
      setFormKnowledgeMaxResults(knowledgeState.maxResults);
      setFormPermission(
        detail.permission
          ? typeof detail.permission === "string"
            ? (detail.permission as unknown as Record<string, unknown>)
            : (detail.permission as Record<string, unknown>)
          : null,
      );
      setFormSkillIds(Array.isArray(detail.skillIds) ? detail.skillIds : []);
    } catch {
      setFormSteps("50");
    }
    setActiveTab("basic");
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const name = formName.trim();
    if (!isValidAgentNameInput(name)) {
      toast.error(t("form.nameValidationError"));
      return;
    }
    if (!isValidStepsInput(formSteps)) {
      toast.error(t("form.stepsValidationError"));
      return;
    }
    if (formTemperature !== "") {
      const tv = parseFloat(formTemperature);
      if (isNaN(tv) || tv < 0 || tv > 2) {
        toast.error(t("form.temperatureValidationError"));
        return;
      }
    }
    if (formTopP !== "") {
      const p = parseFloat(formTopP);
      if (isNaN(p) || p < 0 || p > 1) {
        toast.error(t("form.topPValidationError"));
        return;
      }
    }
    const knowledgeMaxResults = parseInt(formKnowledgeMaxResults);
    if (isNaN(knowledgeMaxResults) || knowledgeMaxResults < 1 || knowledgeMaxResults > 20) {
      toast.error(t("knowledge.maxResultsValidationError"));
      return;
    }
    setFormSaving(true);
    try {
      const latestKnowledgeOptions = await client.web.knowledgeBases
        .get()
        .then((r) => (Array.isArray(r.data) ? (r.data as unknown as KnowledgeBaseInfo[]) : []))
        .catch(() => knowledgeOptions);
      setKnowledgeOptions(latestKnowledgeOptions);
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
      };
      if (editingAgent) {
        const { error: setErr } = await client.web.config.agents.post({ action: "set", name, data });
        if (setErr) throw new Error(setErr.message ?? t("save.errorUpdate", { message: "" }));
        toast.success(t("save.successUpdate"));
      } else {
        const { error: crtErr } = await client.web.config.agents.post({ action: "create", name, data });
        if (crtErr) throw new Error(crtErr.message ?? t("save.errorCreate", { message: "" }));
        toast.success(t("save.successCreate"));
      }
      setDialogOpen(false);
      loadAgents();
      dispatchConfigChange("agents");
    } catch (e) {
      console.error(t("save.errorGeneric", { message: "" }), e);
      toast.error(t("save.errorGeneric", { message: e instanceof Error ? e.message : t("unknownError") }));
    } finally {
      setFormSaving(false);
    }
  };

  const handleSetDefault = async (name: string) => {
    try {
      const { error: defErr } = await client.web.config.agents.post({ action: "set_default", name });
      if (defErr) throw new Error(defErr.message ?? t("setDefault.error", { message: "" }));
      setDefaultAgent(name);
      toast.success(t("setDefault.success", { name }));
    } catch (e) {
      console.error(t("setDefault.error", { message: "" }), e);
      toast.error(t("setDefault.error", { message: e instanceof Error ? e.message : t("unknownError") }));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      const { error: delErr } = await client.web.config.agents.post({ action: "delete", name: deleteTarget });
      if (delErr) throw new Error(delErr.message ?? t("delete.error", { message: "" }));
      toast.success(t("delete.success"));
      setConfirmOpen(false);
      loadAgents();
      dispatchConfigChange("agents");
    } catch (e) {
      console.error(t("delete.error", { message: "" }), e);
      toast.error(t("delete.error", { message: e instanceof Error ? e.message : t("unknownError") }));
    }
  };

  const confirmBatchDelete = async () => {
    const customAgents = selected.filter((a) => !a.builtIn);
    try {
      await Promise.all(
        customAgents.map((a) =>
          client.web.config.agents.post({ action: "delete", name: a.name }).then((r) => {
            if (r.error) throw new Error(r.error.message ?? t("delete.error", { message: "" }));
          }),
        ),
      );
      toast.success(t("batchDeleteCount", { count: customAgents.length }));
      setBatchConfirmOpen(false);
      setSelected([]);
      loadAgents();
      dispatchConfigChange("agents");
    } catch (e) {
      console.error(t("batchDeleteError", { message: "" }), e);
      toast.error(t("batchDeleteError", { message: e instanceof Error ? e.message : t("unknownError") }));
    }
  };

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-9 w-24" />
        </div>
        <div className="rounded-md border">
          <Skeleton className="h-10 w-full rounded-t-md" />
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-none border-t" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-bright">{t("title")}</h2>
          <p className="text-sm text-text-muted mt-0.5">{t("subtitle")}</p>
        </div>
        <Button onClick={handleOpenCreate}>{t("createButton")}</Button>
      </div>
      <DataTable<AgentInfo>
        columns={columns}
        data={agents}
        searchable
        searchPlaceholder={t("searchPlaceholder")}
        selectable
        onSelectionChange={setSelected}
        emptyMessage={t("emptyMessage")}
        actions={(row) => (
          <div className="flex gap-1.5">
            {row.name !== defaultAgent && (
              <Button size="xs" variant="outline" onClick={() => handleSetDefault(row.name)}>
                {t("actions.setDefault")}
              </Button>
            )}
            <Button size="xs" variant="outline" onClick={() => handleOpenEdit(row)}>
              {t("actions.edit")}
            </Button>
            {!row.builtIn && (
              <Button
                size="xs"
                variant="destructive"
                onClick={() => {
                  setDeleteTarget(row.name);
                  setConfirmOpen(true);
                }}
              >
                {t("actions.delete")}
              </Button>
            )}
          </div>
        )}
      />
      {selected.length > 0 && (
        <BatchActionBar
          selectedCount={selected.length}
          onClear={() => setSelected([])}
          actions={[
            {
              label: t("batchDelete"),
              variant: "destructive",
              onClick: () => setBatchConfirmOpen(true),
            },
          ]}
        />
      )}
      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editingAgent ? t("dialog.editTitle") : t("dialog.createTitle")}
        onSubmit={handleSave}
        loading={formSaving}
      >
        <div className="flex gap-1 rounded-lg bg-surface-2 p-1 mb-4">
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
        {activeTab === "basic" && (
          <div className="space-y-4 max-h-[55vh] overflow-y-auto">
            <div>
              <Label>{t("form.name")}</Label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                disabled={!!editingAgent}
                placeholder={t("form.namePlaceholder")}
              />
            </div>
            <div>
              <Label>{t("form.model")}</Label>
              <Select value={formModel} onValueChange={setFormModel}>
                <SelectTrigger>
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
                  <SelectTrigger>
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
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>{t("form.description")}</Label>
                <Input
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder={t("form.descriptionPlaceholder")}
                />
              </div>
              <div>
                <Label>{t("form.variant")}</Label>
                <Input
                  value={formVariant}
                  onChange={(e) => setFormVariant(e.target.value)}
                  placeholder={t("form.variantPlaceholder")}
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
                />
              </div>
            </div>
            <div>
              <Label>{t("form.color")}</Label>
              <div className="flex gap-2">
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
          <div className="space-y-4 max-h-[55vh] overflow-y-auto">
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
          <div className="max-h-[55vh] overflow-y-auto">
            <PermissionTab
              key={editingAgent?.name ?? "__new__"}
              agentName={formName}
              permission={formPermission}
              onPermissionChange={setFormPermission}
            />
          </div>
        )}
        {activeTab === "skills" && (
          <div className="space-y-4 max-h-[55vh] overflow-y-auto">
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
      </FormDialog>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("delete.confirmTitle")}
        description={t("delete.confirmDesc", { name: deleteTarget ?? "" })}
        variant="destructive"
        onConfirm={confirmDelete}
      />
      <ConfirmDialog
        open={batchConfirmOpen}
        onOpenChange={setBatchConfirmOpen}
        title={t("batchDeleteConfirmTitle")}
        description={t("batchDeleteConfirmDesc", { count: selected.filter((a) => !a.builtIn).length })}
        variant="destructive"
        onConfirm={confirmBatchDelete}
      />
    </div>
  );
}
