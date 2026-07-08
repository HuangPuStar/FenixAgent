import { useRequest } from "ahooks";
import { Plus, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { FormDialog } from "@/components/config/FormDialog";
import { ModelIcon } from "@/components/model-icon/ModelIcon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { providerApi } from "@/src/api/providers";
import { ApiError, unwrap } from "@/src/api/request";
import { NS } from "../../../i18n";
import { dispatchConfigChange } from "../../../lib/config-events";
import type { ProviderInfo, ProviderModel } from "../../../types/config";
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

function getReadableErrorDetail(data: unknown): string | undefined {
  if (typeof data !== "string" || !data) return undefined;

  try {
    const parsed = JSON.parse(data) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message) {
      return parsed.message;
    }
  } catch {
    // 保留原始文本，兼容后端直接返回纯字符串 detail。
  }

  return data;
}

// Provider 工具函数从独立模块导入，避免组件文件加载 @lobehub/icons 后影响单元测试
import {
  buildProviderInlineTestPayload,
  buildProviderPublicReadablePayload,
  canWriteProvider,
  getProviderColor,
  getProviderKey,
} from "./agent-models-utils";

export function AgentModelsPage() {
  const { t } = useTranslation("models");
  const { t: tComponents } = useTranslation(NS.COMPONENTS);

  // 列表数据加载
  const {
    data: listData,
    loading,
    refresh,
  } = useRequest(
    async () => {
      const listResult = await unwrap(providerApi.list());
      const providers = listResult.providers;
      const modelsMap: Record<string, ProviderModel[]> = {};
      await Promise.all(
        providers.map(async (p) => {
          const providerKey = getProviderKey(p);
          try {
            const detail = await unwrap(providerApi.get(providerKey));
            modelsMap[providerKey] = detail.models ?? [];
          } catch {
            modelsMap[providerKey] = [];
          }
        }),
      );
      return { providers, modelsMap };
    },
    {
      onError: (err) => {
        console.error(t("loadModelsError"), err);
        toast.error(t("loadError", { message: err instanceof Error ? err.message : t("unknownError") }));
      },
    },
  );
  const providers = listData?.providers ?? [];
  const providerModels = listData?.modelsMap ?? {};

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderInfo | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [fetchModelsResult, setFetchModelsResult] = useState<
    | { kind: "provider"; name: string; models: string[]; warning?: string }
    | { kind: "provider"; name: string; error: TestDialogError }
    | { kind: "model"; providerName: string; modelId: string; content: string }
    | { kind: "model"; providerName: string; modelId: string; error: TestDialogError }
    | null
  >(null);
  const [addedModelIds, setAddedModelIds] = useState<Set<string>>(new Set());
  const [testing, setTesting] = useState<string | null>(null);
  const [testingModelKey, setTestingModelKey] = useState<string | null>(null);
  const [sharingProviderKey, setSharingProviderKey] = useState<string | null>(null);
  const [providerSearch, setProviderSearch] = useState("");
  const [formName, setFormName] = useState("");
  const [formApiKey, setFormApiKey] = useState("");
  const [formBaseURL, setFormBaseURL] = useState("");
  const [formProtocol, setFormProtocol] = useState<"openai" | "anthropic">("openai");
  const [formDisplayName, setFormDisplayName] = useState("");
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
  const isProviderFetchHint = (error: TestDialogError) =>
    getErrorDataRecord(error.data).hint === "configure_model_then_test_model";

  const formatTestError = (error: TestDialogError) => {
    const errorData = getErrorDataRecord(error.data);
    const protocol = errorData.protocol === "anthropic" ? "anthropic" : "openai";
    const protocolLabel = t(`protocolOptions.${protocol}`);
    const status = typeof errorData.status === "number" ? errorData.status : undefined;
    const readableDetail = getReadableErrorDetail(errorData.detail);
    const detail = readableDetail ? `\n${t("testDialog.errors.detailPrefix")}${readableDetail}` : "";
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
        return detail ? `${t("testDialog.errors.requestFailed")}${detail}` : t("testDialog.errors.requestFailed");
      default:
        return error.message || t("unknownError");
    }
  };

  const getProviderDialogDescription = (
    result: Extract<NonNullable<typeof fetchModelsResult>, { kind: "provider" }>,
  ) => {
    if ("error" in result) {
      if (isProviderFetchHint(result.error)) {
        return `${t("form.noModelsFound")}\n\n${t("form.noModelsHint")}`;
      }
      return formatTestError(result.error);
    }
    if (result.models.length > 0) {
      return t("testDialog.modelsFound", { count: result.models.length });
    }
    return `${t("form.noModelsFound")}\n\n${t("form.noModelsHint")}`;
  };

  // Provider 保存（创建/更新）：仅创建时 toast 提示
  const { run: runSave, loading: saving } = useRequest(
    async (name: string, data: Record<string, unknown>, selectedModels: Set<string>) => {
      await unwrap(providerApi.set(name, data as Record<string, unknown>));
      let modelsAdded = false;
      for (const modelId of selectedModels) {
        try {
          await unwrap(providerApi.addModel(name, { modelId, name: modelId } as Record<string, unknown>));
          modelsAdded = true;
        } catch {
          // 模型添加失败静默处理
        }
      }
      return modelsAdded;
    },
    {
      manual: true,
      onSuccess: (modelsAdded: boolean) => {
        if (!editingProvider) toast.success(t("saveProvider.successCreate"));
        setDialogOpen(false);
        refresh();
        dispatchConfigChange("providers");
        if (modelsAdded) dispatchConfigChange("models");
      },
      onError: (err: Error) => {
        console.error(t("saveProvider.errorGeneric", { message: "" }), err);
        toast.error(t("saveProvider.errorGeneric", { message: err.message }));
      },
    },
  );

  // 公开/私密切换：静默操作
  const { run: runTogglePublic } = useRequest(
    async (provider: ProviderInfo, next: boolean) => {
      await unwrap(providerApi.set(provider.id, buildProviderPublicReadablePayload(next) as Record<string, unknown>));
    },
    {
      manual: true,
      onSuccess: () => {
        setSharingProviderKey(null);
        refresh();
        dispatchConfigChange("providers");
      },
      onError: (err: Error) => {
        setSharingProviderKey(null);
        toast.error(t("saveProvider.errorGeneric", { message: err.message }));
      },
    },
  );

  // 删除 Provider：静默操作
  const { run: runDelete } = useRequest((name: string) => unwrap(providerApi.del(name)), {
    manual: true,
    onSuccess: () => {
      setConfirmOpen(false);
      refresh();
      dispatchConfigChange("providers");
    },
    onError: (err: Error) => {
      console.error(t("deleteProvider.error", { message: "" }), err);
      toast.error(t("deleteProvider.error", { message: err.message }));
    },
  });

  // Provider 获取模型列表
  const { run: runFetchModels } = useRequest(
    async (name: string) => {
      const result = await unwrap(providerApi.fetchModels(name));
      const r = result as unknown as Record<string, unknown>;
      const modelIds = Array.isArray(r?.models)
        ? (r.models as unknown as Array<{ id?: string }>).map((m: { id?: string }) => m.id ?? String(m))
        : [];
      return { name, models: modelIds, warning: (r?.warning ?? undefined) as string | undefined };
    },
    {
      manual: true,
      onSuccess: ({ name, models, warning }) => {
        setFetchModelsResult({ kind: "provider", name, models, warning });
        setAddedModelIds(new Set((providerModels[name] ?? []).map((m) => m.id)));
        setTesting(null);
      },
      onError: (err: Error, [name]: [string]) => {
        setFetchModelsResult({
          kind: "provider",
          name,
          error:
            err instanceof ApiError
              ? { code: err.code, message: err.message, data: err.data }
              : { code: "UNKNOWN_ERROR", message: err.message },
        });
        setTesting(null);
      },
    },
  );

  // 模型连通性测试
  const { run: runTestModel } = useRequest(
    async (providerId: string, modelId: string) => {
      const result = await unwrap(providerApi.testModel(providerId, modelId));
      const r = result as unknown as { content?: string };
      return { providerName: providerId, modelId, content: r.content ?? "" };
    },
    {
      manual: true,
      onSuccess: ({ providerName, modelId, content }) => {
        setFetchModelsResult({ kind: "model", providerName, modelId, content });
        setTestingModelKey(null);
      },
      onError: (err: Error, [providerId, modelId]: [string, string]) => {
        setFetchModelsResult({
          kind: "model",
          providerName: providerId,
          modelId,
          error:
            err instanceof ApiError
              ? { code: err.code, message: err.message, data: err.data }
              : { code: "UNKNOWN_ERROR", message: err.message },
        });
        setTestingModelKey(null);
      },
    },
  );

  // 从测试结果添加模型
  const { run: runAddFromTest } = useRequest(
    async (providerName: string, modelId: string) => {
      await unwrap(providerApi.addModel(providerName, { modelId, name: modelId } as Record<string, unknown>));
      return { providerName, modelId };
    },
    {
      manual: true,
      onSuccess: ({ providerName: _providerName, modelId }) => {
        setAddedModelIds((prev) => new Set(prev).add(modelId));
        dispatchConfigChange("models");
        refresh();
      },
      onError: (err: Error) => {
        console.error(err);
        toast.error(t("testDialog.addModelError", { message: err.message }));
      },
    },
  );

  // 模型保存（创建/更新）：仅创建时 toast 提示
  const { run: runModelSave, loading: modelSaving } = useRequest(
    async (providerId: string, modelId: string, data: Record<string, unknown>, isNew: boolean) => {
      if (isNew) {
        await unwrap(providerApi.addModel(providerId, data));
      } else {
        await unwrap(providerApi.updateModel(providerId, modelId, data));
      }
      return isNew;
    },
    {
      manual: true,
      onSuccess: (isNew: boolean) => {
        if (isNew) toast.success(t("modelSubrow.saveModel.successCreate"));
        setModelDialogOpen(false);
        refresh();
        dispatchConfigChange("models");
      },
      onError: (err: Error) => {
        console.error(err);
        toast.error(t("modelSubrow.saveModel.errorGeneric", { message: err.message }));
      },
    },
  );

  // 模型删除：静默操作
  const { run: runModelDelete } = useRequest(
    async (providerId: string, modelId: string) => {
      await unwrap(providerApi.removeModel(providerId, modelId));
    },
    {
      manual: true,
      onSuccess: () => {
        setDeleteModelConfirm(null);
        refresh();
        dispatchConfigChange("models");
      },
      onError: (err: Error) => {
        console.error(err);
        toast.error(t("modelSubrow.deleteModel.error", { message: err.message }));
      },
    },
  );

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
    setFormBaseURL(provider.baseURL ?? "");
    setFormProtocol(provider.protocol);
    setFormDisplayName(provider.name !== provider.id ? provider.name : "");
    setFormApiKey("");
    resetFormModelState();
    setDialogOpen(true);
  };

  const handleSave = () => {
    if (!formName.trim()) {
      toast.error(t("validation.nameEmpty"));
      return;
    }
    const data: Record<string, unknown> = {};
    if (formApiKey) data.apiKey = formApiKey;
    if (formBaseURL) data.baseURL = formBaseURL;
    data.protocol = formProtocol;
    if (formDisplayName) data.name = formDisplayName;
    runSave(formName, data, formSelectedModels);
  };

  const handleTogglePublic = (provider: ProviderInfo, next: boolean) => {
    setSharingProviderKey(getProviderKey(provider));
    runTogglePublic(provider, next);
  };

  // 表单内获取模型列表
  // 新建和编辑都只用表单内的临时值获取，避免未保存修改提前写入后端。
  const handleFetchModels = async () => {
    if (!formName.trim()) {
      toast.error(t("validation.nameEmpty"));
      return;
    }
    setFormFetchingModels(true);
    setFormModelsFetched(false);
    try {
      // 统一走 inline 获取，名称仅用于兼容既有接口参数，不作为配置读取来源。
      const result = await unwrap(
        providerApi.fetchModels(
          formName,
          buildProviderInlineTestPayload({
            apiKey: formApiKey,
            baseURL: formBaseURL,
            protocol: formProtocol,
          }),
        ),
      );
      const r = result as unknown as Record<string, unknown>;
      const modelIds = Array.isArray(r?.models)
        ? (r.models as unknown as Array<{ id?: string }>).map((m: { id?: string }) => m.id ?? String(m))
        : [];
      setFormAvailableModels(modelIds);
      setFormModelsFetched(true);

      // 不自动勾选任何模型，由用户手动选择
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

  const handleFetchModelsResult = (name: string) => {
    setTesting(name);
    runFetchModels(name);
  };

  const handleAddFromTest = (modelId: string) => {
    if (fetchModelsResult?.kind !== "provider" || "error" in fetchModelsResult) return;
    runAddFromTest(fetchModelsResult.name, modelId);
  };

  const handleTestModel = (providerId: string, modelId: string) => {
    setTestingModelKey(`${providerId}:${modelId}`);
    runTestModel(providerId, modelId);
  };

  const handleDelete = (name: string) => {
    setDeleteTarget(name);
    setConfirmOpen(true);
  };
  const confirmDelete = () => {
    if (!deleteTarget) return;
    runDelete(deleteTarget);
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

  const handleModelSave = () => {
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
    runModelSave(modelProviderId, mfId, data, isNewModel);
  };

  const handleModelDelete = () => {
    if (!deleteModelConfirm) return;
    runModelDelete(deleteModelConfirm.providerId, deleteModelConfirm.modelId);
  };

  const toggleModality = (list: string[], item: string, setter: (v: string[]) => void) => {
    setter(list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  };

  const filteredProviders = providerSearch.trim()
    ? providers.filter(
        (p) =>
          p.id.toLowerCase().includes(providerSearch.toLowerCase()) ||
          (p.name?.toLowerCase().includes(providerSearch.toLowerCase()) ?? false),
      )
    : providers;

  if (loading) {
    return (
      <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <Skeleton className="h-[22px] w-28 rounded-md" />
            <Skeleton className="mt-1.5 h-3 w-56 rounded-md" />
          </div>
          <Skeleton className="h-10 w-28 rounded-lg" />
        </div>
        <div className="mb-7 h-px bg-[#e8edf4]" />
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
      <AgentPageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <button
            type="button"
            onClick={handleOpenCreate}
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-[#1677ff] px-[22px] text-[13px] font-semibold text-white shadow-[0_4px_14px_rgba(22,119,255,0.18)] transition hover:bg-[#0f67df]"
          >
            <Plus className="h-4 w-4" />
            {t("createButton")}
          </button>
        }
      />

      {/* 搜索栏 */}
      <div className="mb-7 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#98a8bd]" />
          <input
            value={providerSearch}
            onChange={(e) => setProviderSearch(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="h-10 w-full rounded-lg border border-[#dce5ef] bg-white pl-10 pr-4 text-[13px] text-[#1a2944] outline-none transition placeholder:text-[#99a8bc] focus:border-[#1677ff] focus:ring-4 focus:ring-[#1677ff]/10"
          />
        </div>
      </div>

      <AgentCardList
        items={filteredProviders}
        cardKey={getProviderKey}
        emptyMessage={t("emptyMessage")}
        gridCols="grid-cols-1 sm:grid-cols-2 xl:grid-cols-3"
        renderCard={(provider) => {
          const providerKey = getProviderKey(provider);
          const writable = canWriteProvider(provider);
          const models = providerModels[providerKey] ?? [];
          const brandColor = getProviderColor(provider.id);
          const sourceName = provider.resourceAccess?.sourceOrganizationName;
          const hasModels = models.length > 0;

          return (
            <div
              key={providerKey}
              className="group flex h-full flex-col overflow-hidden rounded-lg border border-border-light bg-surface-1 transition-colors hover:border-border-active hover:shadow-sm"
            >
              {/* ── 头像区 ── */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle">
                <div
                  className="flex-shrink-0 w-9 h-9 rounded-lg flex items-center justify-center text-base font-extrabold text-white"
                  style={{ backgroundColor: brandColor }}
                >
                  {provider.id.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-text-bright truncate">{provider.id}</span>
                    {sourceName && <span className="text-xs text-text-muted flex-shrink-0">{sourceName}</span>}
                  </div>
                  <div className="text-[11px] text-text-muted mt-0.5">
                    {t(`protocolOptions.${provider.protocol}`)} · {t("columns.models")} ({models.length})
                  </div>
                </div>
              </div>

              {/* ── Model 列表区 ── */}
              <div className="flex-1 px-4 py-2">
                {hasModels ? (
                  <div className="space-y-2">
                    {models.map((m) => {
                      const limit = (m.limit as Record<string, number | undefined>) ?? {};
                      return (
                        <div key={m.id} className="flex items-center gap-2 py-1.5 min-w-0 group/model">
                          <ModelIcon modelId={m.id} size={14} />
                          <span className="font-mono text-[11px] font-medium text-text-bright truncate">{m.id}</span>
                          {limit.context ? (
                            <span className="text-[10px] text-text-muted ml-auto flex-shrink-0">
                              {Number(limit.context).toLocaleString()}
                            </span>
                          ) : null}
                          {/* 模型操作按钮 — hover 时渐显 */}
                          <div className="flex items-center gap-1.5 flex-shrink-0 ml-auto opacity-0 group-hover/model:opacity-100 transition-opacity duration-200">
                            {writable ? (
                              <>
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleTestModel(providerKey, m.id);
                                  }}
                                  disabled={testingModelKey === `${providerKey}:${m.id}`}
                                  className="text-[10px] text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40"
                                >
                                  {testingModelKey === `${providerKey}:${m.id}`
                                    ? t("actions.testing")
                                    : t("actions.test")}
                                </button>
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    openEditModel(providerKey, m);
                                  }}
                                  className="text-[10px] text-text-secondary hover:text-text-primary transition-colors"
                                >
                                  {t("actions.edit")}
                                </button>
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setDeleteModelConfirm({ providerId: providerKey, modelId: m.id });
                                  }}
                                  className="text-[10px] text-red-500 hover:text-red-600 transition-colors"
                                >
                                  {t("actions.delete")}
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openViewModel(providerKey, m);
                                }}
                                className="text-[10px] text-text-secondary hover:text-text-primary transition-colors"
                              >
                                {t("actions.view")}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {writable && (
                      <div className="pt-2 text-center">
                        <button
                          type="button"
                          onClick={() => openNewModel(providerKey)}
                          className="text-xs text-text-muted hover:text-text-primary transition-colors"
                        >
                          {t("modelSubrow.addButton")}
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="py-3 text-center">
                    {writable && (
                      <button
                        type="button"
                        onClick={() => openNewModel(providerKey)}
                        className="text-xs text-text-muted hover:text-text-primary transition-colors"
                      >
                        {t("modelSubrow.addButton")}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* ── 操作栏 ── */}
              <div className="mt-auto flex items-center gap-3 border-t border-border-subtle bg-surface-0 px-4 py-2 text-[11px]">
                {writable ? (
                  <>
                    {/* 左侧：获取模型列表 & 编辑 */}
                    <div className="flex items-center gap-2">
                      {hasModels && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleFetchModelsResult(providerKey);
                          }}
                          disabled={testing === providerKey}
                          className="text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40"
                        >
                          {testing === providerKey ? t("form.fetching") : t("form.fetchModels")}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleOpenEdit(provider);
                        }}
                        className="text-text-secondary hover:text-text-primary transition-colors"
                      >
                        {t("actions.edit")}
                      </button>
                    </div>
                    {/* 右侧：公开开关 & 删除 */}
                    <div className="flex items-center gap-2 ml-auto">
                      <label
                        className="flex items-center gap-1.5 cursor-pointer"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <span className="text-text-muted">
                          {provider.resourceAccess?.publicReadable
                            ? tComponents("resource.public")
                            : tComponents("resource.internal")}
                        </span>
                        <Switch
                          checked={Boolean(provider.resourceAccess?.publicReadable)}
                          disabled={sharingProviderKey === providerKey || provider.resourceAccess?.manageable !== true}
                          onCheckedChange={() =>
                            void handleTogglePublic(provider, !provider.resourceAccess?.publicReadable)
                          }
                        />
                      </label>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleDelete(provider.id);
                        }}
                        className="text-red-500 hover:text-red-600 transition-colors"
                      >
                        {t("actions.delete")}
                      </button>
                    </div>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleOpenEdit(provider);
                    }}
                    className="text-text-secondary hover:text-text-primary transition-colors"
                  >
                    {t("actions.view")}
                  </button>
                )}
              </div>
            </div>
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
        loading={saving}
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
      <Dialog open={!!fetchModelsResult} onOpenChange={() => setFetchModelsResult(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {fetchModelsResult?.kind === "provider" && t("form.modelsSection")}
              {fetchModelsResult?.kind === "model" &&
                ("error" in fetchModelsResult
                  ? t("testDialog.modelFailTitle", { modelId: fetchModelsResult.modelId })
                  : t("testDialog.modelSuccessTitle", { modelId: fetchModelsResult.modelId }))}
            </DialogTitle>
            <DialogDescription className="whitespace-pre-line">
              {fetchModelsResult?.kind === "provider" && getProviderDialogDescription(fetchModelsResult)}
              {fetchModelsResult?.kind === "model" &&
                ("error" in fetchModelsResult
                  ? formatTestError(fetchModelsResult.error)
                  : `${t("testDialog.modelQuestion")}\n${t("testDialog.modelAnswer", { content: fetchModelsResult.content })}`)}
            </DialogDescription>
          </DialogHeader>
          {fetchModelsResult?.kind === "provider" &&
            !("error" in fetchModelsResult) &&
            fetchModelsResult.models.length > 0 && (
              <div className="max-h-72 overflow-y-auto grid gap-1.5">
                {fetchModelsResult.models.map((m) => {
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
