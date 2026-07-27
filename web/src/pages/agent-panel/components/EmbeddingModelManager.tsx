/**
 * EmbeddingModelManager — 模型供应商管理组件（三级树）
 *
 * RAGFlow v0.26 的模型管理结构是三级：供应商(provider) → 实例(instance，即一组
 * API Key) → 模型(model)。本组件按此结构展示与管理：
 *
 * - 列表：provider 折叠 > instance 折叠 > model（每个 model 有 active/inactive 开关）
 * - 屏蔽模型：切换 model 为 inactive，新建 KB 时该 embedding 模型被 RAGFlow 拒绝
 *   （LookupError: Model ... is disabled），实现「新建时不可见」；老 KB 不受影响。
 *   屏蔽的模型在管理页仍可见（灰色），可随时取消屏蔽。
 * - 删除实例：删除一组 API Key（instance）及其下所有模型配置。删除粒度是实例，
 *   不是单个模型、也不是整个供应商。
 * - 添加：必填实例名（默认 = 厂商名），提交后该厂商目录下所有模型自动可用。
 */
import { useRequest } from "ahooks";
import { Boxes, Check, ChevronRight, Cpu, KeyRound, Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { embeddingModelApi } from "@/src/api/knowledge-models";
import { unwrap } from "@/src/api/request";
import type {
  ConfiguredInstanceNode,
  ConfiguredProviderNode,
  EmbeddingFactoryOption,
  InstanceModelOption,
} from "../../../types/knowledge";

interface EmbeddingModelManagerProps {
  /** 是否有管理权限（用于显示/隐藏添加、删除、屏蔽按钮） */
  canManage: boolean;
  /** 是否在 Dialog 内渲染（隐藏标题副文案，避免与 Dialog 重复） */
  inDialog?: boolean;
}

export function EmbeddingModelManager({ canManage, inDialog }: EmbeddingModelManagerProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [addOpen, setAddOpen] = useState(false);

  const { data: tree, loading } = useRequest(() => unwrap(embeddingModelApi.list()), {
    refreshDeps: [refreshKey],
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "加载模型列表失败");
    },
  });

  const treeSafe = tree ?? [];
  const providerCount = treeSafe.length;
  const instanceCount = treeSafe.reduce((sum, p) => sum + (p.instances?.length ?? 0), 0);

  const handleDeleteInstance = async (inst: ConfiguredInstanceNode) => {
    const modelCount = inst.models?.length ?? 0;
    if (
      !confirm(
        `确认删除实例「${inst.instanceName}」？\n` +
          `将移除该实例（供应商 ${inst.provider} 下）及其所有模型配置（${modelCount} 个）。` +
          `正在使用这些模型的知识库检索将会失败，且不可恢复。`,
      )
    )
      return;
    try {
      await unwrap(embeddingModelApi.delete({ provider: inst.provider, instanceName: inst.instanceName }));
      toast.success("已删除实例");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败");
    }
  };

  return (
    <div className="space-y-4">
      {/* 顶部工具栏（弹窗内渲染时不显示，标题由 Dialog 提供） */}
      {!inDialog && (
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-[14px] font-semibold text-[#0f172a]">
              已配置的模型供应商{providerCount > 0 ? `（${providerCount} 个供应商 · ${instanceCount} 个实例）` : ""}
            </h3>
            <p className="text-[12px] text-[#94a3b8] mt-0.5">管理 RAGFlow 租户下的向量模型</p>
          </div>
          {canManage && (
            <Button
              size="sm"
              onClick={() => setAddOpen(true)}
              className="h-8 gap-1.5 text-[12px] rounded-lg bg-[#6366f1] hover:bg-[#5558e6]"
            >
              <Plus className="h-3.5 w-3.5" />
              添加供应商
            </Button>
          )}
        </div>
      )}
      {inDialog && canManage && (
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => setAddOpen(true)}
            className="h-8 gap-1.5 text-[12px] rounded-lg bg-[#6366f1] hover:bg-[#5558e6]"
          >
            <Plus className="h-3.5 w-3.5" />
            添加供应商
          </Button>
        </div>
      )}

      {/* 三级树 */}
      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14 w-full rounded-xl" />
          ))}
        </div>
      ) : providerCount === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#f1f5f9] mb-3">
            <Cpu className="h-7 w-7 text-[#94a3b8]" />
          </div>
          <p className="text-[14px] font-medium text-[#475569]">暂无已配置的模型供应商</p>
          <p className="text-[12px] text-[#94a3b8] mt-1 max-w-[360px]">
            添加一个模型供应商并配置 API Key 后，该厂商目录下的全部向量模型即可在创建知识库时选择。
          </p>
        </div>
      ) : (
        <div className="rounded-2xl bg-white shadow-sm ring-1 ring-inset ring-[#e8edf4]/80 overflow-hidden">
          <div className="divide-y divide-[#f0f3f8]">
            {treeSafe.map((p) => (
              <ProviderRow
                key={p.provider}
                provider={p}
                canManage={canManage}
                onDeleteInstance={handleDeleteInstance}
              />
            ))}
          </div>
        </div>
      )}

      <AddProviderDialog open={addOpen} onOpenChange={setAddOpen} onAdded={() => setRefreshKey((k) => k + 1)} />
    </div>
  );
}

