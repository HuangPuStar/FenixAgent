import { useState, useCallback, useEffect } from "react";
import { toast } from "sonner";
import { DataTable, type Column } from "@/components/config/DataTable";
import { FormDialog } from "@/components/config/FormDialog";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { BatchActionBar } from "@/components/config/BatchActionBar";
import { StatusBadge } from "@/components/config/StatusBadge";
import { ModelConfigDialog } from "@/components/config/ModelConfigDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  apiListProviders, apiSetProvider, apiTestProvider, apiDeleteProvider,
  apiGetProvider, apiAddProviderModel, apiUpdateProviderModel, apiRemoveProviderModel,
  apiGetModels,
} from "../api/client";
import type { ProviderInfo, ProviderModel, ModelConfig } from "../types/config";
import { dispatchConfigChange } from "../lib/config-events";

const NPM_OPTIONS = [
  { id: "openai-compatible", label: "OpenAI 兼容", npm: "@ai-sdk/openai-compatible" },
  { id: "anthropic", label: "Anthropic", npm: "@ai-sdk/anthropic" },
  { id: "deepseek", label: "DeepSeek", npm: "@ai-sdk/deepseek" },
];

const INPUT_MODALITY_OPTIONS = ["text", "image", "audio", "video", "pdf"] as const;
const OUTPUT_MODALITY_OPTIONS = ["text", "image"] as const;

export function getModelUsageStatus(fullId: string, currentModel: string | null, smallModel: string | null): string[] {
  const badges: string[] = [];
  if (currentModel === fullId) badges.push("主模型");
  if (smallModel === fullId) badges.push("轻量模型");
  return badges;
}

export function validateProviderForm(name: string, isEdit: boolean): string | null {
  if (!name.trim()) return "名称不能为空";
  if (!isEdit && (name.length < 1 || name.length > 64)) return "名称长度须在 1-64 字符之间";
  return null;
}

export function buildProviderPayload(apiKey: string, baseURL: string, npm: string, name: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (apiKey) data.apiKey = apiKey;
  if (baseURL) data.baseURL = baseURL;
  if (npm) data.npm = npm;
  if (name) data.name = name;
  return data;
}

