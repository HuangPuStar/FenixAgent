import { Settings } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { modelApi } from "@/src/api/sdk";
import type { ModelEntry } from "@/src/types/config";

export function buildModelOptions(available: ModelEntry[]): { value: string; label: string }[] {
  return available.map((m) => ({ value: m.fullId, label: `${m.label} (${m.provider})` }));
}

interface ModelConfigDialogProps {
  currentModel: string | null;
  currentSmallModel: string | null;
  available: ModelEntry[];
}

export function ModelConfigDialog({ currentModel, currentSmallModel, available }: ModelConfigDialogProps) {
  const [open, setOpen] = useState(false);
  const [customModel, setCustomModel] = useState("");
  const [customSmallModel, setCustomSmallModel] = useState("");
  const { t } = useTranslation("components");

  const modelOptions = buildModelOptions(available);

  const handleModelChange = async (field: "model" | "small_model", value: string) => {
    const { error } = await modelApi.set({ [field]: value });
    if (error) {
      toast.error(t("modelConfig.updateError", { message: error.message }));
      return;
    }
    toast.success(t("modelConfig.updateSuccess"));
  };

  const handleCustomModel = (field: "model" | "small_model", value: string) => {
    if (value.trim()) handleModelChange(field, value.trim());
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
              <Input
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                onBlur={() => {
                  handleCustomModel("model", customModel);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCustomModel("model", customModel);
                }}
                placeholder={t("modelConfig.manualInputPlaceholder")}
              />
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
              <Input
                value={customSmallModel}
                onChange={(e) => setCustomSmallModel(e.target.value)}
                onBlur={() => {
                  handleCustomModel("small_model", customSmallModel);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCustomModel("small_model", customSmallModel);
                }}
                placeholder={t("modelConfig.manualInputPlaceholder")}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