// ===== 供应商行（第一级，可折叠展开实例） =====

interface ProviderRowProps {
  provider: ConfiguredProviderNode;
  canManage: boolean;
  onDeleteInstance: (inst: ConfiguredInstanceNode) => void;
}

function ProviderRow({ provider, canManage, onDeleteInstance }: ProviderRowProps) {
  const [expanded, setExpanded] = useState(false);
  const instances = provider.instances ?? [];
  const totalModels = instances.reduce((s, i) => s + (i.models?.length ?? 0), 0);
  return (
    <div className="transition-colors">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="group flex w-full items-center gap-3 px-5 py-3.5 hover:bg-[#fafbfd] transition-colors border-l-[3px] border-l-transparent hover:border-l-[#6366f1]"
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-50 to-violet-50 text-[#6366f1]">
          <Boxes className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0 text-left">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-[#0f172a] truncate">{provider.provider}</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[11px] text-[#94a3b8]">
            <span>{instances.length} 个实例</span>
            <span className="text-[#e2e8f0]">·</span>
            <span>{totalModels} 个模型</span>
          </div>
        </div>
        <ChevronRight className={`h-4 w-4 text-[#94a3b8] transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>
      {expanded && (
        <div className="bg-[#fafbfd]/50">
          {instances.map((inst) => (
            <InstanceRow
              key={inst.instanceName}
              instance={inst}
              canManage={canManage}
              onDelete={() => onDeleteInstance(inst)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ===== 实例行（第二级，含删除按钮 + 可折叠展开模型） =====

interface InstanceRowProps {
  instance: ConfiguredInstanceNode;
  canManage: boolean;
  onDelete: () => void;
}

function InstanceRow({ instance, canManage, onDelete }: InstanceRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [togglingModel, setTogglingModel] = useState<string | null>(null);
  const models: InstanceModelOption[] = instance.models ?? [];
  // 模型状态本地副本：切换 active/inactive 后只改本地，避免整树重拉
  const [modelStatus, setModelStatus] = useState<Record<string, string>>(() =>
    Object.fromEntries(models.map((m) => [m.name, m.status])),
  );

  const activeCount = models.filter((m) => (modelStatus[m.name] ?? m.status) === "active").length;

  // 切换模型 active/inactive（屏蔽/取消屏蔽）
  const handleToggleModel = async (m: InstanceModelOption, nextActive: boolean) => {
    setTogglingModel(m.name);
    try {
      await unwrap(
        embeddingModelApi.setModelStatus({
          provider: instance.provider,
          instanceName: instance.instanceName,
          modelName: m.name,
          status: nextActive ? "active" : "inactive",
        }),
      );
      setModelStatus((prev) => ({ ...prev, [m.name]: nextActive ? "active" : "inactive" }));
      toast.success(nextActive ? "已启用该模型" : "已屏蔽该模型（新建知识库时将不可见）");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    } finally {
      setTogglingModel(null);
    }
  };

  return (
    <div className="border-t border-[#f0f3f8]">
      <div className="group flex items-center gap-3 pl-10 pr-5 py-2.5 hover:bg-white transition-colors">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex flex-1 items-center gap-2.5 min-w-0 text-left"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 text-[#cbd5e1] transition-transform shrink-0 ${expanded ? "rotate-90" : ""}`}
          />
          <KeyRound className="h-3.5 w-3.5 text-[#94a3b8] shrink-0" />
          <span className="text-[12.5px] font-medium text-[#334155] truncate font-mono">{instance.instanceName}</span>
          <span className="text-[11px] text-[#94a3b8]">
            {activeCount}/{models.length} 启用
          </span>
        </button>
        {canManage && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 text-[#cbd5e1] hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all"
            onClick={onDelete}
            title="删除实例（移除该 API Key 及其所有模型）"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {expanded && models.length > 0 && (
        <div className="pl-[68px] pr-5 pb-2.5 space-y-0.5">
          {models.map((m) => {
            const st = modelStatus[m.name] ?? m.status;
            return (
              <div
                key={m.name}
                className="group flex items-center gap-3 py-1.5 px-2 rounded-lg hover:bg-white transition-colors"
              >
                <Cpu className={`h-3.5 w-3.5 shrink-0 ${st === "active" ? "text-[#6366f1]" : "text-[#cbd5e1]"}`} />
                <span
                  className={`text-[12px] font-mono truncate ${st === "active" ? "text-[#475569]" : "text-[#94a3b8] line-through"}`}
                >
                  {m.name}
                </span>
                {m.modelType && !m.modelType.includes("embedding") && (
                  <span className="text-[10px] text-[#94a3b8] bg-[#f1f5f9] rounded px-1.5 py-0.5 shrink-0">
                    {m.modelType}
                  </span>
                )}
                <div className="flex-1" />
                {canManage && (
                  <Switch
                    checked={st === "active"}
                    disabled={togglingModel === m.name}
                    onCheckedChange={(checked) => handleToggleModel(m, checked === true)}
                    title={st === "active" ? "点击屏蔽（新建知识库时不可见）" : "点击启用"}
                  />
                )}
              </div>
            );
          })}
          <p className="text-[10.5px] text-[#94a3b8] pl-2 pt-1.5 leading-relaxed">
            屏蔽（关闭）后：新建知识库时该模型不可见，已有知识库不受影响。
          </p>
        </div>
      )}
    </div>
  );
}

// ===== 添加供应商弹窗 =====

interface AddProviderDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdded: () => void;
}

function AddProviderDialog({ open, onOpenChange, onAdded }: AddProviderDialogProps) {
  const [factories, setFactories] = useState<EmbeddingFactoryOption[]>([]);
  const [selectedFactory, setSelectedFactory] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [instanceName, setInstanceName] = useState("");
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // 加载厂商列表
  const { loading: factoriesLoading } = useRequest(() => unwrap(embeddingModelApi.listFactories()), {
    ready: open,
    onSuccess: (data) => setFactories((data ?? []).sort((a, b) => a.name.localeCompare(b.name))),
    onError: (err) => toast.error(err instanceof Error ? err.message : "加载厂商失败"),
  });

  const reset = () => {
    setSelectedFactory("");
    setApiKey("");
    setBaseUrl("");
    setInstanceName("");
    setTouched(false);
  };

  const handleClose = (v: boolean) => {
    onOpenChange(v);
    if (!v) setTimeout(reset, 200);
  };

  const handleSubmit = async () => {
    setTouched(true);
    if (!selectedFactory) {
      toast.error("请选择供应商");
      return;
    }
    if (!apiKey.trim()) {
      toast.error("请填写 API Key");
      return;
    }
    if (!instanceName.trim()) {
      toast.error("请填写实例名");
      return;
    }
    setSubmitting(true);
    try {
      // 1. 先验证 Key，失败则提示并不继续
      const verifyResult = await unwrap(
        embeddingModelApi.verify({
          provider: selectedFactory,
          providerApiKey: apiKey.trim(),
          baseUrl: baseUrl.trim() || null,
        }),
      );
      if (!verifyResult.success) {
        toast.error(verifyResult.message || "API Key 验证失败");
        return;
      }
      // 2. 添加供应商实例，该厂商目录下所有模型自动可用
      await unwrap(
        embeddingModelApi.add({
          provider: selectedFactory,
          instanceName: instanceName.trim(),
          providerApiKey: apiKey.trim(),
          baseUrl: baseUrl.trim() || null,
        }),
      );
      toast.success(`已添加实例「${instanceName.trim()}」`);
      handleClose(false);
      onAdded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "添加失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-4 w-4 text-[#6366f1]" />
            添加模型供应商
          </DialogTitle>
          <DialogDescription>
            配置一个模型供应商的 API Key。添加后，该厂商目录下的全部向量模型将自动可用，无需单独选择。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-[#475569]">模型供应商</label>
            <Select
              value={selectedFactory}
              onValueChange={(v) => {
                setSelectedFactory(v);
                const found = factories.find((f) => f.name === v);
                setBaseUrl(found?.url ?? "");
                // 选厂商时带出默认实例名，用户可改
                setInstanceName(v);
              }}
            >
              <SelectTrigger className="h-10">
                <SelectValue placeholder={factoriesLoading ? "加载中..." : "选择供应商"} />
              </SelectTrigger>
              <SelectContent>
                {factories.map((f) => (
                  <SelectItem key={f.name} value={f.name}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-[#475569]">API Key</label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="供应商的 API Key"
              className="h-10"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-[#475569]">实例名</label>
            <Input
              value={instanceName}
              onChange={(e) => setInstanceName(e.target.value)}
              placeholder="为这组 API Key 起个名字，用于区分（同一供应商可配置多个实例）"
              className="h-10"
              onBlur={() => setTouched(true)}
            />
            {touched && !instanceName.trim() && <p className="text-[11px] text-red-500">实例名为必填</p>}
          </div>
          <div className="space-y-1.5">
            <label className="text-[12px] font-medium text-[#475569]">Base URL（可选）</label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="自定义 API 地址，留空用默认"
              className="h-10"
            />
          </div>
          <div className="flex items-start gap-2 text-[12px] text-[#475569] bg-[#f8fafc] rounded-lg px-3 py-2.5 ring-1 ring-inset ring-[#eef2f6]">
            <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-500 mt-0.5" />
            <span>
              提交时会先用 API Key
              做连通性验证，通过后即添加实例。该厂商目录下的全部向量模型将自动可用，可在创建知识库时选择；不需要的模型可在列表中单独屏蔽。
            </span>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => handleClose(false)} disabled={submitting} className="h-9">
            取消
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || !selectedFactory || !apiKey.trim() || !instanceName.trim()}
            className="h-9 gap-1.5 bg-[#6366f1] hover:bg-[#5558e6]"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            验证并添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
