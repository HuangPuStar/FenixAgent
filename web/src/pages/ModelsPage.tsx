import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { BatchActionBar } from "@/components/config/BatchActionBar";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { type Column, DataTable } from "@/components/config/DataTable";
import { FormDialog } from "@/components/config/FormDialog";
import { ModelConfigDialog } from "@/components/config/ModelConfigDialog";
import { StatusBadge } from "@/components/config/StatusBadge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { modelApi, providerApi } from "@/src/api/sdk";
import { dispatchConfigChange } from "../lib/config-events";
import type { ModelConfig, ProviderInfo, ProviderModel } from "../types/config";

const NPM_OPTIONS = [
  { id: "openai-compatible", labelKey: "npmOptions.openaiCompatible", npm: "@ai-sdk/openai-compatible" },
  { id: "openai", labelKey: "npmOptions.openai", npm: "@ai-sdk/openai" },
  { id: "anthropic", labelKey: "npmOptions.anthropic", npm: "@ai-sdk/anthropic" },
  { id: "google", labelKey: "npmOptions.google", npm: "@ai-sdk/google" },
  { id: "deepseek", labelKey: "npmOptions.deepseek", npm: "@ai-sdk/deepseek" },
  { id: "mistral", labelKey: "npmOptions.mistral", npm: "@ai-sdk/mistral" },
  { id: "cohere", labelKey: "npmOptions.cohere", npm: "@ai-sdk/cohere" },
  { id: "fireworks", labelKey: "npmOptions.fireworks", npm: "@ai-sdk/fireworks" },
  { id: "togetherai", labelKey: "npmOptions.togetherai", npm: "@ai-sdk/togetherai" },
  { id: "perplexity", labelKey: "npmOptions.perplexity", npm: "@ai-sdk/perplexity" },
  { id: "xai", labelKey: "npmOptions.xai", npm: "@ai-sdk/xai" },
  { id: "custom", labelKey: "npmOptions.custom", npm: "" },
];

const INPUT_MODALITY_OPTIONS = ["text", "image", "audio", "video", "pdf"] as const;
const OUTPUT_MODALITY_OPTIONS = ["text", "image"] as const;

export function getModelUsageStatus(fullId: string, currentModel: string | null, smallModel: string | null): string[] {
  // Note: returned strings are used as badge display in DataTable; i18n is handled at call site
  const badges: string[] = [];
  if (currentModel === fullId) badges.push("primary");
  if (smallModel === fullId) badges.push("small");
  return badges;
}

export function validateProviderForm(name: string, isEdit: boolean): string | null {
  if (!name.trim()) return "validation.nameEmpty";
  if (!isEdit && (name.length < 1 || name.length > 64)) return "validation.nameLength";
  return null;
}

export function buildProviderPayload(
  apiKey: string,
  baseURL: string,
  npm: string,
  name: string,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (apiKey) data.apiKey = apiKey;
  if (baseURL) data.baseURL = baseURL;
  if (npm) data.npm = npm;
  if (name) data.name = name;
  return data;
}

export function buildProviderModelRequest(
  action: "add_model" | "update_model",
  providerId: string,
  modelId: string,
  data: Record<string, unknown>,
) {
  return action === "update_model" ? { action, name: providerId, modelId, data } : { action, name: providerId, data };
}

