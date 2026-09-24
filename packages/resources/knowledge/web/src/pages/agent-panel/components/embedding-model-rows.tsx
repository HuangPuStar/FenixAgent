/**
 * embedding-model-rows — 三级树里的两级列表行（供应商行 → 实例行 → 模型开关）。
 *
 * 从 `EmbeddingModelManager.tsx` 拆出（§4.7）：行组件只吃一个节点 + 权限与回调，
 * 与管理器壳的取数、刷新键、删除确认弹窗无关。
 */

import { Button } from "@fenix/ui-components/ui/button";
import { Switch } from "@fenix/ui-components/ui/switch";
import { unwrap } from "@fenix/web-runtime/api/request";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Boxes, ChevronRight, Cpu, KeyRound, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { embeddingModelApi } from "../../../../api/knowledge-models";
import type { ConfiguredInstanceNode, ConfiguredProviderNode, InstanceModelOption } from "../../../../types/knowledge";

// ===== 供应商行（第一级，可折叠展开实例） =====

interface ProviderRowProps {
  provider: ConfiguredProviderNode;
  canManage: boolean;
  onDeleteInstance: (inst: ConfiguredInstanceNode) => void;
  onModelsChanged?: () => void;
}

export function ProviderRow({ provider, canManage, onDeleteInstance, onModelsChanged }: ProviderRowProps) {
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
