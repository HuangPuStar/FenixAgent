import { Settings } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { modelApi } from "@/src/api/sdk";
import { NS } from "@/src/i18n";
import { dispatchConfigChange } from "@/src/lib/config-events";
import type { ModelConfig, ModelEntry } from "@/src/types/config";

export function buildModelOptions(available: ModelEntry[]): { value: string; label: string }[] {
  return available.map((m) => ({ value: m.fullId, label: `${m.label} (${m.provider})` }));
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

  const handleModelChange = async (field: "model" | "small_model", value: string) => {
    const { data, error } = await modelApi.set({ [field]: value });
    if (error) {
      toast.error(t("modelConfig.updateError", { message: error.message }));
      return;
    }
    const fallbackUpdate: ModelConfigUpdate = field === "model" ? { model: value } : { small_model: value };
    onConfigChange?.((data as unknown as ModelConfigUpdate | undefined) ?? fallbackUpdate);
    dispatchConfigChange("models");
    toast.success(t("modelConfig.updateSuccess"));
  };

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
              <Select value={currentModel ?? ""} onValueChange={(v) => handleModelChange("model", v)}>
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
              <Select value={currentSmallModel ?? ""} onValueChange={(v) => handleModelChange("small_model", v)}>
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
