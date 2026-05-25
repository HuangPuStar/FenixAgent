import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { FormDialog } from "@/components/config/FormDialog";
import { ModelConfigDialog } from "@/components/config/ModelConfigDialog";
import { StatusBadge } from "@/components/config/StatusBadge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { modelApi, providerApi } from "@/src/api/sdk";
import { dispatchConfigChange } from "../../../lib/config-events";
import type { ModelConfig, ProviderInfo, ProviderModel } from "../../../types/config";
import { AgentCardList } from "../shared/AgentCardList";
import { AgentPageHeader } from "../shared/AgentPageHeader";

const NPM_OPTIONS = [
  { id: "openai-compatible", labelKey: "npmOptions.openaiCompatible", npm: "@ai-sdk/openai-compatible" },
  { id: "anthropic", labelKey: "npmOptions.anthropic", npm: "@ai-sdk/anthropic" },
  { id: "deepseek", labelKey: "npmOptions.deepseek", npm: "@ai-sdk/deepseek" },
];

const INPUT_MODALITY_OPTIONS = ["text", "image", "audio", "video", "pdf"] as const;
const OUTPUT_MODALITY_OPTIONS = ["text", "image"] as const;

export function AgentModelsPage() {
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
  const [formDisplayName, setFormDisplayName] = useState("");
  const [formSaving, setFormSaving] = useState(false);
  const [modelConfig, setModelConfig] = useState<ModelConfig | null>(null);

  // Model form state
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [isNewModel, setIsNewModel] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  const [modelProviderId, setModelProviderId] = useState("");
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
  const [deleteModelConfirm, setDeleteModelConfirm] = useState<{ providerId: string; modelId: string } | null>(null);

  const getNpmLabel = (opt: (typeof NPM_OPTIONS)[number]) => t(opt.labelKey);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [providersResult, modelConfigResult] = await Promise.all([
        (async () => {
          const { data: listResult, error: listErr } = await providerApi.list();
          if (listErr) throw new Error(listErr.message);
          const data = Array.isArray(listResult)
            ? (listResult as unknown as ProviderInfo[])
            : (((listResult as unknown as Record<string, unknown>)?.providers ?? []) as unknown as ProviderInfo[]);
          const modelsMap: Record<string, ProviderModel[]> = {};
          await Promise.all(
            data.map(async (p) => {
              try {
                const { data: detail } = await providerApi.get(p.id);
                modelsMap[p.id] = (detail as unknown as { models?: ProviderModel[] }).models ?? [];
              } catch {
                modelsMap[p.id] = [];
              }
            }),
          );
          return { providers: data, providerModels: modelsMap };
        })(),
        modelApi.get(),
      ]);
      setProviders(providersResult.providers);
      setProviderModels(providersResult.providerModels);
      if (modelConfigResult.data) setModelConfig(modelConfigResult.data as unknown as ModelConfig);
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

  const handleOpenCreate = () => {
    setEditingProvider(null);
    setFormName("");
    setFormApiKey("");
    setFormBaseURL("");
    setFormNpm("openai-compatible");
    setFormDisplayName("");
    setDialogOpen(true);
  };

  const handleOpenEdit = (provider: ProviderInfo) => {
    setEditingProvider(provider);
    setFormName(provider.id);
    setFormApiKey("");
    setFormBaseURL(provider.baseURL ?? "");
    const matchOpt = NPM_OPTIONS.find((o) => o.npm === provider.npm);
    setFormNpm(matchOpt ? matchOpt.id : "openai-compatible");
    setFormDisplayName(provider.name !== provider.id ? provider.name : "");
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formName.trim()) {
      toast.error(t("validation.nameEmpty"));
      return;
    }
    setFormSaving(true);
    try {
      const npmPackage = NPM_OPTIONS.find((o) => o.id === formNpm)?.npm ?? "@ai-sdk/openai-compatible";
      const data: Record<string, unknown> = {};
      if (formApiKey) data.apiKey = formApiKey;
      if (formBaseURL) data.baseURL = formBaseURL;
      if (npmPackage) data.npm = npmPackage;
      if (formDisplayName) data.name = formDisplayName;
      await providerApi.set(formName, data);
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
    try {
      const { data: result, error: testErr } = await providerApi.test(name);
      if (testErr) throw new Error(testErr.message);
      const r = result as unknown as Record<string, unknown>;
      const modelIds = Array.isArray(r?.models)
        ? (r.models as unknown as Array<{ id?: string }>).map((m: { id?: string }) => m.id ?? String(m))
        : [];
      setTestResult({ name, models: modelIds, warning: (r?.warning ?? undefined) as string | undefined });
      setAddedModelIds(new Set((providerModels[name] ?? []).map((m) => m.id)));
    } catch (e) {
      setTestResult({ name, error: e instanceof Error ? e.message : t("unknownError") });
    } finally {
      setTesting(null);
    }
  };

  const handleAddFromTest = async (modelId: string) => {
    if (!testResult || "error" in testResult) return;
    const { error } = await providerApi.addModel(testResult.name, { modelId, name: modelId });
    if (error) {
      console.error(error);
      toast.error(t("testDialog.addModelError", { message: error.message }));
      return;
    }
    setAddedModelIds((prev) => new Set(prev).add(modelId));
    toast.success(t("testDialog.addModelSuccess", { modelId }));
    dispatchConfigChange("models");
    loadAll();
  };

  const handleDelete = (name: string) => {
    setDeleteTarget(name);
    setConfirmOpen(true);
  };
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const { error } = await providerApi.delete(deleteTarget);
    if (error) {
      console.error(error);
      toast.error(t("deleteProvider.error", { message: error.message }));
      return;
    }
    toast.success(t("deleteProvider.success"));
    setConfirmOpen(false);
    loadAll();
    dispatchConfigChange("providers");
  };

  const confirmBatchDelete = async () => {
    await Promise.all(selected.map((p) => providerApi.delete(p.id)));
    toast.success(t("batchDeleteCount", { count: selected.length }));
    setBatchConfirmOpen(false);
    setSelected([]);
    loadAll();
    dispatchConfigChange("providers");
  };

  // Model CRUD
  const openNewModel = (providerId: string) => {
    setModelProviderId(providerId);
    setIsNewModel(true);
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
    setModelDialogOpen(true);
  };

  const openEditModel = (providerId: string, m: ProviderModel) => {
    setModelProviderId(providerId);
    setIsNewModel(false);
    setMfId(m.id);
    setMfName(m.name);
    const limit = (m.limit as Record<string, number | undefined>) ?? {};
    setMfContext(limit.context ? String(limit.context) : "");
    setMfOutput(limit.output ? String(limit.output) : "");
    const modalities = (m.modalities as { input?: string[]; output?: string[] }) ?? {};
    setMfInputModalities(modalities.input ?? ["text"]);
    setMfOutputModalities(modalities.output ?? ["text"]);
    const cost = (m.cost as Record<string, number | undefined>) ?? {};
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
    data.modalities = { input: mfInputModalities, output: mfOutputModalities };
    const options: Record<string, unknown> = {};
    if (mfThinkingEnabled) {
      const th: Record<string, unknown> = { enabled: true };
      if (mfThinkingBudget) th.budgetTokens = Number(mfThinkingBudget);
      options.thinking = th;
    }
    if (Object.keys(options).length > 0) data.options = options;
    const cost: Record<string, unknown> = {};
    if (mfCostInput) cost.input = Number(mfCostInput);
    if (mfCostOutput) cost.output = Number(mfCostOutput);
    if (Object.keys(cost).length > 0) data.cost = cost;
    setModelSaving(true);
    try {
      if (isNewModel) {
        const { error } = await providerApi.addModel(modelProviderId, data);
        if (error) {
          toast.error(t("modelSubrow.saveModel.errorGeneric", { message: error.message }));
          return;
        }
      } else {
        const { error } = await providerApi.updateModel(modelProviderId, { modelId: mfId, ...data });
        if (error) {
          toast.error(t("modelSubrow.saveModel.errorGeneric", { message: error.message }));
          return;
        }
      }
      toast.success(isNewModel ? t("modelSubrow.saveModel.successCreate") : t("modelSubrow.saveModel.successUpdate"));
      setModelDialogOpen(false);
      loadAll();
      dispatchConfigChange("models");
    } catch (e) {
      console.error(e);
      toast.error(
        t("modelSubrow.saveModel.errorGeneric", { message: e instanceof Error ? e.message : t("unknownError") }),
      );
    } finally {
      setModelSaving(false);
    }
  };

  const handleModelDelete = async () => {
    if (!deleteModelConfirm) return;
    const { error } = await providerApi.removeModel(deleteModelConfirm.providerId, deleteModelConfirm.modelId);
    if (error) {
      console.error(error);
      toast.error(t("modelSubrow.deleteModel.error", { message: error.message }));
      return;
    }
    toast.success(t("modelSubrow.deleteModel.success"));
    setDeleteModelConfirm(null);
    loadAll();
    dispatchConfigChange("models");
  };

  const toggleModality = (list: string[], item: string, setter: (v: string[]) => void) => {
    setter(list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  };

  if (loading) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <AgentPageHeader title={t("title")} subtitle={t("subtitle")} />
        <div className="flex-1 overflow-y-auto p-6 space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <AgentPageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <div className="flex items-center gap-2">
            <ModelConfigDialog
              currentModel={modelConfig?.current.model ?? null}
              currentSmallModel={modelConfig?.current.small_model ?? null}
              available={modelConfig?.available ?? []}
            />
            <Button onClick={handleOpenCreate}>{t("createButton")}</Button>
          </div>
        }
      />
      <AgentCardList
        items={providers}
        cardKey={(p) => p.id}
        searchPlaceholder={t("searchPlaceholder")}
        searchFn={(p, q) => p.id.toLowerCase().includes(q) || (p.name?.toLowerCase().includes(q) ?? false)}
        selectable
        selectedItems={selected}
        onSelectionChange={setSelected}
        emptyMessage={t("emptyMessage")}
        batchActions={
          <Button size="xs" variant="destructive" onClick={() => setBatchConfirmOpen(true)}>
            {t("batchDelete")}
          </Button>
        }
        renderCard={(provider, isSelected, toggleSelect) => {
          const models = providerModels[provider.id] ?? [];
          return (
            <Collapsible
              key={provider.id}
              className="group rounded-lg border border-border-light bg-surface-1 transition-colors hover:border-border-active hover:shadow-sm"
            >
              <div className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={toggleSelect}
                    className="rounded border-border"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-sm font-medium text-text-bright">{provider.id}</span>
                      {provider.name && provider.name !== provider.id && (
                        <span className="text-xs text-text-secondary">{provider.name}</span>
                      )}
                      {(() => {
                        const opt = NPM_OPTIONS.find((o) => o.npm === provider.npm);
                        return (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-surface-2 text-text-secondary">
                            {opt ? getNpmLabel(opt) : provider.npm || "—"}
                          </span>
                        );
                      })()}
                      {provider.keyHint && (
                        <span className="font-mono text-xs text-text-muted bg-surface-2 px-2 py-0.5 rounded">
                          ***{provider.keyHint}
                        </span>
                      )}
                      <StatusBadge status={provider.configured ? "configured" : "unconfigured"} />
                      <span
                        className={`inline-flex items-center justify-center min-w-[24px] h-5 px-1.5 rounded-full text-xs font-medium ${provider.modelCount > 0 ? "bg-brand-subtle text-brand dark:text-brand-light" : "bg-surface-2 text-text-muted"}`}
                      >
                        {provider.modelCount}
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => handleTest(provider.id)}
                      disabled={testing === provider.id}
                    >
                      {testing === provider.id ? t("actions.testing") : t("actions.test")}
                    </Button>
                    <Button size="xs" variant="outline" onClick={() => handleOpenEdit(provider)}>
                      {t("actions.edit")}
                    </Button>
                    <Button size="xs" variant="destructive" onClick={() => handleDelete(provider.id)}>
                      {t("actions.delete")}
                    </Button>
                  </div>
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className="text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded hover:bg-surface-hover"
                    >
                      {t("columns.models")} ({models.length})
                    </button>
                  </CollapsibleTrigger>
                </div>
              </div>
              <CollapsibleContent>
                <div className="px-4 pb-3 space-y-2 border-t border-border-subtle pt-3">
                  {models.length === 0 ? (
                    <p className="text-center text-text-muted text-sm py-4">{t("modelSubrow.emptyMessage")}</p>
                  ) : (
                    models.map((m) => {
                      const limit = (m.limit as Record<string, number | undefined>) ?? {};
                      const cost = (m.cost as Record<string, number | undefined>) ?? {};
                      return (
                        <div
                          key={m.id}
                          className="flex items-center gap-3 rounded-md border border-border-light bg-surface-0 px-3 py-2"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs font-medium text-text-bright">{m.id}</span>
                              {m.name && m.name !== m.id && (
                                <span className="text-xs text-text-secondary">{m.name}</span>
                              )}
                            </div>
                            <div className="flex items-center gap-3 mt-0.5 text-[11px] text-text-muted">
                              {limit.context ? <span>ctx {Number(limit.context).toLocaleString()}</span> : null}
                              {limit.output ? <span>out {Number(limit.output).toLocaleString()}</span> : null}
                              {cost.input || cost.output ? (
                                <span className="text-amber-600">
                                  ${Number(cost.input ?? 0)}/{Number(cost.output ?? 0)}
                                </span>
                              ) : null}
                            </div>
                          </div>
                          <Button size="xs" variant="outline" onClick={() => openEditModel(provider.id, m)}>
                            {t("actions.edit")}
                          </Button>
                          <Button
                            size="xs"
                            variant="destructive"
                            onClick={() => setDeleteModelConfirm({ providerId: provider.id, modelId: m.id })}
                          >
                            {t("actions.delete")}
                          </Button>
                        </div>
                      );
                    })
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openNewModel(provider.id)}
                    className="w-full border-dashed text-text-secondary hover:text-text-primary hover:border-brand"
                  >
                    {t("modelSubrow.addButton")}
                  </Button>
                </div>
              </CollapsibleContent>
            </Collapsible>
          );
        }}
      />

      {/* Provider form dialog */}
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
                {NPM_OPTIONS.find((o) => o.id === formNpm)?.npm ?? ""}
              </code>
            </p>
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

      {/* Model form dialog */}
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
              <Input value={mfId} onChange={(e) => setMfId(e.target.value)} disabled={!isNewModel} className="mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">{t("modelSubrow.displayName")}</label>
              <Input value={mfName} onChange={(e) => setMfName(e.target.value)} className="mt-1" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium text-text-primary">{t("modelSubrow.contextLimit")}</label>
              <Input
                type="number"
                value={mfContext}
                onChange={(e) => setMfContext(e.target.value)}
                className="mt-1 font-mono text-sm"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">{t("modelSubrow.outputLimit")}</label>
              <Input
                type="number"
                value={mfOutput}
                onChange={(e) => setMfOutput(e.target.value)}
                className="mt-1 font-mono text-sm"
              />
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
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors border ${mfInputModalities.includes(m) ? "bg-indigo-100 text-indigo-700 border-indigo-300" : "bg-surface-2 text-text-secondary border-border-light"}`}
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
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors border ${mfOutputModalities.includes(m) ? "bg-emerald-100 text-emerald-700 border-emerald-300" : "bg-surface-2 text-text-secondary border-border-light"}`}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowAdvanced(!showAdvanced)}>
            {showAdvanced ? t("modelSubrow.hideAdvanced") : t("modelSubrow.showAdvanced")}
          </Button>
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
                    className="mt-1"
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </FormDialog>

      {/* Test result dialog */}
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
                ? (testResult as { error: string }).error
                : t("testDialog.modelsFound", {
                    count: (testResult as { models: string[] } | null)?.models?.length ?? 0,
                  })}
            </DialogDescription>
          </DialogHeader>
          {testResult && !("error" in testResult) && testResult.models.length > 0 && (
            <div className="max-h-72 overflow-y-auto grid gap-1.5">
              {(testResult as { models: string[] }).models.map((m) => {
                const added = addedModelIds.has(m);
                return (
                  <div
                    key={m}
                    className={`flex items-center justify-between text-sm py-2 px-3 rounded-lg border ${added ? "bg-surface-2 border-border-light" : "bg-surface-1 border-border-light hover:border-brand/30"}`}
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
      <ConfirmDialog
        open={!!deleteModelConfirm}
        onOpenChange={() => setDeleteModelConfirm(null)}
        title={t("modelSubrow.deleteModel.confirmTitle")}
        description={t("modelSubrow.deleteModel.confirmDesc", { id: deleteModelConfirm?.modelId ?? "" })}
        variant="destructive"
        onConfirm={handleModelDelete}
      />
    </div>
  );
}
