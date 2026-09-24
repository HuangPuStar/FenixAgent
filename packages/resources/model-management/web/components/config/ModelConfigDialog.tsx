import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@fenix/ui-components/ui/select";
import { unwrap } from "@fenix/web-runtime/api/request";
import { dispatchConfigChange } from "@fenix/web-runtime/lib/config-events";
import type { ModelConfig, ModelEntry } from "@fenix/web-runtime/types/config";
import { useRequest } from "ahooks";
import { Settings } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { modelApi } from "../../api/models.ts";
import { MODELS_NS } from "../../i18n/namespace";
import { buildModelOptions } from "../../lib/model-config-utils.ts";

export { buildModelOptions };

/** Server response shape returned after updating the current model config. */
export type ModelConfigUpdate = Partial<ModelConfig["current"]>;

/** Merge a partial model config update into the page-level model config state. */
export function mergeModelConfigUpdate(current: ModelConfig, update: ModelConfigUpdate): ModelConfig {
  return {
    ...current,
    current: {
      ...current.current,
      ...(update.model !== undefined ? { model: update.model } : {}),
      ...(update.small_model !== undefined ? { small_model: update.small_model } : {}),
      ...(update.permission !== undefined ? { permission: update.permission } : {}),
    },
  };
}

interface ModelConfigDialogProps {
  currentModel: string | null;
  currentSmallModel: string | null;
  available: ModelEntry[];
  onConfigChange?: (update: ModelConfigUpdate) => void;
}

export function ModelConfigDialog({
  currentModel,
  currentSmallModel,
  available,
  onConfigChange,
}: ModelConfigDialogProps) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation(MODELS_NS);

  const modelOptions = buildModelOptions(available);

  // 模型配置变更（仅变更成功时 toast 提示）
  const { run: runSet } = useRequest(
    async (field: string, value: string) => {
      const data = await unwrap(modelApi.set({ [field]: value }));
      return { field, value, data };
    },
    {
      manual: true,
      onSuccess: ({ field, value, data }) => {
        const fallbackUpdate: ModelConfigUpdate = field === "model" ? { model: value } : { small_model: value };
        onConfigChange?.((data as unknown as ModelConfigUpdate | undefined) ?? fallbackUpdate);
        dispatchConfigChange("models");
        toast.success(t("modelConfig.updateSuccess"));
      },
      onError: (err) => {
        // 原始 error 进日志，上屏只给字典文案（§9.3）：`err.message` 是后端信封原文。
        console.error("[model-config] update failed", err);
        toast.error(t("modelConfig.updateError"));
      },
    },
  );

  return (
    <>
      <button className="p-2 rounded-md hover:bg-muted" onClick={() => setOpen(true)}>
        <Settings className="h-5 w-5" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("modelConfig.title")}</DialogTitle>
            <DialogDescription>{t("modelConfig.description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <ModelConfigSelectField
              label={t("modelConfig.primaryModel")}
              placeholder={t("modelConfig.primaryModelPlaceholder")}
              value={currentModel ?? ""}
              options={modelOptions}
              onChange={(value) => runSet("model", value)}
            />
            <ModelConfigSelectField
              label={t("modelConfig.lightweightModel")}
              placeholder={t("modelConfig.lightweightModelPlaceholder")}
              value={currentSmallModel ?? ""}
              options={modelOptions}
              onChange={(value) => runSet("small_model", value)}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * 主模型 / 轻量模型两栏共用的选择字段。
 *
 * 两栏的骨架此前逐字相同（标签 + 全宽 `SelectTrigger` + 遍历同一份 `modelOptions`），
 * 只有取值、占位符与写回的字段名不同；收在这里后，改选项渲染或触发器宽度只需动一处。
 */
function ModelConfigSelectField({
  label,
  placeholder,
  value,
  options,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">{label}</label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