function ModalityBadge({ type, items }: { type: "input" | "output"; items: string[] }) {
  const { t } = useTranslation("models");
  if (!items || items.length === 0) return null;
  const isInput = type === "input";
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded-full font-medium ${isInput ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300" : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"}`}
    >
      {isInput ? t("modelSubrow.modalityBadgeInput") : t("modelSubrow.modalityBadgeOutput")} {items.join(", ")}
    </span>
  );
}

function ModelSubrow({
  providerId,
  models,
  onModelChange,
}: {
  providerId: string;
  models: ProviderModel[];
  onModelChange: (action: "delete" | "save", providerId: string, modelId?: string) => void;
}) {
  const { t } = useTranslation("models");
  const [_editingModel, _setEditingModel] = useState<ProviderModel | null>(null);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [isNewModel, setIsNewModel] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{ providerId: string; modelId: string } | null>(null);

  // model form state
  const [mfId, setMfId] = useState("");
  const [mfName, setMfName] = useState("");
  const [mfContext, setMfContext] = useState("");
  const [mfOutput, setMfOutput] = useState("");
  const [mfInputModalities, setMfInputModalities] = useState<string[]>(["text"]);
  const [mfOutputModalities, setMfOutputModalities] = useState<string[]>(["text"]);
  const [mfThinkingEnabled, setMfThinkingEnabled] = useState(false);
  const [mfThinkingBudget, setMfThinkingBudget] = useState("");
  const [mfCostInput, setMfCostInput] = useState("");
  const [mfCostOutput, setMfCostOutput] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const resetModelForm = () => {
    setMfId("");
    setMfName("");
    setMfContext("");
    setMfOutput("");
    setMfInputModalities(["text"]);
    setMfOutputModalities(["text"]);
    setMfThinkingEnabled(false);
    setMfThinkingBudget("");
    setMfCostInput("");
    setMfCostOutput("");
    setShowAdvanced(false);
  };

  const openNewModel = () => {
    resetModelForm();
    setIsNewModel(true);
    setModelDialogOpen(true);
  };

  const openEditModel = (m: ProviderModel) => {
    setIsNewModel(false);
    setMfId(m.id);
    setMfName(m.name);
    const limit = (m.limit as Record<string, unknown>) ?? {};
    setMfContext(limit.context ? String(limit.context) : "");
    setMfOutput(limit.output ? String(limit.output) : "");
    const modalities = (m.modalities as { input?: string[]; output?: string[] }) ?? {};
    setMfInputModalities(modalities.input ?? ["text"]);
    setMfOutputModalities(modalities.output ?? ["text"]);
    const cost = (m.cost as Record<string, unknown>) ?? {};
    setMfCostInput(cost.input ? String(cost.input) : "");
    setMfCostOutput(cost.output ? String(cost.output) : "");
    const options = (m.options ?? {}) as Record<string, unknown>;
    const thinking = options.thinking as Record<string, unknown> | undefined;
    setMfThinkingEnabled(!!thinking?.enabled);
    setMfThinkingBudget(thinking?.budgetTokens ? String(thinking.budgetTokens) : "");
    setShowAdvanced(!!thinking?.enabled || !!cost.input || !!cost.output);
    setModelDialogOpen(true);
  };

  const handleModelSave = async () => {
    if (!mfId.trim()) {
      toast.error(t("modelSubrow.modelIdEmpty"));
      return;
    }

    const data: Record<string, unknown> = { modelId: mfId.trim(), name: mfName || mfId };
    const limit: Record<string, unknown> = {};
    if (mfContext) limit.context = Number(mfContext);
    if (mfOutput) limit.output = Number(mfOutput);
    if (Object.keys(limit).length > 0) data.limit = limit;

    const modalities: { input?: string[]; output?: string[] } = {};
    if (mfInputModalities.length > 0) modalities.input = mfInputModalities;
    if (mfOutputModalities.length > 0) modalities.output = mfOutputModalities;
    data.modalities = modalities;

    const options: Record<string, unknown> = {};
    if (mfThinkingEnabled) {
      const thinking: Record<string, unknown> = { enabled: true };
      if (mfThinkingBudget) thinking.budgetTokens = Number(mfThinkingBudget);
      options.thinking = thinking;
    }
    if (Object.keys(options).length > 0) data.options = options;

    const cost: Record<string, unknown> = {};
    if (mfCostInput) cost.input = Number(mfCostInput);
    if (mfCostOutput) cost.output = Number(mfCostOutput);
    if (Object.keys(cost).length > 0) data.cost = cost;

    setModelSaving(true);
    try {
      if (isNewModel) {
        const { error } = await providerApi.addModel(providerId, data);
        if (error) {
          toast.error(t("modelSubrow.saveModel.errorGeneric", { message: error.message }));
          return;
        }
        toast.success(t("modelSubrow.saveModel.successCreate"));
      } else {
        const { error } = await providerApi.updateModel(providerId, { modelId: mfId, ...data });
        if (error) {
          toast.error(t("modelSubrow.saveModel.errorGeneric", { message: error.message }));
          return;
        }
        toast.success(t("modelSubrow.saveModel.successUpdate"));
      }
      setModelDialogOpen(false);
      onModelChange("save", providerId, mfId.trim());
      dispatchConfigChange("models");
    } catch (e) {
      console.error(t("modelSubrow.saveModel.errorGeneric", { message: "" }), e);
      toast.error(
        t("modelSubrow.saveModel.errorGeneric", { message: e instanceof Error ? e.message : t("unknownError") }),
      );
    } finally {
      setModelSaving(false);
    }
  };

  const handleModelDelete = async () => {
    if (!deleteConfirm) return;
    const { error } = await providerApi.removeModel(deleteConfirm.providerId, deleteConfirm.modelId);
    if (error) {
      console.error(t("modelSubrow.deleteModel.error", { message: "" }), error);
      toast.error(t("modelSubrow.deleteModel.error", { message: error.message }));
      return;
    }
    toast.success(t("modelSubrow.deleteModel.success"));
    const pid = deleteConfirm.providerId;
    const mid = deleteConfirm.modelId;
    setDeleteConfirm(null);
    onModelChange("delete", pid, mid);
    dispatchConfigChange("models");
  };

  const toggleModality = (list: string[], item: string, setter: (v: string[]) => void) => {
    setter(list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  };

  return (
    <div className="space-y-2">
      {models.length === 0 ? (
        <div className="py-6 text-center text-text-muted text-sm">{t("modelSubrow.emptyMessage")}</div>
      ) : (
        <div className="grid gap-2">
          {models.map((m) => {
            const limit = (m.limit as Record<string, unknown>) ?? {};
            const modalities = (m.modalities as { input?: string[]; output?: string[] }) ?? {};
            const cost = (m.cost as Record<string, unknown>) ?? {};
            const hasInputMods =
              modalities.input &&
              modalities.input.length > 0 &&
              !(modalities.input.length === 1 && modalities.input[0] === "text");
            const hasOutputMods =
              modalities.output &&
              modalities.output.length > 0 &&
              !(modalities.output.length === 1 && modalities.output[0] === "text");
            return (
              <div
                key={m.id}
                className="group flex items-center gap-3 rounded-lg border border-border-light bg-surface-1 px-3 py-2.5 transition-colors hover:border-border-active hover:shadow-sm"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium text-text-bright truncate">{m.id}</span>
                    {m.name && m.name !== m.id && (
                      <span className="text-xs text-text-secondary truncate">{m.name}</span>
                    )}
                    {(hasInputMods || hasOutputMods) && (
                      <div className="flex gap-1 ml-1">
                        {hasInputMods && <ModalityBadge type="input" items={modalities.input!} />}
                        {hasOutputMods && <ModalityBadge type="output" items={modalities.output!} />}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-text-muted">
                    {limit.context ? (
                      <span>
                        {t("modelSubrow.contextLabel")} {Number(limit.context).toLocaleString()}
                      </span>
                    ) : null}
                    {limit.output ? (
                      <span>
                        {t("modelSubrow.outputLabel")} {Number(limit.output).toLocaleString()}
                      </span>
                    ) : null}
                    {cost.input || cost.output ? (
                      <span className="text-amber-600 dark:text-amber-400">
                        {Number(cost.input) || 0}/{Number(cost.output) || 0}
                      </span>
                    ) : null}
                    {!limit.context && !limit.output && <span>{t("modelSubrow.noLimitInfo")}</span>}
                  </div>
                </div>
                <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button size="xs" variant="outline" onClick={() => openEditModel(m)}>
                    {t("actions.edit")}
                  </Button>
                  <Button
                    size="xs"
                    variant="destructive"
                    onClick={() => setDeleteConfirm({ providerId, modelId: m.id })}
                  >
                    {t("actions.delete")}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <Button
        size="sm"
        variant="outline"
        onClick={openNewModel}
        className="w-full border-dashed text-text-secondary hover:text-text-primary hover:border-brand"
      >
        {t("modelSubrow.addButton")}
      </Button>

      <FormDialog
        open={modelDialogOpen}
        onOpenChange={setModelDialogOpen}
        title={isNewModel ? t("modelSubrow.createTitle") : t("modelSubrow.editTitle", { id: mfId })}
        onSubmit={handleModelSave}
        loading={modelSaving}
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium text-text-primary">{t("modelSubrow.modelId")}</label>
              <Input
                value={mfId}
                onChange={(e) => setMfId(e.target.value)}
                disabled={!isNewModel}
                placeholder={t("modelSubrow.modelIdPlaceholder")}
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">{t("modelSubrow.displayName")}</label>
              <Input
                value={mfName}
                onChange={(e) => setMfName(e.target.value)}
                placeholder={t("modelSubrow.displayNamePlaceholder")}
                className="mt-1"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium text-text-primary">{t("modelSubrow.contextLimit")}</label>
              <Input
                type="number"
                value={mfContext}
                onChange={(e) => setMfContext(e.target.value)}
                placeholder="128000"
                className="mt-1 font-mono text-sm"
              />
              <p className="text-xs text-text-muted mt-1">{t("modelSubrow.contextHint")}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">{t("modelSubrow.outputLimit")}</label>
              <Input
                type="number"
                value={mfOutput}
                onChange={(e) => setMfOutput(e.target.value)}
                placeholder="16384"
                className="mt-1 font-mono text-sm"
              />
              <p className="text-xs text-text-muted mt-1">{t("modelSubrow.outputHint")}</p>
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-text-primary">{t("modelSubrow.inputModality")}</label>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {INPUT_MODALITY_OPTIONS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => toggleModality(mfInputModalities, m, setMfInputModalities)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors border ${
                    mfInputModalities.includes(m)
                      ? "bg-indigo-100 text-indigo-700 border-indigo-300 dark:bg-indigo-900/40 dark:text-indigo-300 dark:border-indigo-700"
                      : "bg-surface-2 text-text-secondary border-border-light hover:border-border hover:text-text-primary"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-text-primary">{t("modelSubrow.outputModality")}</label>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {OUTPUT_MODALITY_OPTIONS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => toggleModality(mfOutputModalities, m, setMfOutputModalities)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors border ${
                    mfOutputModalities.includes(m)
                      ? "bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-700"
                      : "bg-surface-2 text-text-secondary border-border-light hover:border-border hover:text-text-primary"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowAdvanced(!showAdvanced)}>
              {showAdvanced ? t("modelSubrow.hideAdvanced") : t("modelSubrow.showAdvanced")}
            </Button>
          </div>
          {showAdvanced && (
            <div className="space-y-3 border-t pt-3">
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-text-primary">{t("modelSubrow.thinkingEnabled")}</label>
                <Switch checked={mfThinkingEnabled} onCheckedChange={setMfThinkingEnabled} />
              </div>
              {mfThinkingEnabled && (
                <div>
                  <label className="text-sm font-medium text-text-primary">{t("modelSubrow.thinkingBudget")}</label>
                  <Input
                    type="number"
                    value={mfThinkingBudget}
                    onChange={(e) => setMfThinkingBudget(e.target.value)}
                    placeholder={t("modelSubrow.thinkingBudgetPlaceholder")}
                    className="mt-1"
                  />
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium text-text-primary">{t("modelSubrow.inputCost")}</label>
                  <Input
                    type="number"
                    step="0.01"
                    value={mfCostInput}
                    onChange={(e) => setMfCostInput(e.target.value)}
                    placeholder={t("modelSubrow.inputCostPlaceholder")}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-text-primary">{t("modelSubrow.outputCost")}</label>
                  <Input
                    type="number"
                    step="0.01"
                    value={mfCostOutput}
                    onChange={(e) => setMfCostOutput(e.target.value)}
                    placeholder={t("modelSubrow.outputCostPlaceholder")}
                    className="mt-1"
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </FormDialog>
      <ConfirmDialog
        open={!!deleteConfirm}
        onOpenChange={() => setDeleteConfirm(null)}
        title={t("modelSubrow.deleteModel.confirmTitle")}
        description={t("modelSubrow.deleteModel.confirmDesc", { id: deleteConfirm?.modelId ?? "" })}
        variant="destructive"
        onConfirm={handleModelDelete}
      />
    </div>
  );
}

export function ModelsPage() {
  const { t } = useTranslation("models");
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerModels, setProviderModels] = useState<Record<string, ProviderModel[]>>({});
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderInfo | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [selected, setSelected] = useState<ProviderInfo[]>([]);
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [testResult, setTestResult] = useState<
    { name: string; models: string[]; warning?: string } | { name: string; error: string } | null
  >(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [addedModelIds, setAddedModelIds] = useState<Set<string>>(new Set());
  const [formName, setFormName] = useState("");
  const [formApiKey, setFormApiKey] = useState("");
  const [formBaseURL, setFormBaseURL] = useState("");
  const [formNpm, setFormNpm] = useState("openai-compatible");
  const [formCustomNpm, setFormCustomNpm] = useState("");
  const [formDisplayName, setFormDisplayName] = useState("");
  const [formSaving, setFormSaving] = useState(false);
  const [modelConfig, setModelConfig] = useState<ModelConfig | null>(null);

  // Resolve NPM label from labelKey using translation
  const getNpmLabel = (opt: (typeof NPM_OPTIONS)[number]) => t(opt.labelKey);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [providersData, modelConfigData] = await Promise.all([
        (async () => {
          const { data: listData, error: listError } = await providerApi.list();
          if (listError) throw listError;

          const data = (Array.isArray(listData)
            ? listData
            : (((listData as unknown as Record<string, unknown>)?.providers ??
                []) as ProviderInfo[])) as unknown as ProviderInfo[];
          const modelsMap: Record<string, ProviderModel[]> = {};
          await Promise.all(
            data.map(async (p) => {
              const pId = (p as unknown as Record<string, unknown>).id as string;
              const { data: detail } = await providerApi.get(pId);
              modelsMap[pId] =
                ((detail as unknown as Record<string, unknown>)?.models as unknown as ProviderModel[]) ?? [];
            }),
          );
          return { providers: data, providerModels: modelsMap };
        })(),
        (async () => {
          const { data: modelsData } = await modelApi.get();
          return modelsData as unknown as ModelConfig;
        })(),
      ]);
      setProviders(providersData.providers as unknown as ProviderInfo[]);
      setProviderModels(providersData.providerModels);
      setModelConfig(modelConfigData);
    } catch (e) {
      console.error(t("loadModelsError"), e);
      toast.error(t("loadError", { message: e instanceof Error ? e.message : t("unknownError") }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const columns: Column<ProviderInfo>[] = [
    {
      key: "id",
      header: t("columns.id"),
      sortable: true,
      filterable: true,
      render: (row) => (
        <div className="flex flex-col">
          <span className="font-mono text-sm text-text-bright">{row.id}</span>
          {row.name && row.name !== row.id && <span className="text-xs text-text-muted">{row.name}</span>}
        </div>
      ),
    },
    {
      key: "npm",
      header: t("columns.protocol"),
      render: (row) => {
        const opt = NPM_OPTIONS.find((o) => o.npm === row.npm);
        return (
          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-surface-2 text-text-secondary">
            {opt ? getNpmLabel(opt) : row.npm || "\u2014"}
          </span>
        );
      },
    },
    {
      key: "keyHint",
      header: t("columns.apiKey"),
      render: (row) =>
        row.keyHint ? (
          <span className="font-mono text-xs text-text-muted bg-surface-2 px-2 py-0.5 rounded">***{row.keyHint}</span>
        ) : (
          <span className="text-text-muted">{"\u2014"}</span>
        ),
    },
    {
      key: "configured",
      header: t("columns.status"),
      filterable: true,
      render: (row) => <StatusBadge status={row.configured ? "configured" : "unconfigured"} />,
    },
    {
      key: "modelCount",
      header: t("columns.models"),
      sortable: true,
      render: (row) => (
        <span
          className={`inline-flex items-center justify-center min-w-[24px] h-5 px-1.5 rounded-full text-xs font-medium ${
            row.modelCount > 0 ? "bg-brand-subtle text-brand dark:text-brand-light" : "bg-surface-2 text-text-muted"
          }`}
        >
          {row.modelCount}
        </span>
      ),
    },
  ];

  const handleOpenCreate = () => {
    setEditingProvider(null);
    setFormName("");
    setFormApiKey("");
    setFormBaseURL("");
    setFormNpm("openai-compatible");
    setFormCustomNpm("");
    setFormDisplayName("");
    setDialogOpen(true);
  };

  const handleOpenEdit = (provider: ProviderInfo) => {
    setEditingProvider(provider);
    setFormName(provider.id);
    setFormApiKey("");
    setFormBaseURL(provider.baseURL ?? "");
    const matchOpt = NPM_OPTIONS.find((o) => o.npm === provider.npm);
    if (matchOpt) {
      setFormNpm(matchOpt.id);
      setFormCustomNpm("");
    } else {
      setFormNpm("custom");
      setFormCustomNpm(provider.npm ?? "");
    }
    setFormDisplayName(provider.name !== provider.id ? provider.name : "");
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const err = validateProviderForm(formName, !!editingProvider);
    if (err) {
      console.error(t("saveProvider.errorGeneric", { message: "" }), err);
      toast.error(t(err));
      return;
    }
    setFormSaving(true);
    try {
      const resolvedNpm =
        formNpm === "custom"
          ? formCustomNpm.trim() || "@ai-sdk/openai-compatible"
          : (NPM_OPTIONS.find((o) => o.id === formNpm)?.npm ?? "@ai-sdk/openai-compatible");
      const data = buildProviderPayload(formApiKey, formBaseURL, resolvedNpm, formDisplayName);
      const { error } = await providerApi.set(formName, data);
      if (error) {
        toast.error(t("saveProvider.errorGeneric", { message: error.message }));
        return;
      }
      toast.success(editingProvider ? t("saveProvider.successUpdate") : t("saveProvider.successCreate"));
      setDialogOpen(false);
      loadAll();
      dispatchConfigChange("providers");
    } catch (e) {
      console.error(t("saveProvider.errorGeneric", { message: "" }), e);
      toast.error(t("saveProvider.errorGeneric", { message: e instanceof Error ? e.message : t("unknownError") }));
    } finally {
      setFormSaving(false);
    }
  };

  const handleTest = async (name: string) => {
    setTesting(name);
    const { data: result, error } = await providerApi.test(name);
    if (error) {
      setTestResult({ name, error: error.message });
    } else {
      const d = result as Record<string, unknown>;
      setTestResult({ name, models: (d?.models ?? []) as string[], warning: d?.warning as string | undefined });
      const existing = (providerModels[name] ?? []).map((m) => m.id);
      setAddedModelIds(new Set(existing));
    }
    setTesting(null);
  };

  const handleAddFromTest = async (modelId: string) => {
    if (!testResult || "error" in testResult) return;
    const { error } = await providerApi.addModel(testResult.name, { modelId, name: modelId });
    if (error) {
      console.error(t("testDialog.addModelError", { message: "" }), error);
      toast.error(t("testDialog.addModelError", { message: error.message }));
      return;
    }
    setAddedModelIds((prev) => new Set(prev).add(modelId));
    setProviderModels((prev) => ({
      ...prev,
      [testResult.name]: [
        ...(prev[testResult.name] ?? []),
        { id: modelId, name: modelId, modalities: null, limit: null, cost: null },
      ],
    }));
    setProviders((prev) => prev.map((p) => (p.id === testResult.name ? { ...p, modelCount: p.modelCount + 1 } : p)));
    toast.success(t("testDialog.addModelSuccess", { modelId }));
    dispatchConfigChange("models");
  };

  const handleDelete = (name: string) => {
    setDeleteTarget(name);
    setConfirmOpen(true);
  };
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const { error } = await providerApi.delete(deleteTarget);
    if (error) {
      console.error(t("deleteProvider.error", { message: "" }), error);
      toast.error(t("deleteProvider.error", { message: error.message }));
      return;
    }
    toast.success(t("deleteProvider.success"));
    setConfirmOpen(false);
    loadAll();
    dispatchConfigChange("providers");
  };

  const handleBatchDelete = () => {
    setBatchConfirmOpen(true);
  };
  const confirmBatchDelete = async () => {
    await Promise.all(selected.map((p) => providerApi.delete(p.id)));
    toast.success(t("batchDeleteCount", { count: selected.length }));
    setBatchConfirmOpen(false);
    setSelected([]);
    loadAll();
    dispatchConfigChange("providers");
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
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
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
        <div className="flex items-center gap-2">
          <ModelConfigDialog
            currentModel={modelConfig?.current.model ?? null}
            currentSmallModel={modelConfig?.current.small_model ?? null}
            available={modelConfig?.available ?? []}
          />
          <Button onClick={handleOpenCreate}>{t("createButton")}</Button>
        </div>
      </div>
      <DataTable<ProviderInfo>
        columns={columns}
        data={providers}
        searchable
        searchPlaceholder={t("searchPlaceholder")}
        selectable
        onSelectionChange={setSelected}
        defaultExpandAll
        rowKey={(row) => row.id}
        emptyMessage={t("emptyMessage")}
        expandableRow={(row) => (
          <ModelSubrow
            providerId={row.id}
            models={providerModels[row.id] ?? []}
            onModelChange={(action, pid, mid) => {
              if (action === "delete" && mid) {
                setProviderModels((prev) => ({ ...prev, [pid]: (prev[pid] ?? []).filter((m) => m.id !== mid) }));
                setProviders((prev) =>
                  prev.map((p) => (p.id === pid ? { ...p, modelCount: Math.max(0, p.modelCount - 1) } : p)),
                );
              } else if (action === "save") {
                loadAll();
              }
            }}
          />
        )}
        actions={(row) => (
          <div className="flex gap-1.5">
            <Button size="xs" variant="outline" onClick={() => handleTest(row.id)} disabled={testing === row.id}>
              {testing === row.id ? t("actions.testing") : t("actions.test")}
            </Button>
            <Button size="xs" variant="outline" onClick={() => handleOpenEdit(row)}>
              {t("actions.edit")}
            </Button>
            <Button size="xs" variant="destructive" onClick={() => handleDelete(row.id)}>
              {t("actions.delete")}
            </Button>
          </div>
        )}
      />
      {selected.length > 0 && (
        <BatchActionBar
          selectedCount={selected.length}
          onClear={() => setSelected([])}
          actions={[{ label: t("batchDelete"), variant: "destructive", onClick: handleBatchDelete }]}
        />
      )}
      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editingProvider ? t("form.editTitle") : t("form.createTitle")}
        onSubmit={handleSave}
        loading={formSaving}
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium text-text-primary">{t("form.id")}</label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                disabled={!!editingProvider}
                placeholder={t("form.idPlaceholder")}
                className="mt-1 font-mono text-sm"
              />
              {editingProvider && <p className="text-xs text-text-muted mt-1">{t("form.idImmutable")}</p>}
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">{t("form.displayName")}</label>
              <Input
                value={formDisplayName}
                onChange={(e) => setFormDisplayName(e.target.value)}
                placeholder={t("form.displayNamePlaceholder")}
                className="mt-1"
              />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-text-primary">{t("form.protocol")}</label>
            <Select value={formNpm} onValueChange={setFormNpm}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NPM_OPTIONS.map((opt) => (
                  <SelectItem key={opt.id} value={opt.id}>
                    {getNpmLabel(opt)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-text-muted mt-1">
              {t("form.sdkPackage")}{" "}
              <code className="font-mono bg-surface-2 px-1 rounded">
                {formNpm === "custom"
                  ? formCustomNpm.trim() || "—"
                  : (NPM_OPTIONS.find((o) => o.id === formNpm)?.npm ?? "")}
              </code>
            </p>
            {formNpm === "custom" && (
              <Input
                value={formCustomNpm}
                onChange={(e) => setFormCustomNpm(e.target.value)}
                placeholder={t("form.customNpmPlaceholder")}
                className="mt-2 font-mono text-sm"
              />
            )}
          </div>
          <div>
            <label className="text-sm font-medium text-text-primary">{t("form.apiKey")}</label>
            <Input
              type="password"
              value={formApiKey}
              onChange={(e) => setFormApiKey(e.target.value)}
              placeholder={editingProvider ? t("form.apiKeyEditPlaceholder") : t("form.apiKeyCreatePlaceholder")}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-text-primary">{t("form.baseUrl")}</label>
            <Input
              value={formBaseURL}
              onChange={(e) => setFormBaseURL(e.target.value)}
              placeholder={t("form.baseUrlPlaceholder")}
              className="mt-1"
            />
          </div>
        </div>
      </FormDialog>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("deleteProvider.confirmTitle")}
        description={t("deleteProvider.confirmDesc", { name: deleteTarget ?? "" })}
        variant="destructive"
        onConfirm={confirmDelete}
      />
      <ConfirmDialog
        open={batchConfirmOpen}
        onOpenChange={setBatchConfirmOpen}
        title={t("batchDeleteConfirmTitle")}
        description={t("batchDeleteConfirmDesc", { count: selected.length })}
        variant="destructive"
        onConfirm={confirmBatchDelete}
      />
      <Dialog open={!!testResult} onOpenChange={() => setTestResult(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {testResult && "error" in testResult
                ? t("testDialog.failTitle", { name: testResult.name })
                : t("testDialog.successTitle", { name: testResult?.name ?? "" })}
            </DialogTitle>
            <DialogDescription>
              {testResult && "error" in testResult
                ? (testResult as { name: string; error: string }).error
                : t("testDialog.modelsFound", {
                    count: (testResult as { name: string; models: string[] } | null)?.models?.length ?? 0,
                  })}
            </DialogDescription>
          </DialogHeader>
          {testResult &&
            !("error" in testResult) &&
            (testResult.warning ? (
              <div className="text-sm py-2.5 px-3 rounded-lg bg-warning-bg text-warning-text border border-warning-border">
                {testResult.warning}
              </div>
            ) : null)}
          {testResult && !("error" in testResult) && testResult.models.length > 0 && (
            <div className="max-h-72 overflow-y-auto grid gap-1.5">
              {(testResult as { name: string; models: string[] }).models.map((m) => {
                const added = addedModelIds.has(m);
                return (
                  <div
                    key={m}
                    className={`flex items-center justify-between text-sm py-2 px-3 rounded-lg border transition-colors ${
                      added
                        ? "bg-surface-2 border-border-light"
                        : "bg-surface-1 border-border-light hover:border-brand/30"
                    }`}
                  >
                    <span className="font-mono text-xs text-text-primary">{m}</span>
                    {added ? (
                      <span className="text-xs text-status-active font-medium">{t("testDialog.added")}</span>
                    ) : (
                      <Button size="xs" variant="outline" onClick={() => handleAddFromTest(m)}>
                        {t("actions.add")}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
