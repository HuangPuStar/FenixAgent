import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { FormDialog } from "@/components/config/FormDialog";
import { ModelConfigDialog, mergeModelConfigUpdate } from "@/components/config/ModelConfigDialog";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { modelApi, providerApi } from "@/src/api/sdk";
import { NS } from "../../../i18n";
import { dispatchConfigChange } from "../../../lib/config-events";
import type { ModelConfig, ProviderInfo, ProviderModel } from "../../../types/config";
import { AgentCardList } from "../shared/AgentCardList";
import { AgentPageHeader } from "../shared/AgentPageHeader";

type TestDialogError = {
  code: string;
  message: string;
  data?: unknown;
};

const PROTOCOL_OPTIONS = [
  { id: "openai", labelKey: "protocolOptions.openai" },
  { id: "anthropic", labelKey: "protocolOptions.anthropic" },
];

const INPUT_MODALITY_OPTIONS = ["text", "image", "audio", "video", "pdf"] as const;
const OUTPUT_MODALITY_OPTIONS = ["text", "image"] as const;

function getErrorDataRecord(data: unknown): Record<string, unknown> {
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
}

export function getProviderKey(provider: ProviderInfo): string {
  return provider.resourceAccess?.resourceKey ?? provider.resourceKey ?? provider.id;
}

export function getProviderDisplayName(provider: ProviderInfo): string {
  const source = provider.resourceAccess?.sourceOrganizationName;
  if (source) return `${source}/${provider.id}`;
  return provider.id;
}

export function getProviderResourceBadgeKey(provider: ProviderInfo): string {
  if (provider.resourceAccess?.ownership === "external") return "resource.external";
  if (provider.resourceAccess?.publicReadable) return "resource.public";
  return "resource.internal";
}

export function canWriteProvider(provider: ProviderInfo): boolean {
  return provider.resourceAccess?.writable !== false;
}

export function buildProviderPublicReadablePayload(
  options: Record<string, unknown>,
  publicReadable: boolean,
): Record<string, unknown> {
  return { ...options, publicReadable };
}

