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
 *
 * 归属：本组件自 `@fenix/model-management/web` 移入本包。它管理的是 RAGFlow 的 embedding 模型
 * （数据面就是本包路由 `POST /web/knowledgeBases/models`），唯一消费方也是本包页面
 * `AgentKnowledgeBasesPage`；放在 model-management 会让两个包互引、barrel 在值导入图上成环
 * （收敛理由见 `packages/resources/model-management/README.md`）。它不依赖 model-management 的
 * 任何内部模块，因此这次移动只是包归属变更，未改行为。
 */

import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Button } from "@fenix/ui-components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@fenix/ui-components/ui/dialog";
import { Input } from "@fenix/ui-components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@fenix/ui-components/ui/select";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { Switch } from "@fenix/ui-components/ui/switch";
import { unwrap } from "@fenix/web-runtime/api/request";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useRequest } from "ahooks";
import { Boxes, Check, ChevronRight, Cpu, KeyRound, Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { embeddingModelApi } from "../../../../api/knowledge-models";
import type {
  ConfiguredInstanceNode,
  ConfiguredProviderNode,
  EmbeddingFactoryOption,
  InstanceModelOption,
} from "../../../../types/knowledge";

interface EmbeddingModelManagerProps {
  /** 是否有管理权限（用于显示/隐藏添加、删除、屏蔽按钮） */
  canManage: boolean;
  /** 是否在 Dialog 内渲染（隐藏标题副文案，避免与 Dialog 重复） */
  inDialog?: boolean;
  /**
   * 模型集合发生变更（增删供应商、切换模型 active/inactive）后的回调。
   * 父层可用它刷新「创建知识库」表单的嵌入模型可选项，避免新建时仍展示
   * 已屏蔽的模型或缺失新增的模型。
   */
  onModelsChanged?: () => void;
}

export function EmbeddingModelManager({ canManage, inDialog, onModelsChanged }: EmbeddingModelManagerProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);
  const [refreshKey, setRefreshKey] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  // 待确认删除的实例：原生 confirm 的同步返回值无法保留，改为挂起目标实例 + 受控 ConfirmDialog。
  const [deleteTarget, setDeleteTarget] = useState<ConfiguredInstanceNode | null>(null);

  const { data: tree, loading } = useRequest(() => unwrap(embeddingModelApi.list()), {
    refreshDeps: [refreshKey],
    onError: (err) => {
      // 此前只上屏、不落日志：原始对象先进诊断通道。文案只取字典（§9.3），
      // `err.message` 是 `unwrap` 抛出的 `ApiError.message`（后端信封原文）。
      console.error("Failed to load embedding model tree", err);
      toast.error(t("embeddingModel.listLoadFailed"));
    },
  });

  const treeSafe = tree ?? [];
  const providerCount = treeSafe.length;
  const instanceCount = treeSafe.reduce((sum, p) => sum + (p.instances?.length ?? 0), 0);

  // 真正的删除：只在 ConfirmDialog 确认后调用（原先由本函数内联的 confirm 决定是否继续）。
  const runDeleteInstance = async (inst: ConfiguredInstanceNode) => {
    try {
      await unwrap(embeddingModelApi.delete({ provider: inst.provider, instanceName: inst.instanceName }));
      toast.success(t("embeddingModel.instanceDeleted"));
      setRefreshKey((k) => k + 1);
      onModelsChanged?.();
    } catch (err) {
      console.error("Failed to delete embedding instance", err);
      toast.error(t("embeddingModel.deleteFailed"));
    }
  };

  return (
    <div className={inDialog ? "embedding-model-manager embedding-model-manager--dialog" : "embedding-model-manager"}>
      {/* 顶部工具栏（弹窗内渲染时不显示，标题由 Dialog 提供） */}
      {!inDialog && (
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              {providerCount > 0
                ? t("embeddingModel.titleWithCount", { providers: providerCount, instances: instanceCount })
                : t("embeddingModel.title")}
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">{t("embeddingModel.subtitle")}</p>
          </div>
          {canManage && (
            <Button
              size="sm"
              onClick={() => setAddOpen(true)}
              className="h-8 gap-1.5 text-xs rounded-lg bg-indigo-500 hover:bg-indigo-500"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("embeddingModel.addProvider")}
            </Button>
          )}
        </div>
      )}
      {inDialog && (
        <div className="embedding-model-toolbar">
          <p>
            {providerCount > 0
              ? t("embeddingModel.providerInstanceSummary", { providers: providerCount, instances: instanceCount })
              : t("embeddingModel.noProviderConfigured")}
          </p>
          {canManage ? (
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus />
              {t("embeddingModel.addProvider")}
            </Button>
          ) : null}
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
        <EmptyState
          className="py-16"
          icon={<Cpu />}
          title={t("embeddingModel.emptyTitle")}
          description={t("embeddingModel.emptyDescription")}
        />
      ) : (
        <div className="embedding-model-tree">
          <div className="divide-y divide-slate-100">
            {treeSafe.map((p) => (
              <ProviderRow
                key={p.provider}
                provider={p}
                canManage={canManage}
                onDeleteInstance={(inst) => setDeleteTarget(inst)}
                onModelsChanged={onModelsChanged}
              />
            ))}
          </div>
        </div>
      )}

      <AddProviderDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={() => {
          setRefreshKey((k) => k + 1);
          onModelsChanged?.();
        }}
      />

      {/* 删除实例二次确认：文案沿用删除按钮的 tooltip 作标题、原 confirm 文案作描述（含实例名/供应商/模型数插值）。 */}
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("embeddingModel.deleteInstanceTitle")}
        description={t("embeddingModel.deleteConfirm", {
          instance: deleteTarget?.instanceName ?? "",
          provider: deleteTarget?.provider ?? "",
          count: deleteTarget?.models?.length ?? 0,
        })}
        variant="destructive"
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (target) runDeleteInstance(target);
        }}
      />
    </div>
  );
}

