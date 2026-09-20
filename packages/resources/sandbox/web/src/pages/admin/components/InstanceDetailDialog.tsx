// web/src/pages/admin/components/InstanceDetailDialog.tsx
// 实例详情对话框：只读元信息 + 生效资源 + 资源覆盖值编辑。自原 AdminSandboxPage.tsx 拆出。
//
// 编辑语义（沿用原实现）：输入框可清空，但只有「被改动过的字段」才进入 PATCH；清空即取消覆盖。
// `dirty` 集合是唯一的改动真相，避免把空字符串误当作“设为 0”。

import { Button } from "@fenix/ui-components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Input } from "@fenix/ui-components/ui/input";
import { Label } from "@fenix/ui-components/ui/label";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { SANDBOX_NS } from "../../../../i18n/namespace";
import {
  buildSandboxResourcePatch,
  type SandboxInstance,
  type SandboxResourcePatch,
} from "../../../api/system-sandbox";

type ResourceKey = keyof SandboxResourcePatch;

const EMPTY_VALUES: Record<ResourceKey, string> = { cpu: "", memoryMb: "", diskGb: "", gpuCount: "" };

// 展示顺序即原实现的顺序；键名 → 文案键映射，避免把中文写死在 JSX 里。
const RESOURCE_FIELDS = [
  { key: "cpu", labelKey: "resourceCpu", unitKey: "unitCore" },
  { key: "memoryMb", labelKey: "resourceMemory", unitKey: "unitMegabyte" },
  { key: "diskGb", labelKey: "resourceDisk", unitKey: "unitGigabyte" },
  { key: "gpuCount", labelKey: "resourceGpu", unitKey: "unitGpu" },
] as const satisfies ReadonlyArray<{ key: ResourceKey; labelKey: string; unitKey: string }>;

interface InstanceDetailDialogProps {
  instance: SandboxInstance | null;
  editMode: boolean;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (patch: SandboxResourcePatch) => Promise<void>;
}

