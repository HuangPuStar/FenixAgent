import { useRequest } from "ahooks";
import { Settings } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { modelApi } from "@/src/api/models";
import { unwrap } from "@/src/api/request";
import { NS } from "@/src/i18n";
import { dispatchConfigChange } from "@/src/lib/config-events";
import type { ModelConfig, ModelEntry } from "@/src/types/config";

export function buildModelOptions(available: ModelEntry[]): { value: string; label: string }[] {
  return available.map((model) => {
    const source = model.providerResourceAccess?.sourceOrganizationName;
    const providerLabel = source ? `${source}/${model.providerDisplayName}` : model.providerDisplayName;
    return {
      value: model.providerResourceKey
        ? `${model.providerResourceKey}/${model.modelId}`
        : `${model.provider}/${model.modelId}`,
      label: `${providerLabel}/${model.displayName}`,
    };
  });
}

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
  const { t } = useTranslation(NS.COMPONENTS);

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
        toast.error(t("modelConfig.updateError", { message: (err as Error).message }));
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
            <div className="space-y-2">
              <label className="text-sm font-medium">{t("modelConfig.primaryModel")}</label>
              <Select value={currentModel ?? ""} onValueChange={(v) => runSet("model", v)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t("modelConfig.primaryModelPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">{t("modelConfig.lightweightModel")}</label>
              <Select value={currentSmallModel ?? ""} onValueChange={(v) => runSet("small_model", v)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t("modelConfig.lightweightModelPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