// ===== 供应商行（第一级，可折叠展开实例） =====

interface ProviderRowProps {
  provider: ConfiguredProviderNode;
  canManage: boolean;
  onDeleteInstance: (inst: ConfiguredInstanceNode) => void;
  onModelsChanged?: () => void;
}

function ProviderRow({ provider, canManage, onDeleteInstance, onModelsChanged }: ProviderRowProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);
  const [expanded, setExpanded] = useState(false);
  const instances = provider.instances ?? [];
  const totalModels = instances.reduce((s, i) => s + (i.models?.length ?? 0), 0);
  return (
    <div className="transition-colors">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="group flex w-full items-center gap-3 px-5 py-3.5 hover:bg-gray-50 transition-colors border-l-3 border-l-transparent hover:border-l-indigo-500"
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-50 to-violet-50 text-indigo-500">
          <Boxes className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0 text-left">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-900 truncate">{provider.provider}</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-3xs text-slate-400">
            <span>{t("embeddingModel.instanceCount", { count: instances.length })}</span>
            <span className="text-slate-200">·</span>
            <span>{t("embeddingModel.modelCount", { count: totalModels })}</span>
          </div>
        </div>
        <ChevronRight className={`h-4 w-4 text-slate-400 transition-transform ${expanded ? "rotate-90" : ""}`} />
      </button>
      {expanded && (
        <div className="bg-gray-50/50">
          {instances.map((inst) => (
            <InstanceRow
              key={inst.instanceName}
              instance={inst}
              canManage={canManage}
              onDelete={() => onDeleteInstance(inst)}
              onModelsChanged={onModelsChanged}
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
  onModelsChanged?: () => void;
}

function InstanceRow({ instance, canManage, onDelete, onModelsChanged }: InstanceRowProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);
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
      toast.success(nextActive ? t("embeddingModel.modelEnabled") : t("embeddingModel.modelDisabled"));
      // 通知父层刷新「创建知识库」表单选项，使屏蔽/启用立即反映到嵌入模型下拉
      onModelsChanged?.();
    } catch (err) {
      console.error("Failed to toggle embedding model status", err);
      toast.error(t("embeddingModel.actionFailed"));
    } finally {
      setTogglingModel(null);
    }
  };

  return (
    <div className="border-t border-slate-100">
      <div className="group flex items-center gap-3 pl-10 pr-5 py-2.5 hover:bg-white transition-colors">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex flex-1 items-center gap-2.5 min-w-0 text-left"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 text-slate-300 transition-transform shrink-0 ${expanded ? "rotate-90" : ""}`}
          />
          <KeyRound className="h-3.5 w-3.5 text-slate-400 shrink-0" />
          <span className="text-xs font-medium text-gray-700 truncate font-mono">{instance.instanceName}</span>
          <span className="text-3xs text-slate-400">
            {t("embeddingModel.enabledRatio", { active: activeCount, total: models.length })}
          </span>
        </button>
        {canManage && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 text-slate-300 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all"
            onClick={onDelete}
            title={t("embeddingModel.deleteInstanceTitle")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      {expanded && models.length > 0 && (
        <div className="pl-17 pr-5 pb-2.5 space-y-0.5">
          {models.map((m) => {
            const st = modelStatus[m.name] ?? m.status;
            return (
              <div
                key={m.name}
                className="group flex items-center gap-3 py-1.5 px-2 rounded-lg hover:bg-white transition-colors"
              >
                <Cpu className={`h-3.5 w-3.5 shrink-0 ${st === "active" ? "text-indigo-500" : "text-slate-300"}`} />
                <span
                  className={`text-xs font-mono truncate ${st === "active" ? "text-slate-600" : "text-slate-400 line-through"}`}
                >
                  {m.name}
                </span>
                {m.modelType && !m.modelType.includes("embedding") && (
                  <span className="text-3xs text-slate-400 bg-slate-100 rounded px-1.5 py-0.5 shrink-0">
                    {m.modelType}
                  </span>
                )}
                <div className="flex-1" />
                {canManage && (
                  <Switch
                    checked={st === "active"}
                    disabled={togglingModel === m.name}
                    onCheckedChange={(checked) => handleToggleModel(m, checked === true)}
                    title={st === "active" ? t("embeddingModel.clickToDisable") : t("embeddingModel.clickToEnable")}
                  />
                )}
              </div>
            );
          })}
          <p className="text-3xs text-slate-400 pl-2 pt-1.5 leading-relaxed">{t("embeddingModel.disableNote")}</p>
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
  const { t } = useTranslation(NS.KNOWLEDGE);
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
    onError: (err) => {
      console.error("Failed to load embedding factories", err);
      toast.error(t("embeddingModel.factoriesLoadFailed"));
    },
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
      toast.error(t("embeddingModel.selectProviderRequired"));
      return;
    }
    if (!apiKey.trim()) {
      toast.error(t("embeddingModel.apiKeyRequired"));
      return;
    }
    if (!instanceName.trim()) {
      toast.error(t("embeddingModel.instanceNameRequired"));
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
        toast.error(verifyResult.message || t("embeddingModel.verifyFailed"));
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
      toast.success(t("embeddingModel.instanceAdded", { name: instanceName.trim() }));
      handleClose(false);
      onAdded();
    } catch (err) {
      console.error("Failed to add embedding instance", err);
      toast.error(t("embeddingModel.addFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-130">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-4 w-4 text-indigo-500" />
            {t("embeddingModel.addDialogTitle")}
          </DialogTitle>
          <DialogDescription>{t("embeddingModel.addDialogDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-600">{t("embeddingModel.providerLabel")}</label>
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
                <SelectValue
                  placeholder={
                    factoriesLoading ? t("embeddingModel.loading") : t("embeddingModel.selectProviderPlaceholder")
                  }
                />
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
            <label className="text-xs font-medium text-slate-600">API Key</label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={t("embeddingModel.apiKeyPlaceholder")}
              className="h-10"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-600">{t("embeddingModel.instanceNameLabel")}</label>
            <Input
              value={instanceName}
              onChange={(e) => setInstanceName(e.target.value)}
              placeholder={t("embeddingModel.instanceNamePlaceholder")}
              className="h-10"
              onBlur={() => setTouched(true)}
            />
            {touched && !instanceName.trim() && (
              <p className="text-3xs text-red-500">{t("embeddingModel.instanceNameInvalid")}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-600">{t("embeddingModel.baseUrlLabel")}</label>
            <Input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t("embeddingModel.baseUrlPlaceholder")}
              className="h-10"
            />
          </div>
          <div className="flex items-start gap-2 text-xs text-slate-600 bg-slate-50 rounded-lg px-3 py-2.5 ring-1 ring-inset ring-slate-100">
            <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-500 mt-0.5" />
            <span>{t("embeddingModel.verifyNote")}</span>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => handleClose(false)} disabled={submitting} className="h-9">
            {t("embeddingModel.cancel")}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || !selectedFactory || !apiKey.trim() || !instanceName.trim()}
            className="h-9 gap-1.5 bg-indigo-500 hover:bg-indigo-500"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {t("embeddingModel.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
