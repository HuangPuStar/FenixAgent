/**
 * add-embedding-provider-dialog — 「添加模型供应商」弹窗（厂商选择 + Key 校验 + 实例落库）。
 *
 * 从 `EmbeddingModelManager.tsx` 拆出（§4.7）：本弹窗自带表单状态与两步提交（先 `verify` 再 `add`），
 * 与管理器壳的树渲染、刷新键无关；成功经 `onAdded` 通知壳刷新。
 */

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
import { unwrap } from "@fenix/web-runtime/api/request";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useRequest } from "ahooks";
import { Check, Loader2, Plus, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { embeddingModelApi } from "../../../../api/knowledge-models";
import type { EmbeddingFactoryOption } from "../../../../types/knowledge";

interface AddProviderDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdded: () => void;
}

export function AddProviderDialog({ open, onOpenChange, onAdded }: AddProviderDialogProps) {
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
      onOpenChange(false);
      onAdded();
    } catch (err) {
      console.error("Failed to add embedding instance", err);
      toast.error(t("embeddingModel.addFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    /** 关闭清理**不做在这里：调用方按「每次打开换一个 `key`」重挂载本弹窗（§4.2 / §4.3），字段从默认值
     * 起算。此前这里挂着 `setTimeout(reset, 200)`——200ms 对应 Radix 的退出动画时长，是在「动画期间
     * 不能改状态，否则关闭过程会闪一次空表单」与「不重置就会残留」之间取的折中，现在这条计时器已去掉。 */
    <Dialog open={open} onOpenChange={onOpenChange}>
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
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting} className="h-9">
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