export function InstanceDetailDialog({ instance, editMode, loading, onOpenChange, onSave }: InstanceDetailDialogProps) {
  const { t } = useTranslation(SANDBOX_NS);
  const [editing, setEditing] = useState(editMode);
  const [values, setValues] = useState<Record<ResourceKey, string>>(EMPTY_VALUES);
  const [dirty, setDirty] = useState<Set<ResourceKey>>(new Set());
  const firstInputRef = useRef<HTMLInputElement>(null);
  const open = instance !== null;
  const effectiveResources = instance?.resolvedConfig?.resources;
  const effectiveValue = useCallback(
    (key: ResourceKey) => {
      // resolvedConfig.resources 是后端任意 JSON：非对象一律当作「没有生效值」，不做猜测。
      const resources =
        effectiveResources && typeof effectiveResources === "object" && !Array.isArray(effectiveResources)
          ? (effectiveResources as Record<string, unknown>)
          : undefined;
      const value = resources?.[key];
      return typeof value === "number" ? value : undefined;
    },
    [effectiveResources],
  );
  const resetForm = useCallback(() => {
    if (!instance) return;
    setValues({
      cpu: effectiveValue("cpu")?.toString() ?? "",
      memoryMb: effectiveValue("memoryMb")?.toString() ?? "",
      diskGb: effectiveValue("diskGb")?.toString() ?? "",
      gpuCount: effectiveValue("gpuCount")?.toString() ?? "",
    });
    setDirty(new Set());
  }, [effectiveValue, instance]);
  useEffect(() => {
    setEditing(editMode);
    if (open) resetForm();
  }, [editMode, open, resetForm]);
  // 从只读切到编辑时，输入框的 disabled 是原地切换、不会重新挂载，浏览器不会自动聚焦；
  // 手动把焦点移到第一个字段，键盘用户不必再 Tab 一遍。
  useEffect(() => {
    if (editing) firstInputRef.current?.focus();
  }, [editing]);
  const patch = buildSandboxResourcePatch(
    Object.fromEntries([...dirty].map((key) => [key, values[key]])) as Record<ResourceKey, string>,
  );
  const machineLabel =
    instance && instance.machine.name === instance.machine.id
      ? instance.machine.id
      : t("nameWithId", { name: instance?.machine.name ?? "", id: instance?.machine.id ?? "" });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t("instanceDetailTitle")}
            {instance ? ` · ${instance.id}` : ""}
          </DialogTitle>
        </DialogHeader>
        {instance ? (
          <div className="space-y-4 text-sm">
            <div className="grid gap-3">
              <div>
                <Label htmlFor="instance-detail-user">{t("userLabel")}</Label>
                <Input
                  id="instance-detail-user"
                  readOnly
                  value={`${instance.user.name}（${instance.user.id}）`}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="instance-detail-machine">{t("machineLabel")}</Label>
                <Input id="instance-detail-machine" readOnly value={machineLabel} className="mt-1" />
              </div>
              <div>
                <Label htmlFor="instance-detail-external-id">{t("externalSandboxId")}</Label>
                <Input
                  id="instance-detail-external-id"
                  readOnly
                  value={instance.externalSandboxId ?? "-"}
                  className="mt-1 font-mono"
                />
              </div>
              <div>
                <Label htmlFor="instance-detail-status">{t("status")}</Label>
                <Input id="instance-detail-status" readOnly value={instance.status} className="mt-1" />
              </div>
            </div>
            <div>
              <Label>{t("effectiveResources")}</Label>
              {/* 用原生 table 而不是 div + ARIA role：行/列头带 role 时必须可聚焦（tabIndex），
                  那会把只读表格变成键盘 tab 陷阱；原生语义无需任何补偿属性。 */}
              <table
                aria-label={t("effectiveResources")}
                className="mt-2 w-full overflow-hidden rounded border border-border text-xs"
              >
                <thead>
                  <tr className="bg-muted font-medium">
                    <th className="px-3 py-2 text-left font-medium">{t("resourceColumn")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("currentValueColumn")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("overrideValueColumn")}</th>
                  </tr>
                </thead>
                <tbody>
                  {RESOURCE_FIELDS.map((field) => (
                    <tr key={field.key}>
                      <td className="border-t border-border px-3 py-2">{t(field.labelKey)}</td>
                      <td className="border-t border-border px-3 py-2">
                        {effectiveValue(field.key) ?? "-"} {t(field.unitKey)}
                      </td>
                      <td className="border-t border-border px-3 py-2">
                        {instance.resourceOverrides?.[field.key] ?? t("notOverridden")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <Label>{t("resourceOverrides")}</Label>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {RESOURCE_FIELDS.map((field) => (
                  <div key={field.key}>
                    <Label htmlFor={`instance-resource-${field.key}`}>
                      {t("resourceLabelWithUnit", { resource: t(field.labelKey), unit: t(field.unitKey) })}
                    </Label>
                    <Input
                      id={`instance-resource-${field.key}`}
                      ref={field.key === "cpu" ? firstInputRef : undefined}
                      type="number"
                      min={field.key === "gpuCount" ? 0 : 0.01}
                      disabled={!editing}
                      aria-describedby="instance-resource-hint"
                      value={values[field.key]}
                      onChange={(event) => {
                        setValues((current) => ({ ...current, [field.key]: event.target.value }));
                        setDirty((current) => new Set(current).add(field.key));
                      }}
                    />
                    {editing && instance.resourceOverrides?.[field.key] !== undefined ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="mt-1 w-fit border-red-200 bg-red-50 px-2 text-xs text-red-700 hover:bg-red-100 hover:text-red-800"
                        onClick={() => {
                          setValues((current) => ({ ...current, [field.key]: "" }));
                          setDirty((current) => new Set(current).add(field.key));
                        }}
                      >
                        {t("clearOverride")}
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
              <p id="instance-resource-hint" className="mt-2 text-xs text-text-muted">
                {t("overrideHint")}
              </p>
            </div>
            <div>
              <Label>{t("environmentReadonly")}</Label>
              <pre className="mt-1 max-h-32 max-w-full overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
                {JSON.stringify(
                  (effectiveResources as Record<string, unknown> | undefined)?.environment ?? {},
                  null,
                  2,
                )}
              </pre>
            </div>
            <div>
              <Label>{t("volumesReadonly")}</Label>
              <pre className="mt-1 max-h-32 max-w-full overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
                {JSON.stringify((effectiveResources as Record<string, unknown> | undefined)?.volumes ?? [], null, 2)}
              </pre>
            </div>
          </div>
        ) : null}
        <DialogFooter>
          {editing ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  resetForm();
                  setEditing(false);
                }}
                disabled={loading}
              >
                {t("cancel")}
              </Button>
              <Button
                onClick={() => void onSave(patch)}
                disabled={loading || dirty.size === 0 || Object.keys(patch).length === 0}
              >
                {loading ? t("submitting") : t("save")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("close")}
              </Button>
              <Button onClick={() => setEditing(true)}>{t("edit")}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
