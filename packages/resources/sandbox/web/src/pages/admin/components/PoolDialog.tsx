// web/src/pages/admin/components/PoolDialog.tsx
// 资源池新建/详情/复制对话框。自原 AdminSandboxPage.tsx 拆出。
//
// JSON 字段（defaultResources / extra）以文本编辑：只有文本合法时才同步回表单对象，
// 非法时保留文本并置错误态，保存按钮禁用——避免把半截 JSON 提交到后端。
// 两个文本域共用同一个错误标志（原实现如此）：错误提示针对「有字段不合法」，不指向具体某个域。

import { Button } from "@fenix/ui-components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Input } from "@fenix/ui-components/ui/input";
import { Label } from "@fenix/ui-components/ui/label";
import { Textarea } from "@fenix/ui-components/ui/textarea";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { SANDBOX_NS } from "../../../../i18n/namespace";
import type { SystemOrganizationOption } from "../../../api/system-organizations";
import type { SandboxPool } from "../../../api/system-sandbox";
import { OrganizationSelect } from "./OrganizationSelect";

type JsonFieldResult = { ok: true; value: unknown } | { ok: false; reason: string };

/** 解析 JSON 文本域：必须是对象（数组与标量都非法）。失败时保留 SyntaxError 文案供 title 提示。 */
function parseJsonObject(text: string): JsonFieldResult {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "not an object" };
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

interface PoolDialogProps {
  open: boolean;
  pool: SandboxPool | null;
  organizations: SystemOrganizationOption[];
  onOpenChange: (open: boolean) => void;
  onSave: (pool: SandboxPool) => void;
}

export function PoolDialog({ open, pool, organizations, onOpenChange, onSave }: PoolDialogProps) {
  const { t } = useTranslation(SANDBOX_NS);
  const [value, setValue] = useState<SandboxPool | null>(pool);
  const [defaultResourcesText, setDefaultResourcesText] = useState("");
  const [extraText, setExtraText] = useState("");
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [editing, setEditing] = useState(!pool?.createdAt);
  useEffect(() => {
    if (open) {
      setValue(pool);
      setDefaultResourcesText(pool ? JSON.stringify(pool.defaultResources, null, 2) : "");
      setExtraText(pool?.extra ? JSON.stringify(pool.extra, null, 2) : "");
      setJsonError(null);
      setEditing(!pool?.createdAt);
    }
  }, [open, pool]);
  // createdAt 为空视为新建（后端创建后才回填时间戳）：新建默认进入编辑态，已有池默认只读。
  const isCreate = !pool?.createdAt;
  const cancelEdit = () => {
    if (isCreate) {
      onOpenChange(false);
      return;
    }
    setValue(pool);
    setDefaultResourcesText(pool ? JSON.stringify(pool.defaultResources, null, 2) : "");
    setExtraText(pool?.extra ? JSON.stringify(pool.extra, null, 2) : "");
    setJsonError(null);
    setEditing(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isCreate ? t("createPool") : value?.name}</DialogTitle>
        </DialogHeader>
        {value ? (
          <div className="grid gap-3">
            <div>
              <Label>{t("fieldId")}</Label>
              <Input
                value={value.id}
                readOnly={!editing || Boolean(value.createdAt)}
                onChange={(e) => setValue({ ...value, id: e.target.value })}
              />
            </div>
            <div>
              <Label>{t("name")}</Label>
              <Input
                readOnly={!editing}
                value={value.name}
                onChange={(e) => setValue({ ...value, name: e.target.value })}
              />
            </div>
            <OrganizationSelect
              value={value.organizationId}
              organizations={organizations}
              disabled={!editing}
              onChange={(organizationId) => setValue({ ...value, organizationId })}
            />
            <div>
              <Label>{t("fieldProvider")}</Label>
              <Input
                readOnly={!editing}
                value={value.providerKey}
                onChange={(e) => setValue({ ...value, providerKey: e.target.value })}
              />
            </div>
            <div>
              <Label>{t("image")}</Label>
              <Input
                readOnly={!editing}
                value={value.image}
                onChange={(e) => setValue({ ...value, image: e.target.value })}
              />
            </div>
            <div>
              <Label>{t("defaultResourcesJson")}</Label>
              <Textarea
                value={defaultResourcesText}
                readOnly={!editing}
                aria-invalid={jsonError !== null}
                onChange={(e) => {
                  const text = e.target.value;
                  setDefaultResourcesText(text);
                  const parsed = parseJsonObject(text);
                  if (parsed.ok) {
                    setValue({ ...value, defaultResources: parsed.value as SandboxPool["defaultResources"] });
                    setJsonError(null);
                  } else {
                    setJsonError(parsed.reason);
                  }
                }}
              />
              {jsonError !== null ? (
                <p className="text-xs text-destructive" role="alert" title={jsonError}>
                  {t("invalidJson")}
                </p>
              ) : null}
            </div>
            <div>
              <Label>{t("fieldExtraJson")}</Label>
              <Textarea
                value={extraText}
                readOnly={!editing}
                aria-invalid={jsonError !== null}
                onChange={(e) => {
                  const text = e.target.value;
                  setExtraText(text);
                  // 清空等价于「无额外配置」，直接置 null 而不是报 JSON 语法错误。
                  if (!text.trim()) {
                    setValue({ ...value, extra: null });
                    setJsonError(null);
                    return;
                  }
                  const parsed = parseJsonObject(text);
                  if (parsed.ok) {
                    setValue({ ...value, extra: parsed.value as Record<string, unknown> });
                    setJsonError(null);
                  } else {
                    setJsonError(parsed.reason);
                  }
                }}
              />
              {jsonError !== null ? (
                <p className="text-xs text-destructive" role="alert" title={jsonError}>
                  {t("invalidJson")}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
        <DialogFooter>
          {editing ? (
            <>
              <Button variant="outline" onClick={cancelEdit}>
                {t("cancel")}
              </Button>
              <Button disabled={jsonError !== null} onClick={() => value && onSave(value)}>
                {t("save")}
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
