import { useState } from "react";
import { toast } from "sonner";
import { Settings } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { apiSetModels } from "@/src/api/client";
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

  const modelOptions = buildModelOptions(available);

  const handleModelChange = async (field: "model" | "small_model", value: string) => {
    try {
      await apiSetModels({ [field]: value });
      toast.success("模型已更新");
    } catch (e) {
      toast.error("更新失败: " + (e instanceof Error ? e.message : "未知错误"));
    }
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
            <DialogTitle>模型配置</DialogTitle>
            <DialogDescription>选择主模型和轻量模型</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">主模型</label>
              <Select
                value={currentModel ?? ""}
                onValueChange={(v) => handleModelChange("model", v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择主模型" />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                onBlur={() => { handleCustomModel("model", customModel); }}
                onKeyDown={(e) => { if (e.key === "Enter") handleCustomModel("model", customModel); }}
                placeholder="或手动输入模型 ID"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">轻量模型</label>
              <Select
                value={currentSmallModel ?? ""}
                onValueChange={(v) => handleModelChange("small_model", v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="选择轻量模型" />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={customSmallModel}
                onChange={(e) => setCustomSmallModel(e.target.value)}
                onBlur={() => { handleCustomModel("small_model", customSmallModel); }}
                onKeyDown={(e) => { if (e.key === "Enter") handleCustomModel("small_model", customSmallModel); }}
                placeholder="或手动输入模型 ID"
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