export function AgentModelsPage() {
  const { t } = useTranslation("models");
  const { t: tComponents } = useTranslation(NS.COMPONENTS);
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
    | { kind: "provider"; name: string; models: string[]; warning?: string }
    | { kind: "provider"; name: string; error: TestDialogError }
    | { kind: "model"; providerName: string; modelId: string; content: string }
    | { kind: "model"; providerName: string; modelId: string; error: TestDialogError }
    | null
  >(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testingModelKey, setTestingModelKey] = useState<string | null>(null);
  const [addedModelIds, setAddedModelIds] = useState<Set<string>>(new Set());
  const [sharingProviderKey, setSharingProviderKey] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formApiKey, setFormApiKey] = useState("");
  const [formBaseURL, setFormBaseURL] = useState("");
  const [formProtocol, setFormProtocol] = useState<"openai" | "anthropic">("openai");
  const [formDisplayName, setFormDisplayName] = useState("");
  const [formSaving, setFormSaving] = useState(false);
  const [modelConfig, setModelConfig] = useState<ModelConfig | null>(null);
  const editingReadOnly = editingProvider ? !canWriteProvider(editingProvider) : false;

  // 表单内模型获取相关状态
  const [formAvailableModels, setFormAvailableModels] = useState<string[]>([]);
  const [formSelectedModels, setFormSelectedModels] = useState<Set<string>>(new Set());
  const [formFetchingModels, setFormFetchingModels] = useState(false);
  const [formModelsFetched, setFormModelsFetched] = useState(false);

  // Model form state
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [isNewModel, setIsNewModel] = useState(false);
  const [modelReadOnly, setModelReadOnly] = useState(false);
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

  const getProtocolLabel = (opt: (typeof PROTOCOL_OPTIONS)[number]) => t(opt.labelKey);

  const formatTestError = (error: TestDialogError) => {
    const errorData = getErrorDataRecord(error.data);
    const protocol = errorData.protocol === "anthropic" ? "anthropic" : "openai";
    const protocolLabel = t(`protocolOptions.${protocol}`);
    const status = typeof errorData.status === "number" ? errorData.status : undefined;
    const detail = typeof errorData.detail === "string" && errorData.detail ? `: ${errorData.detail}` : "";
    const reason = typeof errorData.reason === "string" ? errorData.reason : undefined;
    const hint =
      errorData.hint === "configure_model_then_test_model"
        ? `\n\n${t("testDialog.errors.configureModelThenTest")}`
        : "";

    switch (error.code) {
      case "PROVIDER_TEST_LIST_HTTP_ERROR":
        return `${t("testDialog.errors.providerListHttp", { protocol: protocolLabel, status: status ?? "-" })}${detail}${hint}`;
      case "PROVIDER_TEST_LIST_RESPONSE_INVALID":
        if (reason === "missing_model_id") {
          return t("testDialog.errors.providerListMissingModelId", { protocol: protocolLabel });
        }
        return t("testDialog.errors.providerListMissingData", { protocol: protocolLabel });
      case "MODEL_TEST_MESSAGE_HTTP_ERROR":
        return `${t("testDialog.errors.modelMessageHttp", { protocol: protocolLabel, status: status ?? "-" })}${detail}`;
      case "MODEL_TEST_MESSAGE_RESPONSE_INVALID":
        return t("testDialog.errors.modelMessageEmpty", { protocol: protocolLabel });
      case "CONFIG_TEST_REQUEST_FAILED":
        if (reason === "timeout") {
          return t("testDialog.errors.requestTimeout");
        }
        return detail
          ? `${t("testDialog.errors.requestFailed")}: ${String(errorData.detail)}`
          : t("testDialog.errors.requestFailed");
      default:
        return error.message || t("unknownError");
    }
  };

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
              const providerKey = getProviderKey(p);
              try {
                const { data: detail } = await providerApi.get(providerKey);
                modelsMap[providerKey] = (detail as unknown as { models?: ProviderModel[] }).models ?? [];
              } catch {
                modelsMap[providerKey] = [];
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
    setFormProtocol("openai");
    setFormDisplayName("");
    resetFormModelState();
    setDialogOpen(true);
  };

  const handleOpenEdit = (provider: ProviderInfo) => {
    setEditingProvider(provider);
    setFormName(provider.id);
    setFormApiKey("");
    setFormBaseURL(provider.baseURL ?? "");
    setFormProtocol(provider.protocol);
    setFormDisplayName(provider.name !== provider.id ? provider.name : "");
    resetFormModelState();
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formName.trim()) {
      toast.error(t("validation.nameEmpty"));
      return;
    }
    setFormSaving(true);
    try {
      const data: Record<string, unknown> = {};
      if (formApiKey) data.apiKey = formApiKey;
      if (formBaseURL) data.baseURL = formBaseURL;
      data.protocol = formProtocol;
      if (formDisplayName) data.name = formDisplayName;
      await providerApi.set(formName, data);

      // 导入勾选的模型（逐个添加，忽略失败）
      let modelsAdded = false;
      for (const modelId of formSelectedModels) {
        try {
          await providerApi.addModel(formName, { modelId, name: modelId });
          modelsAdded = true;
        } catch {
          // 模型添加失败静默处理
        }
      }

      toast.success(editingProvider ? t("saveProvider.successUpdate") : t("saveProvider.successCreate"));
      setDialogOpen(false);
      loadAll();
      dispatchConfigChange("providers");
      if (modelsAdded) dispatchConfigChange("models");
    } catch (e) {
      console.error(t("saveProvider.errorGeneric", { message: "" }), e);
      toast.error(t("saveProvider.errorGeneric", { message: e instanceof Error ? e.message : t("unknownError") }));
    } finally {
      setFormSaving(false);
    }
  };

  const handleTogglePublic = async (provider: ProviderInfo, next: boolean) => {
    const providerKey = getProviderKey(provider);
    setSharingProviderKey(providerKey);
    try {
      const { data: detail, error: getError } = await providerApi.get(providerKey);
      if (getError) {
        toast.error(t("loadProviderDetailError", { message: getError.message }));
        return;
      }
      const options = ((detail as unknown as { options?: Record<string, unknown> })?.options ?? {}) as Record<
        string,
        unknown
      >;
      const { error } = await providerApi.set(provider.id, buildProviderPublicReadablePayload(options, next));
      if (error) {
        toast.error(t("saveProvider.errorGeneric", { message: error.message }));
        return;
      }
      toast.success(next ? tComponents("resource.makePublic") : tComponents("resource.makePrivate"));
      loadAll();
      dispatchConfigChange("providers");
    } catch (e) {
      toast.error(t("saveProvider.errorGeneric", { message: e instanceof Error ? e.message : t("unknownError") }));
    } finally {
      setSharingProviderKey(null);
    }
  };

  // 表单内获取模型列表
  // 新建：用 inline 凭证测试，无需先保存
  // 编辑：直接测试已保存的 provider
  const handleFetchModels = async () => {
    if (!formName.trim()) {
      toast.error(t("validation.nameEmpty"));
      return;
    }
    setFormFetchingModels(true);
    setFormModelsFetched(false);
    try {
      let result: unknown;
      let testErr: unknown = null;

      if (editingProvider) {
        // 编辑：先更新再测试
        const data: Record<string, unknown> = {};
        if (formApiKey) data.apiKey = formApiKey;
        if (formBaseURL) data.baseURL = formBaseURL;
        data.protocol = formProtocol;
        if (formDisplayName) data.name = formDisplayName;
        await providerApi.set(formName, data);
        const res = await providerApi.test(formName);
        result = res.data;
        testErr = res.error;
      } else {
        // 新建：用 inline 凭证测试，不保存
        const res = await providerApi.test(formName, {
          apiKey: formApiKey || undefined,
          baseURL: formBaseURL || undefined,
          protocol: formProtocol,
        });
        result = res.data;
        testErr = res.error;
      }

      if (testErr) {
        setFormAvailableModels([]);
        setFormModelsFetched(true);
        return;
      }
      const r = result as unknown as Record<string, unknown>;
      const modelIds = Array.isArray(r?.models)
        ? (r.models as unknown as Array<{ id?: string }>).map((m: { id?: string }) => m.id ?? String(m))
        : [];
      setFormAvailableModels(modelIds);
      setFormModelsFetched(true);

      // 已存在的模型默认选中
      const existingIds = new Set((providerModels[formName] ?? []).map((m) => m.id));
      setFormSelectedModels(existingIds);
    } catch {
      setFormAvailableModels([]);
      setFormModelsFetched(true);
    } finally {
      setFormFetchingModels(false);
    }
  };

  // 重置表单时的清理
  const resetFormModelState = () => {
    setFormAvailableModels([]);
    setFormSelectedModels(new Set());
    setFormFetchingModels(false);
    setFormModelsFetched(false);
  };

  // 存储最新的 handleFetchModels 引用，避免 useEffect 依赖它导致无限循环
  const handleFetchModelsRef = useRef(handleFetchModels);
  handleFetchModelsRef.current = handleFetchModels;

  // API Key 或 Base URL 变化时自动获取模型列表（800ms 防抖）
  useEffect(() => {
    if (!dialogOpen || !formName.trim()) return;
    if (!formApiKey.trim() && !formBaseURL.trim()) return;

    const timer = setTimeout(() => {
      handleFetchModelsRef.current();
    }, 800);

    return () => clearTimeout(timer);
  }, [formApiKey, formBaseURL, dialogOpen, formName]);

  const handleTest = async (name: string) => {
    setTesting(name);
    try {
      const { data: result, error: testErr } = await providerApi.test(name);
      if (testErr) {
        setTestResult({ kind: "provider", name, error: testErr });
        return;
      }
      const r = result as unknown as Record<string, unknown>;
      const modelIds = Array.isArray(r?.models)
        ? (r.models as unknown as Array<{ id?: string }>).map((m: { id?: string }) => m.id ?? String(m))
        : [];
      setTestResult({
        kind: "provider",
        name,
        models: modelIds,
        warning: (r?.warning ?? undefined) as string | undefined,
      });
      setAddedModelIds(new Set((providerModels[name] ?? []).map((m) => m.id)));
    } catch (e) {
      setTestResult({
        kind: "provider",
        name,
        error: { code: "UNKNOWN_ERROR", message: e instanceof Error ? e.message : t("unknownError") },
      });
    } finally {
      setTesting(null);
    }
  };

  const handleAddFromTest = async (modelId: string) => {
    if (testResult?.kind !== "provider" || "error" in testResult) return;
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

  const handleTestModel = async (providerId: string, modelId: string) => {
    const key = `${providerId}:${modelId}`;
    setTestingModelKey(key);
    try {
      const { data, error } = await providerApi.testModel(providerId, modelId);
      if (error) {
        setTestResult({ kind: "model", providerName: providerId, modelId, error });
        return;
      }
      const result = data as unknown as { content?: string };
      setTestResult({ kind: "model", providerName: providerId, modelId, content: result.content ?? "" });
    } catch (e) {
      setTestResult({
        kind: "model",
        providerName: providerId,
        modelId,
        error: { code: "UNKNOWN_ERROR", message: e instanceof Error ? e.message : t("unknownError") },
      });
    } finally {
      setTestingModelKey(null);
    }
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
    setModelReadOnly(false);
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
    setModelReadOnly(false);
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

  const openViewModel = (providerId: string, m: ProviderModel) => {
    setModelProviderId(providerId);
    setIsNewModel(false);
    setModelReadOnly(true);
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
        const { error } = await providerApi.updateModel(modelProviderId, mfId, data);
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
              onConfigChange={(update) =>
                setModelConfig((current) => (current ? mergeModelConfigUpdate(current, update) : current))
              }
            />
            <Button onClick={handleOpenCreate}>{t("createButton")}</Button>
          </div>
        }
      />
      <AgentCardList
        items={providers}
        cardKey={getProviderKey}
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
          const providerKey = getProviderKey(provider);
          const providerDisplayName = getProviderDisplayName(provider);
          const writable = canWriteProvider(provider);
          const models = providerModels[providerKey] ?? [];
          return (
            <Collapsible
              key={providerKey}
              className="group rounded-lg border border-border-light bg-surface-1 transition-colors hover:border-border-active hover:shadow-sm"
            >
              <CollapsibleTrigger asChild>
                <div className="px-4 py-3 cursor-pointer group/trigger">
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={toggleSelect}
                      disabled={!writable}
                      onClick={(event) => event.stopPropagation()}
                      className="rounded border-border disabled:cursor-not-allowed disabled:opacity-50"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-sm font-medium text-text-bright">{providerDisplayName}</span>
                        {provider.name && provider.name !== provider.id && (
                          <span className="text-xs text-text-secondary">{provider.name}</span>
                        )}
                        {(() => {
                          const opt = PROTOCOL_OPTIONS.find((o) => o.id === provider.protocol);
                          return (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-surface-2 text-text-secondary">
                              {opt ? getProtocolLabel(opt) : provider.protocol}
                            </span>
                          );
                        })()}
                        {provider.keyHint && (
                          <span className="font-mono text-xs text-text-muted bg-surface-2 px-2 py-0.5 rounded">
                            {provider.keyHint}
                          </span>
                        )}
                        <span className="inline-flex items-center rounded-md bg-surface-2 px-2 py-0.5 text-xs font-medium text-text-secondary">
                          {tComponents(getProviderResourceBadgeKey(provider))}
                        </span>
                      </div>
                      <label
                        className="mt-3 flex items-center gap-2 text-xs text-text-muted"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <Switch
                          checked={Boolean(provider.resourceAccess?.publicReadable)}
                          disabled={sharingProviderKey === providerKey || provider.resourceAccess?.manageable !== true}
                          onCheckedChange={() =>
                            void handleTogglePublic(provider, !provider.resourceAccess?.publicReadable)
                          }
                        />
                        {tComponents("resource.public")}
                      </label>
                      {!writable && (
                        <p className="mt-3 text-xs font-medium text-text-muted">{tComponents("resource.readOnly")}</p>
                      )}
                    </div>
                    <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      {writable && (
                        <>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleTest(providerKey);
                            }}
                            disabled={testing === providerKey}
                          >
                            {testing === providerKey ? t("actions.testing") : t("actions.test")}
                          </Button>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleOpenEdit(provider);
                            }}
                          >
                            {t("actions.edit")}
                          </Button>
                          <Button
                            size="xs"
                            variant="destructive"
                            onClick={(event) => {
                              event.stopPropagation();
                              handleDelete(provider.id);
                            }}
                          >
                            {t("actions.delete")}
                          </Button>
                        </>
                      )}
                      {!writable && (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleOpenEdit(provider);
                          }}
                        >
                          {t("actions.view")}
                        </Button>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-text-muted px-2 py-1 rounded">
                      <span>
                        {t("columns.models")} ({models.length})
                      </span>
                      <ChevronDown className="h-4 w-4 transition-transform duration-200 group-data-[state=open]/trigger:rotate-180" />
                    </div>
                  </div>
                </div>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="px-4 pb-3 space-y-2 border-t border-border-subtle pt-3">
                  {models.length === 0 ? (
                    <p className="text-center text-text-muted text-sm py-4">{t("modelSubrow.emptyMessage")}</p>
                  ) : (
                    models.map((m) => {
                      const limit = (m.limit as Record<string, number | undefined>) ?? {};
                      const cost = (m.cost as Record<string, number | undefined>) ?? {};
                      const modelWritable = writable && m.providerResourceAccess?.writable !== false;
                      const modelTesting = testingModelKey === `${providerKey}:${m.id}`;
                      return (
                        <div
                          key={m.id}
                          className="flex flex-wrap items-center gap-3 rounded-md border border-border-light bg-surface-0 px-3 py-2"
                        >
                          <div className="min-w-0 flex-1 basis-0">
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
                          <div className="ml-auto flex shrink-0 items-center gap-2">
                            {modelWritable ? (
                              <>
                                <Button
                                  size="xs"
                                  variant="outline"
                                  onClick={() => handleTestModel(providerKey, m.id)}
                                  disabled={modelTesting}
                                >
                                  {modelTesting ? t("actions.testing") : t("actions.test")}
                                </Button>
                                <Button size="xs" variant="outline" onClick={() => openEditModel(providerKey, m)}>
                                  {t("actions.edit")}
                                </Button>
                                <Button
                                  size="xs"
                                  variant="destructive"
                                  onClick={() => setDeleteModelConfirm({ providerId: providerKey, modelId: m.id })}
                                >
                                  {t("actions.delete")}
                                </Button>
                              </>
                            ) : (
                              <Button size="xs" variant="outline" onClick={() => openViewModel(providerKey, m)}>
                                {t("actions.view")}
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                  {writable && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openNewModel(providerKey)}
                      className="w-full border-dashed text-text-secondary hover:text-text-primary hover:border-brand"
                    >
                      {t("modelSubrow.addButton")}
                    </Button>
                  )}
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
        title={
          editingProvider ? (editingReadOnly ? t("form.detailTitle") : t("form.editTitle")) : t("form.createTitle")
        }
        onSubmit={handleSave}
        loading={formSaving}
        hideSubmit={editingReadOnly}
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium text-text-primary">{t("form.id")}</label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                disabled={editingReadOnly || !!editingProvider}
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
                disabled={editingReadOnly}
                placeholder={t("form.displayNamePlaceholder")}
                className="mt-1"
              />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-text-primary">{t("form.protocol")}</label>
            <Select
              value={formProtocol}
              onValueChange={(value) => setFormProtocol(value as "openai" | "anthropic")}
              disabled={editingReadOnly}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROTOCOL_OPTIONS.map((opt) => (
                  <SelectItem key={opt.id} value={opt.id}>
                    {getProtocolLabel(opt)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-sm font-medium text-text-primary">{t("form.apiKey")}</label>
            <Input
              type="password"
              value={formApiKey}
              onChange={(e) => setFormApiKey(e.target.value)}
              onBlur={() => {
                if (formName.trim() && formApiKey.trim()) handleFetchModels();
              }}
              disabled={editingReadOnly}
              placeholder={editingProvider ? t("form.apiKeyEditPlaceholder") : t("form.apiKeyCreatePlaceholder")}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-text-primary">{t("form.baseUrl")}</label>
            <Input
              value={formBaseURL}
              onChange={(e) => setFormBaseURL(e.target.value)}
              onBlur={() => {
                if (formName.trim() && formBaseURL.trim()) handleFetchModels();
              }}
              disabled={editingReadOnly}
              placeholder={t("form.baseUrlPlaceholder")}
              className="mt-1"
            />
          </div>

          {/* 模型列表获取与勾选 */}
          <div className="border-t border-border pt-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-text-primary">{t("form.modelsSection")}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleFetchModels}
                disabled={formFetchingModels || editingReadOnly}
              >
                {formFetchingModels ? t("form.fetching") : t("form.fetchModels")}
              </Button>
            </div>
            {formModelsFetched ? (
              formAvailableModels.length > 0 ? (
                <div className="max-h-48 overflow-y-auto border border-border rounded-lg p-2 space-y-1">
                  <label className="flex items-center gap-2 px-2 py-1 rounded hover:bg-surface-2 cursor-pointer">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-border"
                      checked={formSelectedModels.size === formAvailableModels.length && formAvailableModels.length > 0}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setFormSelectedModels(new Set(formAvailableModels));
                        } else {
                          setFormSelectedModels(new Set());
                        }
                      }}
                    />
                    <span className="text-xs text-text-muted">{t("form.selectAll")}</span>
                  </label>
                  {formAvailableModels.map((modelId) => (
                    <label
                      key={modelId}
                      className="flex items-center gap-2 px-2 py-1 rounded hover:bg-surface-2 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-border"
                        checked={formSelectedModels.has(modelId)}
                        onChange={(e) => {
                          const next = new Set(formSelectedModels);
                          if (e.target.checked) {
                            next.add(modelId);
                          } else {
                            next.delete(modelId);
                          }
                          setFormSelectedModels(next);
                        }}
                      />
                      <span className="text-sm font-mono text-text-primary">{modelId}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <div className="py-2">
                  <p className="text-xs text-text-muted">{t("form.noModelsFound")}</p>
                  <p className="text-xs text-text-muted mt-1">{t("form.noModelsHint")}</p>
                </div>
              )
            ) : formFetchingModels ? (
              <div className="flex items-center gap-2 py-2">
                <Skeleton className="h-5 w-5 rounded" />
                <span className="text-xs text-text-muted">{t("form.fetching")}</span>
              </div>
            ) : null}
          </div>
        </div>
      </FormDialog>

      {/* Model form dialog */}
      <FormDialog
        open={modelDialogOpen}
        onOpenChange={setModelDialogOpen}
        title={
          isNewModel
            ? t("modelSubrow.createTitle")
            : modelReadOnly
              ? t("modelSubrow.detailTitle", { id: mfId })
              : t("modelSubrow.editTitle", { id: mfId })
        }
        onSubmit={handleModelSave}
        loading={modelSaving}
        hideSubmit={modelReadOnly}
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium text-text-primary">{t("modelSubrow.modelId")}</label>
              <Input
                value={mfId}
                onChange={(e) => setMfId(e.target.value)}
                disabled={modelReadOnly || !isNewModel}
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">{t("modelSubrow.displayName")}</label>
              <Input
                value={mfName}
                onChange={(e) => setMfName(e.target.value)}
                disabled={modelReadOnly}
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
                disabled={modelReadOnly}
                className="mt-1 font-mono text-sm"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">{t("modelSubrow.outputLimit")}</label>
              <Input
                type="number"
                value={mfOutput}
                onChange={(e) => setMfOutput(e.target.value)}
                disabled={modelReadOnly}
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
                  onClick={() => {
                    if (modelReadOnly) return;
                    toggleModality(mfInputModalities, m, setMfInputModalities);
                  }}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors border ${mfInputModalities.includes(m) ? "bg-indigo-100 text-indigo-700 border-indigo-300" : "bg-surface-2 text-text-secondary border-border-light"}`}
                  disabled={modelReadOnly}
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
                  onClick={() => {
                    if (modelReadOnly) return;
                    toggleModality(mfOutputModalities, m, setMfOutputModalities);
                  }}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors border ${mfOutputModalities.includes(m) ? "bg-emerald-100 text-emerald-700 border-emerald-300" : "bg-surface-2 text-text-secondary border-border-light"}`}
                  disabled={modelReadOnly}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowAdvanced(!showAdvanced)}
            disabled={modelReadOnly}
          >
            {showAdvanced ? t("modelSubrow.hideAdvanced") : t("modelSubrow.showAdvanced")}
          </Button>
          {showAdvanced && (
            <div className="space-y-3 border-t pt-3">
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-text-primary">{t("modelSubrow.thinkingEnabled")}</label>
                <Switch checked={mfThinkingEnabled} disabled={modelReadOnly} onCheckedChange={setMfThinkingEnabled} />
              </div>
              {mfThinkingEnabled && (
                <div>
                  <label className="text-sm font-medium text-text-primary">{t("modelSubrow.thinkingBudget")}</label>
                  <Input
                    type="number"
                    value={mfThinkingBudget}
                    onChange={(e) => setMfThinkingBudget(e.target.value)}
                    disabled={modelReadOnly}
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
                    disabled={modelReadOnly}
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
                    disabled={modelReadOnly}
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
              {testResult?.kind === "provider" &&
                ("error" in testResult
                  ? t("testDialog.failTitle", { name: testResult.name })
                  : t("testDialog.successTitle", { name: testResult.name }))}
              {testResult?.kind === "model" &&
                ("error" in testResult
                  ? t("testDialog.modelFailTitle", { modelId: testResult.modelId })
                  : t("testDialog.modelSuccessTitle", { modelId: testResult.modelId }))}
            </DialogTitle>
            <DialogDescription className="whitespace-pre-line">
              {testResult?.kind === "provider" &&
                ("error" in testResult
                  ? formatTestError(testResult.error)
                  : t("testDialog.modelsFound", {
                      count: testResult.models.length,
                    }))}
              {testResult?.kind === "model" &&
                ("error" in testResult ? formatTestError(testResult.error) : testResult.content)}
            </DialogDescription>
          </DialogHeader>
          {testResult?.kind === "provider" && !("error" in testResult) && testResult.models.length > 0 && (
            <div className="max-h-72 overflow-y-auto grid gap-1.5">
              {testResult.models.map((m) => {
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
