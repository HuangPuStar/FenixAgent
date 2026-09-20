// web/src/pages/admin/components/ClusterDialogs.tsx
// Cluster 管理面板的两个编辑对话框（Pool / Server）。自原 AdminSandboxPage.tsx 拆出。
//
// 两个对话框都受控于「打开时用 props 重置本地草稿」的模式：编辑中的输入只在本地 state，
// 点保存才回传。放在同一个文件是因为它们共享同一套「打开即重置」约定与同一批字段工具，
// 拆成两个文件反而会让这份约定分叉。

import { Button } from "@fenix/ui-components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Input } from "@fenix/ui-components/ui/input";
import { Label } from "@fenix/ui-components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@fenix/ui-components/ui/select";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { SANDBOX_NS } from "../../../../i18n/namespace";
import type { ClusterPool } from "../../../api/system-sandbox";
import type { ClusterServerForm } from "../sandbox-admin-types";

interface ClusterPoolDialogProps {
  open: boolean;
  pool: ClusterPool | null;
  onOpenChange: (open: boolean) => void;
  onSave: (pool: ClusterPool) => Promise<void>;
}

export function ClusterPoolDialog({ open, pool, onOpenChange, onSave }: ClusterPoolDialogProps) {
  const { t } = useTranslation(SANDBOX_NS);
  const [value, setValue] = useState<ClusterPool | null>(pool);
  useEffect(() => {
    if (open) setValue(pool);
  }, [open, pool]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{pool?.id ? t("editClusterPool") : t("createClusterPool")}</DialogTitle>
        </DialogHeader>
        {value ? (
          <div className="space-y-3">
            <div>
              <Label htmlFor="cluster-pool-id">{t("fieldId")}</Label>
              <Input
                id="cluster-pool-id"
                value={value.id}
                // 已有池的 id 是主键，只允许新建时填写；改动会让历史 Server 失去归属。
                disabled={Boolean(pool?.id)}
                onChange={(e) => setValue({ ...value, id: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="cluster-pool-name">{t("name")}</Label>
              <Input
                id="cluster-pool-name"
                value={value.name}
                onChange={(e) => setValue({ ...value, name: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="cluster-pool-status">{t("status")}</Label>
              <Input
                id="cluster-pool-status"
                value={value.status}
                onChange={(e) => setValue({ ...value, status: e.target.value })}
              />
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button disabled={!value?.id || !value.name} onClick={() => value && void onSave(value)}>
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ClusterServerDialogProps {
  open: boolean;
  server: ClusterServerForm | null;
  onOpenChange: (open: boolean) => void;
  onSave: (server: ClusterServerForm, apiKey: string) => Promise<void>;
}

export function ClusterServerDialog({ open, server, onOpenChange, onSave }: ClusterServerDialogProps) {
  const { t } = useTranslation(SANDBOX_NS);
  const [value, setValue] = useState<ClusterServerForm | null>(server);
  const [apiKey, setApiKey] = useState("");
  useEffect(() => {
    if (open) {
      setValue(server);
      // api_key 不回显（后端只返回掩码），每次打开都要求重新输入；留空表示沿用原 key。
      setApiKey("");
    }
  }, [open, server]);
  const update = (patch: Partial<ClusterServerForm>) => value && setValue({ ...value, ...patch });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{server?.id ? t("editClusterServer") : t("createClusterServer")}</DialogTitle>
        </DialogHeader>
        {value ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="cluster-server-id">{t("fieldId")}</Label>
              <Input
                id="cluster-server-id"
                value={value.id}
                disabled={Boolean(server?.id)}
                onChange={(e) => update({ id: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="cluster-server-name">{t("name")}</Label>
              <Input id="cluster-server-name" value={value.name} onChange={(e) => update({ name: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="cluster-server-pool-id">{t("fieldPoolId")}</Label>
              <Input
                id="cluster-server-pool-id"
                value={value.pool_id}
                onChange={(e) => update({ pool_id: e.target.value })}
              />
            </div>
            <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
              <div>
                <Label htmlFor="cluster-server-transport">{t("transportMode")}</Label>
                <Select
                  value={value.transport_mode}
                  onValueChange={(transportMode: ClusterServerForm["transport_mode"]) =>
                    update({ transport_mode: transportMode })
                  }
                >
                  <SelectTrigger id="cluster-server-transport" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {/* 枚举值即标签：与后端 frpc/HTTP 配置保持一致，不翻译。 */}
                    <SelectItem value="direct">direct</SelectItem>
                    <SelectItem value="tunnel">tunnel</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="cluster-server-base-url">{t("baseUrl")}</Label>
                <Input
                  id="cluster-server-base-url"
                  value={value.base_url}
                  disabled={value.transport_mode === "tunnel"}
                  placeholder={value.transport_mode === "tunnel" ? t("baseUrlTunnelHint") : undefined}
                  onChange={(e) => update({ base_url: e.target.value })}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="cluster-server-workspace-root">{t("workspaceRoot")}</Label>
              <Input
                id="cluster-server-workspace-root"
                value={value.workspace_root}
                onChange={(e) => update({ workspace_root: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="cluster-server-max-sandboxes">{t("maxSandboxes")}</Label>
              <Input
                id="cluster-server-max-sandboxes"
                type="number"
                min="1"
                value={value.max_sandboxes}
                onChange={(e) => update({ max_sandboxes: Number(e.target.value) })}
              />
            </div>
            <div>
              <Label htmlFor="cluster-server-status">{t("status")}</Label>
              <Select value={value.status} onValueChange={(status) => update({ status })}>
                <SelectTrigger id="cluster-server-status" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">active</SelectItem>
                  <SelectItem value="draining">draining</SelectItem>
                  <SelectItem value="disabled">disabled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="cluster-server-api-key">
                {server?.id ? `${t("apiKey")}${t("apiKeyKeepHint")}` : t("apiKey")}
              </Label>
              <Input
                id="cluster-server-api-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            disabled={
              !value?.id ||
              !value.name ||
              !value.pool_id ||
              !value.workspace_root ||
              (value.transport_mode === "direct" && !value.base_url) ||
              (!server?.id && !apiKey)
            }
            onClick={() => value && void onSave(value, apiKey)}
          >
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
