import { useState, useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { DataTable, type Column } from "@/components/config/DataTable";
import { StatusBadge } from "@/components/config/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiGetModels, apiSetModels, apiRefreshModels } from "../api/client";
import type { ModelEntry, ModelConfig } from "../types/config";

export function getModelUsageStatus(fullId: string, currentModel: string | null, smallModel: string | null): string[] {
  const badges: string[] = [];
  if (currentModel === fullId) badges.push("主模型");
  if (smallModel === fullId) badges.push("轻量模型");
  return badges;
}

export function ModelsPage() {
  const [modelConfig, setModelConfig] = useState<ModelConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingField, setSavingField] = useState<string | null>(null);
  const [customModel, setCustomModel] = useState("");
  const [customSmallModel, setCustomSmallModel] = useState("");

  const loadModels = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiGetModels();
      setModelConfig(data);
    } catch (e) {
      toast.error("加载模型配置失败: " + (e instanceof Error ? e.message : "未知错误"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadModels(); }, [loadModels]);

  const handleModelChange = async (field: "model" | "small_model", value: string) => {
    setSavingField(field);
    try {
      const result = await apiSetModels({ [field]: value });
      setModelConfig((prev) => prev ? { ...prev, current: result } : prev);
      toast.success("模型已更新");
    } catch (e) {
      toast.error("更新失败: " + (e instanceof Error ? e.message : "未知错误"));
    } finally {
      setSavingField(null);
    }
  };

  const handleCustomModel = (field: "model" | "small_model", value: string) => {
    if (value.trim()) handleModelChange(field, value.trim());
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await apiRefreshModels();
      await loadModels();
      toast.success("模型列表已刷新");
    } catch (e) {
      toast.error("刷新失败: " + (e instanceof Error ? e.message : "未知错误"));
    } finally {
      setRefreshing(false);
    }
  };

  const modelOptions = useMemo(() => {
    if (!modelConfig) return [];
    return modelConfig.available.map((m) => ({ value: m.fullId, label: `${m.label} (${m.provider})` }));
  }, [modelConfig]);

  const columns: Column<ModelEntry>[] = [
    { key: "id", header: "模型 ID", sortable: true },
    { key: "provider", header: "服务商", sortable: true },
    { key: "label", header: "显示名" },
    {
      key: "usage",
      header: "使用状态",
      render: (row) => {
        const badges = getModelUsageStatus(row.fullId, modelConfig?.current.model ?? null, modelConfig?.current.small_model ?? null);
        return badges.length > 0 ? (
          <div className="flex gap-1">{badges.map((b) => <StatusBadge key={b} status={b === "主模型" ? "configured" : "builtIn"} />)}</div>
        ) : "—";
      },
    },
  ];

  if (loading) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">加载中...</div>;
  }

  return (
    <div className="p-6 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">当前模型配置</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center gap-4">
              <label className="text-sm font-medium w-20">主模型</label>
              <Select
                value={modelConfig?.current.model ?? ""}
                onValueChange={(v) => handleModelChange("model", v)}
                disabled={savingField === "model"}
              >
                <SelectTrigger className="w-64">
                  <SelectValue placeholder="选择主模型" />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {modelConfig?.current.model && <StatusBadge status="configured" />}
            </div>
            <div className="flex items-center gap-4">
              <label className="text-sm font-medium w-20"></label>
              <Input
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                onBlur={() => handleCustomModel("model", customModel)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCustomModel("model", customModel); }}
                placeholder="或手动输入模型 ID"
                className="w-64"
              />
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-4">
              <label className="text-sm font-medium w-20">轻量模型</label>
              <Select
                value={modelConfig?.current.small_model ?? ""}
                onValueChange={(v) => handleModelChange("small_model", v)}
                disabled={savingField === "small_model"}
              >
                <SelectTrigger className="w-64">
                  <SelectValue placeholder="选择轻量模型" />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {modelConfig?.current.small_model && <StatusBadge status="configured" />}
            </div>
            <div className="flex items-center gap-4">
              <label className="text-sm font-medium w-20"></label>
              <Input
                value={customSmallModel}
                onChange={(e) => setCustomSmallModel(e.target.value)}
                onBlur={() => handleCustomModel("small_model", customSmallModel)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCustomModel("small_model", customSmallModel); }}
                placeholder="或手动输入模型 ID"
                className="w-64"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">可用模型</h2>
        <Button variant="outline" onClick={handleRefresh} disabled={refreshing}>
          {refreshing ? "刷新中..." : "刷新"}
        </Button>
      </div>
      <DataTable<ModelEntry>
        columns={columns}
        data={modelConfig?.available ?? []}
        searchable
        searchPlaceholder="搜索模型..."
      />
    </div>
  );
}
