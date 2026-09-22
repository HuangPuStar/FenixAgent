// web/src/pages/admin/components/InstanceRow.tsx
// 实例行：左侧实例/用户，中间 Machine/外部沙盒 ID/心跳，右侧状态点与动作。
// 自原 AdminSandboxPage.tsx 拆出，字段与布局保持原样。

import { formatDateTime } from "@fenix/ui-components/lib/format";
import { Button } from "@fenix/ui-components/ui/button";
import { useTranslation } from "react-i18next";

import { SANDBOX_NS } from "../../../../i18n/namespace";
import type { SandboxInstance } from "../../../api/system-sandbox";

interface InstanceRowProps {
  instance: SandboxInstance;
  onDetail: () => void;
  onProviderPayload: () => void;
  onDelete: () => void;
  onRebuild: () => void;
}

// 状态点没有文字标签，颜色即语义；未知状态统一按「进行中」显示为琥珀色（原实现的 else 分支）。
const STATUS_DOT_CLASS: Record<string, string> = {
  ready: "bg-emerald-500 ring-emerald-200",
  error: "bg-red-500 ring-red-200",
  stopped: "bg-slate-400 ring-slate-200",
};

export function InstanceRow({ instance, onDetail, onProviderPayload, onDelete, onRebuild }: InstanceRowProps) {
  const { t } = useTranslation(SANDBOX_NS);
  // 状态点既是颜色也是按钮，读屏用户只能靠 aria-label 得知状态与点击后果。
  const statusLabel = t("statusDotTitle", { status: instance.status });
  return (
    <div className="grid grid-cols-[minmax(220px,1fr)_minmax(260px,1.2fr)_24px_auto] items-start gap-4 border-b border-border py-3 text-xs last:border-0">
      <span className="space-y-1">
        <span className="block">
          <b>{t("instanceId")}：</b>
          <span className="font-mono break-all">{instance.id}</span>
        </span>
        <span className="block">
          <b>{t("userLabel")}：</b>
          {instance.user.name} <span className="whitespace-nowrap">（{instance.user.id}）</span>
        </span>
      </span>
      <span className="space-y-1">
        <span className="block">
          <b>{t("machineLabel")}：</b>
          <span className="font-mono break-all">{instance.machine.id}</span>
        </span>
        <span className="block">
          <b>{t("externalSandboxId")}：</b>
          <span className="font-mono break-all">{instance.externalSandboxId ?? "-"}</span>
        </span>
        <span className="block">
          <b>{t("lastHeartbeatAt")}：</b>
          {formatDateTime(instance.lastHeartbeatAt, { fallback: "-" })}
        </span>
      </span>
      <span className="pt-1">
        <button
          type="button"
          title={statusLabel}
          aria-label={statusLabel}
          className={`inline-block size-3 rounded-full border-0 p-0 align-middle ring-2 ring-offset-2 ${
            STATUS_DOT_CLASS[instance.status] ?? "bg-amber-500 ring-amber-200"
          }`}
          onClick={onProviderPayload}
        />
      </span>
      <span className="flex min-w-[260px] flex-col items-end justify-end gap-2 self-stretch">
        <span className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onDetail}>
            {t("detail")}
          </Button>
          <Button size="sm" variant="outline" onClick={onRebuild}>
            {t("rebuildAction")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
            onClick={onDelete}
          >
            {t("delete")}
          </Button>
        </span>
      </span>
    </div>
  );
}
