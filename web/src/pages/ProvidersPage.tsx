import { useState, useCallback, useEffect } from "react";
import { toast } from "sonner";
import { DataTable, type Column } from "@/components/config/DataTable";
import { FormDialog } from "@/components/config/FormDialog";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { BatchActionBar } from "@/components/config/BatchActionBar";
import { StatusBadge } from "@/components/config/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  apiListProviders, apiSetProvider, apiTestProvider, apiDeleteProvider,
  apiGetProvider, apiAddProviderModel, apiUpdateProviderModel, apiRemoveProviderModel,
} from "../api/client";
import type { ProviderInfo, ProviderModel } from "../types/config";

const NPM_OPTIONS = [
  { id: "openai-compatible", label: "OpenAI 兼容", npm: "@ai-sdk/openai-compatible" },
  { id: "anthropic", label: "Anthropic", npm: "@ai-sdk/anthropic" },
  { id: "deepseek", label: "DeepSeek", npm: "@ai-sdk/deepseek" },
];

const INPUT_MODALITY_OPTIONS = ["text", "image", "audio", "video", "pdf"] as const;
const OUTPUT_MODALITY_OPTIONS = ["text", "image"] as const;

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
    } catch (e) {
      toast.error("删除失败: " + (e instanceof Error ? e.message : "未知错误"));
    }
  };

  const toggleModality = (list: string[], item: string, setter: (v: string[]) => void) => {
    setter(list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);
  };

  return (
    <div className="space-y-2">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/30">
            <th className="px-2 py-1 text-left text-muted-foreground">模型 ID</th>
            <th className="px-2 py-1 text-left text-muted-foreground">名称</th>
            <th className="px-2 py-1 text-left text-muted-foreground">上下文</th>
            <th className="px-2 py-1 text-left text-muted-foreground">输出</th>
            <th className="px-2 py-1 text-left text-muted-foreground">模态</th>
            <th className="px-2 py-1 text-left text-muted-foreground">操作</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => {
            const limit = (m.limit as Record<string, unknown>) ?? {};
            const modalities = (m.modalities as { input?: string[]; output?: string[] }) ?? {};
            return (
              <tr key={m.id} className="border-b last:border-0 hover:bg-muted/20">
                <td className="px-2 py-1 font-mono text-xs">{m.id}</td>
                <td className="px-2 py-1">{m.name}</td>
                <td className="px-2 py-1">{limit.context ? Number(limit.context).toLocaleString() : "—"}</td>
                <td className="px-2 py-1">{limit.output ? Number(limit.output).toLocaleString() : "—"}</td>
                <td className="px-2 py-1 text-xs">
                  {modalities.input && <span className="text-blue-600">入:{modalities.input.join(",")}</span>}
                  {modalities.input && modalities.output && " / "}
                  {modalities.output && <span className="text-green-600">出:{modalities.output.join(",")}</span>}
                  {!modalities.input && !modalities.output && "—"}
                </td>
                <td className="px-2 py-1">
                  <div className="flex gap-1">
                    <Button size="sm" variant="outline" className="h-6 text-xs px-2" onClick={() => openEditModel(m)}>编辑</Button>
                    <Button size="sm" variant="destructive" className="h-6 text-xs px-2" onClick={() => setDeleteConfirm({ providerId, modelId: m.id })}>删除</Button>
                  </div>
                </td>
              </tr>
            );
          })}
          {models.length === 0 && (
            <tr><td colSpan={6} className="px-2 py-3 text-center text-muted-foreground">暂无模型</td></tr>
          )}
        </tbody>
      </table>
      <Button size="sm" variant="outline" onClick={openNewModel} className="text-xs">+ 新增模型</Button>

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
              <label className="text-sm font-medium">上下文限制 (tokens)</label>
              <Input type="number" value={mfContext} onChange={(e) => setMfContext(e.target.value)}
                placeholder="例如 128000" className="mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium">输出限制 (tokens)</label>
              <Input type="number" value={mfOutput} onChange={(e) => setMfOutput(e.target.value)}
                placeholder="例如 16384" className="mt-1" />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">输入模态</label>
            <div className="flex gap-3 mt-1">
              {INPUT_MODALITY_OPTIONS.map((m) => (
                <label key={m} className="flex items-center gap-1 text-sm">
                  <input type="checkbox" checked={mfInputModalities.includes(m)}
                    onChange={() => toggleModality(mfInputModalities, m, setMfInputModalities)} />
                  {m}
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">输出模态</label>
            <div className="flex gap-3 mt-1">
              {OUTPUT_MODALITY_OPTIONS.map((m) => (
                <label key={m} className="flex items-center gap-1 text-sm">
                  <input type="checkbox" checked={mfOutputModalities.includes(m)}
                    onChange={() => toggleModality(mfOutputModalities, m, setMfOutputModalities)} />
                  {m}
                </label>
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

export function ProvidersPage() {
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

  const loadProviders = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiListProviders();
      setProviders(data);
      // load models for each provider
      const modelsMap: Record<string, ProviderModel[]> = {};
      await Promise.all(data.map(async (p) => {
        try {
          const detail = await apiGetProvider(p.id);
          modelsMap[p.id] = detail.models;
        } catch {
          modelsMap[p.id] = [];
        }
      }));
      setProviderModels(modelsMap);
    } catch (e) {
      toast.error("加载服务商列表失败: " + (e instanceof Error ? e.message : "未知错误"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadProviders(); }, [loadProviders]);

  const columns: Column<ProviderInfo>[] = [
    { key: "id", header: "ID", sortable: true, filterable: true },
    { key: "name", header: "名称", sortable: true },
    { key: "npm", header: "NPM 包", render: (row) => {
      const opt = NPM_OPTIONS.find((o) => o.npm === row.npm);
      return opt ? opt.label : (row.npm || "—");
    }},
    { key: "keyHint", header: "API Key", render: (row) => row.keyHint || "—" },
    { key: "baseURL", header: "Base URL" },
    {
      key: "configured",
      header: "状态",
      filterable: true,
      render: (row) => <StatusBadge status={row.configured ? "configured" : "unconfigured"} />,
    },
    { key: "modelCount", header: "模型数", sortable: true },
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
      loadProviders();
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
      loadProviders();
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
      loadProviders();
    } catch (e) {
      toast.error("批量删除失败: " + (e instanceof Error ? e.message : "未知错误"));
    }
  };

  if (loading) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">加载中...</div>;
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">服务商管理</h2>
        <Button onClick={handleOpenCreate}>新建服务商</Button>
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
                setProviderModels((prev) => ({
                  ...prev,
                  [pid]: (prev[pid] ?? []).filter((m) => m.id !== mid),
                }));
                setProviders((prev) => prev.map((p) =>
                  p.id === pid ? { ...p, modelCount: Math.max(0, p.modelCount - 1) } : p
                ));
              } else if (action === "save") {
                loadProviders();
              }
            }}
          />
        )}
        actions={(row) => (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => handleTest(row.id)} disabled={testing === row.id}>
              {testing === row.id ? "测试中..." : "测试连接"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => handleOpenEdit(row)}>编辑</Button>
            <Button size="sm" variant="destructive" onClick={() => handleDelete(row.id)}>删除</Button>
          </div>
        )}
      />
      {selected.length > 0 && (
        <BatchActionBar
          selectedCount={selected.length}
          onClear={() => setSelected([])}
          actions={[{ label: "批量删除", variant: "destructive", onClick: handleBatchDelete }]}
        />
      )}
      <FormDialog open={dialogOpen} onOpenChange={setDialogOpen}
        title={editingProvider ? "编辑服务商" : "新建服务商"} onSubmit={handleSave} loading={formSaving}>
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">ID（标识符）</label>
            <Input value={formName} onChange={(e) => setFormName(e.target.value)}
              disabled={!!editingProvider} placeholder="例如 bailian-token-plan" />
          </div>
          <div>
            <label className="text-sm font-medium">显示名称</label>
            <Input value={formDisplayName} onChange={(e) => setFormDisplayName(e.target.value)}
              placeholder="例如 阿里百炼" />
          </div>
          <div>
            <label className="text-sm font-medium">NPM 包</label>
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
            <p className="text-xs text-muted-foreground mt-1">实际包名: {NPM_OPTIONS.find((o) => o.id === formNpm)?.npm ?? ""}</p>
          </div>
          <div>
            <label className="text-sm font-medium">API Key</label>
            <div className="relative">
              <Input type="password" value={formApiKey} onChange={(e) => setFormApiKey(e.target.value)}
                placeholder={editingProvider ? "留空表示不修改" : "输入 API Key"} />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">Base URL</label>
            <Input value={formBaseURL} onChange={(e) => setFormBaseURL(e.target.value)}
              placeholder="可选，默认使用服务商 URL" />
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
              <div className="text-sm py-2 px-3 rounded bg-yellow-50 text-yellow-800 border border-yellow-200">
                {testResult.warning}
              </div>
            ) : null
          )}
          {testResult && !("error" in testResult) && testResult.models.length > 0 && (
            <div className="max-h-64 overflow-y-auto space-y-1">
              {(testResult as { name: string; models: string[] }).models.map((m) => {
                const added = addedModelIds.has(m);
                return (
                  <div key={m} className="flex items-center justify-between text-sm py-1.5 px-2 rounded bg-muted">
                    <span className="font-mono text-xs">{m}</span>
                    {added ? (
                      <span className="text-xs text-muted-foreground">已添加</span>
                    ) : (
                      <Button size="sm" variant="outline" className="h-6 text-xs px-2" onClick={() => handleAddFromTest(m)}>
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