function ModalityBadge({ type, items }: { type: "input" | "output"; items: string[] }) {
  if (!items || items.length === 0) return null;
  const isInput = type === "input";
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded-full font-medium ${isInput ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300" : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"}`}>
      {isInput ? "入" : "出"} {items.join(", ")}
    </span>
  );
}

function ModelSubrow({ providerId, models, onModelChange }: { providerId: string; models: ProviderModel[]; onModelChange: (action: "delete" | "save", providerId: string, modelId?: string) => void }) {
  const [editingModel, setEditingModel] = useState<ProviderModel | null>(null);
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
    setMfId(""); setMfName(""); setMfContext(""); setMfOutput("");
    setMfInputModalities(["text"]); setMfOutputModalities(["text"]);
    setMfThinkingEnabled(false); setMfThinkingBudget("");
    setMfCostInput(""); setMfCostOutput(""); setShowAdvanced(false);
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
    if (!mfId.trim()) { toast.error("模型 ID 不能为空"); return; }

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
        await apiAddProviderModel(providerId, data);
        toast.success("模型已添加");
      } else {
        await apiUpdateProviderModel(providerId, mfId, data);
        toast.success("模型已更新");
      }
      setModelDialogOpen(false);
      onModelChange("save", providerId, mfId.trim());
      dispatchConfigChange("models");
    } catch (e) {
      toast.error("保存失败: " + (e instanceof Error ? e.message : "未知错误"));
    } finally {
      setModelSaving(false);
    }
  };

  const handleModelDelete = async () => {
    if (!deleteConfirm) return;
    try {
      await apiRemoveProviderModel(deleteConfirm.providerId, deleteConfirm.modelId);
      toast.success("模型已删除");
      const pid = deleteConfirm.providerId;
      const mid = deleteConfirm.modelId;
      setDeleteConfirm(null);
      onModelChange("delete", pid, mid);
      dispatchConfigChange("models");
    } catch (e) {
      toast.error("删除失败: " + (e instanceof Error ? e.message : "未知错误"));
    }
  };

  const toggleModality = (list: string[], item: string, setter: (v: string[]) => void) => {
    setter(list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  };

  return (
    <div className="space-y-2">
      {models.length === 0 ? (
        <div className="py-6 text-center text-muted-foreground text-sm">
          暂无模型，点击下方按钮添加
        </div>
      ) : (
        <div className="grid gap-2">
          {models.map((m) => {
            const limit = (m.limit as Record<string, unknown>) ?? {};
            const modalities = (m.modalities as { input?: string[]; output?: string[] }) ?? {};
            const cost = (m.cost as Record<string, unknown>) ?? {};
            const hasInputMods = modalities.input && modalities.input.length > 0 && !(modalities.input.length === 1 && modalities.input[0] === "text");
            const hasOutputMods = modalities.output && modalities.output.length > 0 && !(modalities.output.length === 1 && modalities.output[0] === "text");
            return (
              <div key={m.id} className="group flex items-center gap-3 rounded-lg border border-border-light bg-surface-1 px-3 py-2.5 transition-colors hover:border-border-active hover:shadow-sm">
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
                      <span>上下文 {Number(limit.context).toLocaleString()}</span>
                    ) : null}
                    {limit.output ? (
                      <span>输出 {Number(limit.output).toLocaleString()}</span>
                    ) : null}
                    {cost.input || cost.output ? (
                      <span className="text-amber-600 dark:text-amber-400">${cost.input || 0}/${cost.output || 0}</span>
                    ) : null}
                    {!limit.context && !limit.output && (
                      <span>无限制信息</span>
                    )}
                  </div>
                </div>
                <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button size="xs" variant="outline" onClick={() => openEditModel(m)}>编辑</Button>
                  <Button size="xs" variant="destructive" onClick={() => setDeleteConfirm({ providerId, modelId: m.id })}>删除</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <Button size="sm" variant="outline" onClick={openNewModel} className="w-full border-dashed text-text-secondary hover:text-text-primary hover:border-brand">
        + 添加模型
      </Button>

      <FormDialog open={modelDialogOpen} onOpenChange={setModelDialogOpen}
        title={isNewModel ? "新增模型" : `编辑模型 — ${mfId}`} onSubmit={handleModelSave} loading={modelSaving}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">模型 ID</label>
              <Input value={mfId} onChange={(e) => setMfId(e.target.value)}
                disabled={!isNewModel} placeholder="例如 qwen3.6-plus" className="mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium">显示名称</label>
              <Input value={mfName} onChange={(e) => setMfName(e.target.value)}
                placeholder="例如 Qwen3.6 Plus" className="mt-1" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium text-text-primary">上下文限制</label>
              <Input type="number" value={mfContext} onChange={(e) => setMfContext(e.target.value)}
                placeholder="128000" className="mt-1 font-mono text-sm" />
              <p className="text-xs text-text-muted mt-1">tokens，对话上下文窗口大小</p>
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">输出限制</label>
              <Input type="number" value={mfOutput} onChange={(e) => setMfOutput(e.target.value)}
                placeholder="16384" className="mt-1 font-mono text-sm" />
              <p className="text-xs text-text-muted mt-1">tokens，单次回复最大长度</p>
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">输入模态</label>
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
            <label className="text-sm font-medium">输出模态</label>
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
              {showAdvanced ? "收起高级参数" : "展开高级参数"}
            </Button>
          </div>
          {showAdvanced && (
            <div className="space-y-3 border-t pt-3">
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium">启用思考模式</label>
                <Switch checked={mfThinkingEnabled} onCheckedChange={setMfThinkingEnabled} />
              </div>
              {mfThinkingEnabled && (
                <div>
                  <label className="text-sm font-medium">思考预算 (tokens)</label>
                  <Input type="number" value={mfThinkingBudget} onChange={(e) => setMfThinkingBudget(e.target.value)}
                    placeholder="例如 10000" className="mt-1" />
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium">输入费用 ($/百万 tokens)</label>
                  <Input type="number" step="0.01" value={mfCostInput} onChange={(e) => setMfCostInput(e.target.value)}
                    placeholder="例如 2.5" className="mt-1" />
                </div>
                <div>
                  <label className="text-sm font-medium">输出费用 ($/百万 tokens)</label>
                  <Input type="number" step="0.01" value={mfCostOutput} onChange={(e) => setMfCostOutput(e.target.value)}
                    placeholder="例如 10" className="mt-1" />
                </div>
              </div>
            </div>
          )}
        </div>
      </FormDialog>
      <ConfirmDialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}
        title="确认删除模型" description={`确定要删除模型 "${deleteConfirm?.modelId}" 吗？`}
        variant="destructive" onConfirm={handleModelDelete} />
    </div>
  );
}

export function ModelsPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerModels, setProviderModels] = useState<Record<string, ProviderModel[]>>({});
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderInfo | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [selected, setSelected] = useState<ProviderInfo[]>([]);
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [testResult, setTestResult] = useState<{ name: string; models: string[]; warning?: string } | { name: string; error: string } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [addedModelIds, setAddedModelIds] = useState<Set<string>>(new Set());
  const [formName, setFormName] = useState("");
  const [formApiKey, setFormApiKey] = useState("");
  const [formBaseURL, setFormBaseURL] = useState("");
  const [formNpm, setFormNpm] = useState("openai-compatible");
  const [formDisplayName, setFormDisplayName] = useState("");
  const [formSaving, setFormSaving] = useState(false);
  const [modelConfig, setModelConfig] = useState<ModelConfig | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [providersData, modelConfigData] = await Promise.all([
        (async () => {
          const data = await apiListProviders();
          const modelsMap: Record<string, ProviderModel[]> = {};
          await Promise.all(data.map(async (p) => {
            try {
              const detail = await apiGetProvider(p.id);
              modelsMap[p.id] = detail.models;
            } catch { modelsMap[p.id] = []; }
          }));
          return { providers: data, providerModels: modelsMap };
        })(),
        apiGetModels(),
      ]);
      setProviders(providersData.providers);
      setProviderModels(providersData.providerModels);
      setModelConfig(modelConfigData);
    } catch (e) {
      toast.error("加载数据失败: " + (e instanceof Error ? e.message : "未知错误"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const columns: Column<ProviderInfo>[] = [
    { key: "id", header: "ID", sortable: true, filterable: true, render: (row) => (
      <div className="flex flex-col">
        <span className="font-mono text-sm text-text-bright">{row.id}</span>
        {row.name && row.name !== row.id && (
          <span className="text-xs text-text-muted">{row.name}</span>
        )}
      </div>
    )},
    { key: "npm", header: "协议", render: (row) => {
      const opt = NPM_OPTIONS.find((o) => o.npm === row.npm);
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium bg-surface-2 text-text-secondary">
          {opt ? opt.label : (row.npm || "—")}
        </span>
      );
    }},
    { key: "keyHint", header: "API Key", render: (row) => (
      row.keyHint ? (
        <span className="font-mono text-xs text-text-muted bg-surface-2 px-2 py-0.5 rounded">
          ***{row.keyHint}
        </span>
      ) : (
        <span className="text-text-muted">—</span>
      )
    )},
    {
      key: "configured",
      header: "状态",
      filterable: true,
      render: (row) => <StatusBadge status={row.configured ? "configured" : "unconfigured"} />,
    },
    { key: "modelCount", header: "模型", sortable: true, render: (row) => (
      <span className={`inline-flex items-center justify-center min-w-[24px] h-5 px-1.5 rounded-full text-xs font-medium ${
        row.modelCount > 0
          ? "bg-brand-subtle text-brand dark:text-brand-light"
          : "bg-surface-2 text-text-muted"
      }`}>
        {row.modelCount}
      </span>
    )},
  ];

  const handleOpenCreate = () => {
    setEditingProvider(null);
    setFormName(""); setFormApiKey(""); setFormBaseURL(""); setFormNpm("openai-compatible"); setFormDisplayName("");
    setDialogOpen(true);
  };

  const handleOpenEdit = (provider: ProviderInfo) => {
    setEditingProvider(provider);
    setFormName(provider.id); setFormApiKey(""); setFormBaseURL(provider.baseURL ?? "");
    const matchOpt = NPM_OPTIONS.find((o) => o.npm === provider.npm);
    setFormNpm(matchOpt ? matchOpt.id : "openai-compatible");
    setFormDisplayName(provider.name !== provider.id ? provider.name : "");
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const err = validateProviderForm(formName, !!editingProvider);
    if (err) { toast.error(err); return; }
    setFormSaving(true);
    try {
      const npmPackage = NPM_OPTIONS.find((o) => o.id === formNpm)?.npm ?? "@ai-sdk/openai-compatible";
      const data = buildProviderPayload(formApiKey, formBaseURL, npmPackage, formDisplayName);
      await apiSetProvider(formName, data);
      toast.success(editingProvider ? "服务商已更新" : "服务商已创建");
      setDialogOpen(false);
      loadAll();
      dispatchConfigChange("providers");
    } catch (e) {
      toast.error("保存失败: " + (e instanceof Error ? e.message : "未知错误"));
    } finally {
      setFormSaving(false);
    }
  };

  const handleTest = async (name: string) => {
    setTesting(name);
    try {
      const result = await apiTestProvider(name);
      setTestResult({ name, models: result.models, warning: result.warning });
      const existing = (providerModels[name] ?? []).map((m) => m.id);
      setAddedModelIds(new Set(existing));
    } catch (e) {
      const message = e instanceof Error ? e.message : "未知错误";
      setTestResult({ name, error: message });
    } finally {
      setTesting(null);
    }
  };

  const handleAddFromTest = async (modelId: string) => {
    if (!testResult || "error" in testResult) return;
    try {
      await apiAddProviderModel(testResult.name, { modelId, name: modelId });
      setAddedModelIds((prev) => new Set(prev).add(modelId));
      setProviderModels((prev) => ({
        ...prev,
        [testResult.name]: [...(prev[testResult.name] ?? []), { id: modelId, name: modelId, modalities: null, limit: null, cost: null }],
      }));
      setProviders((prev) => prev.map((p) =>
        p.id === testResult.name ? { ...p, modelCount: p.modelCount + 1 } : p
      ));
      toast.success(`模型 ${modelId} 已添加`);
      dispatchConfigChange("models");
    } catch (e) {
      toast.error("添加失败: " + (e instanceof Error ? e.message : "未知错误"));
    }
  };

  const handleDelete = (name: string) => { setDeleteTarget(name); setConfirmOpen(true); };
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiDeleteProvider(deleteTarget);
      toast.success("服务商已删除");
      setConfirmOpen(false);
      loadAll();
      dispatchConfigChange("providers");
    } catch (e) {
      toast.error("删除失败: " + (e instanceof Error ? e.message : "未知错误"));
    }
  };

  const handleBatchDelete = () => { setBatchConfirmOpen(true); };
  const confirmBatchDelete = async () => {
    try {
      await Promise.all(selected.map((p) => apiDeleteProvider(p.id)));
      toast.success(`已删除 ${selected.length} 个服务商`);
      setBatchConfirmOpen(false);
      setSelected([]);
      loadAll();
      dispatchConfigChange("providers");
    } catch (e) {
      toast.error("批量删除失败: " + (e instanceof Error ? e.message : "未知错误"));
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
          <h2 className="text-xl font-semibold text-text-bright">服务商与模型</h2>
          <p className="text-sm text-text-muted mt-0.5">管理 AI 服务商及其可用模型</p>
        </div>
        <div className="flex items-center gap-2">
          <ModelConfigDialog
            currentModel={modelConfig?.current.model ?? null}
            currentSmallModel={modelConfig?.current.small_model ?? null}
            available={modelConfig?.available ?? []}
          />
          <Button onClick={handleOpenCreate}>新建服务商</Button>
        </div>
      </div>
      <DataTable<ProviderInfo>
        columns={columns}
        data={providers}
        searchable
        searchPlaceholder="搜索服务商..."
        selectable
        onSelectionChange={setSelected}
        rowKey={(row) => row.id}
        expandableRow={(row) => (
          <ModelSubrow
            providerId={row.id}
            models={providerModels[row.id] ?? []}
            onModelChange={(action, pid, mid) => {
              if (action === "delete" && mid) {
                setProviderModels((prev) => ({ ...prev, [pid]: (prev[pid] ?? []).filter((m) => m.id !== mid) }));
                setProviders((prev) => prev.map((p) => p.id === pid ? { ...p, modelCount: Math.max(0, p.modelCount - 1) } : p));
              } else if (action === "save") { loadAll(); }
            }}
          />
        )}
        actions={(row) => (
          <div className="flex gap-1.5">
            <Button size="xs" variant="outline" onClick={() => handleTest(row.id)} disabled={testing === row.id}>
              {testing === row.id ? "检测中..." : "测试"}
            </Button>
            <Button size="xs" variant="outline" onClick={() => handleOpenEdit(row)}>编辑</Button>
            <Button size="xs" variant="destructive" onClick={() => handleDelete(row.id)}>删除</Button>
          </div>
        )}
      />
      {selected.length > 0 && (
        <BatchActionBar selectedCount={selected.length} onClear={() => setSelected([])}
          actions={[{ label: "批量删除", variant: "destructive", onClick: handleBatchDelete }]} />
      )}
      <FormDialog open={dialogOpen} onOpenChange={setDialogOpen}
        title={editingProvider ? "编辑服务商" : "新建服务商"} onSubmit={handleSave} loading={formSaving}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium text-text-primary">ID（标识符）</label>
              <Input value={formName} onChange={(e) => setFormName(e.target.value)}
                disabled={!!editingProvider} placeholder="bailian-token-plan" className="mt-1 font-mono text-sm" />
              {editingProvider && (
                <p className="text-xs text-text-muted mt-1">ID 创建后不可修改</p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">显示名称</label>
              <Input value={formDisplayName} onChange={(e) => setFormDisplayName(e.target.value)}
                placeholder="例如 阿里百炼" className="mt-1" />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-text-primary">协议</label>
            <Select value={formNpm} onValueChange={setFormNpm}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NPM_OPTIONS.map((opt) => (
                  <SelectItem key={opt.id} value={opt.id}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-text-muted mt-1">
              SDK 包: <code className="font-mono bg-surface-2 px-1 rounded">{NPM_OPTIONS.find((o) => o.id === formNpm)?.npm ?? ""}</code>
            </p>
          </div>
          <div>
            <label className="text-sm font-medium text-text-primary">API Key</label>
            <Input type="password" value={formApiKey} onChange={(e) => setFormApiKey(e.target.value)}
              placeholder={editingProvider ? "留空表示不修改" : "输入 API Key"} className="mt-1" />
          </div>
          <div>
            <label className="text-sm font-medium text-text-primary">Base URL</label>
            <Input value={formBaseURL} onChange={(e) => setFormBaseURL(e.target.value)}
              placeholder="可选，默认使用服务商 URL" className="mt-1" />
          </div>
        </div>
      </FormDialog>
      <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen}
        title="确认删除" description={`确定要删除服务商 "${deleteTarget}" 吗？`}
        variant="destructive" onConfirm={confirmDelete} />
      <ConfirmDialog open={batchConfirmOpen} onOpenChange={setBatchConfirmOpen}
        title="批量删除确认" description={`确定要删除选中的 ${selected.length} 个服务商吗？`}
        variant="destructive" onConfirm={confirmBatchDelete} />
      <Dialog open={!!testResult} onOpenChange={() => setTestResult(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {testResult && "error" in testResult
                ? `连接测试失败 — ${testResult.name}`
                : `连接测试成功 — ${testResult?.name}`}
            </DialogTitle>
            <DialogDescription>
              {testResult && "error" in testResult
                ? (testResult as { name: string; error: string }).error
                : `发现 ${(testResult as { name: string; models: string[] } | null)?.models?.length ?? 0} 个可用模型`}
            </DialogDescription>
          </DialogHeader>
          {testResult && !("error" in testResult) && (
            testResult.warning ? (
              <div className="text-sm py-2.5 px-3 rounded-lg bg-warning-bg text-warning-text border border-warning-border">
                {testResult.warning}
              </div>
            ) : null
          )}
          {testResult && !("error" in testResult) && testResult.models.length > 0 && (
            <div className="max-h-72 overflow-y-auto space-y-1">
              {(testResult as { name: string; models: string[] }).models.map((m) => {
                const added = addedModelIds.has(m);
                return (
                  <div key={m} className={`flex items-center justify-between text-sm py-2 px-3 rounded-lg border transition-colors ${
                    added
                      ? "bg-surface-2 border-border-light"
                      : "bg-surface-1 border-border-light hover:border-brand/30"
                  }`}>
                    <span className="font-mono text-xs text-text-primary">{m}</span>
                    {added ? (
                      <span className="text-xs text-status-active font-medium">已添加</span>
                    ) : (
                      <Button size="xs" variant="outline" onClick={() => handleAddFromTest(m)}>
                        添加
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
