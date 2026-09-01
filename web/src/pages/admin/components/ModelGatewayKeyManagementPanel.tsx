import { useRequest } from "ahooks";
import { RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Pagination } from "@/components/ui/pagination";
import { listModelGatewayKeys, type ModelGatewayManagedKey, removeModelGatewayKeys } from "@/src/api/model-gateway";
import { ApiError } from "@/src/api/request";

function keyReason(key: ModelGatewayManagedKey): string {
  return key.usable ? "usable" : (key.invalidReason ?? "unusable");
}

/** 管理 Fenix 创建的 Virtual Key；密钥明文从不返回浏览器。 */
export function ModelGatewayKeyManagementPanel({ onAuthFailure }: { onAuthFailure: () => void }) {
  const { t } = useTranslation("observer");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const reportError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.code === "UNAUTHORIZED") onAuthFailure();
      else toast.error(t("modelGateway.keysPage.loadError"));
    },
    [onAuthFailure, t],
  );
  const keysRequest = useRequest(() => listModelGatewayKeys(page), {
    refreshDeps: [page],
    onError: reportError,
  });
  const removeRequest = useRequest(() => removeModelGatewayKeys(selectedIds), {
    manual: true,
    onSuccess: (result) => {
      setConfirmOpen(false);
      setSelectedIds([]);
      toast.success(t("modelGateway.keysPage.removeSuccess", { count: result.deletedIds.length }));
      if (result.skipped.length > 0)
        toast.info(t("modelGateway.keysPage.removeSkipped", { count: result.skipped.length }));
      if (result.failed.length > 0)
        toast.error(t("modelGateway.keysPage.removeFailed", { count: result.failed.length }));
      void keysRequest.run();
    },
    onError: reportError,
  });

  const selectedKeys = useMemo(
    () => selectedIds.filter((id) => (keysRequest.data?.items ?? []).some((item) => item.id === id)),
    [keysRequest.data, selectedIds],
  );
  const totalPages = Math.max(1, Math.ceil((keysRequest.data?.total ?? 0) / (keysRequest.data?.pageSize ?? 20)));

  function toggle(id: string, checked: boolean) {
    setSelectedIds((current) => (checked ? [...new Set([...current, id])] : current.filter((item) => item !== id)));
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <div>
          <CardTitle className="text-sm">{t("modelGateway.keysPage.title")}</CardTitle>
          <p className="mt-1 text-xs text-text-muted">{t("modelGateway.keysPage.description")}</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => keysRequest.run()} disabled={keysRequest.loading}>
            <RefreshCw className={keysRequest.loading ? "size-3.5 animate-spin" : "size-3.5"} />
            {t("modelGateway.keysPage.refresh")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={selectedKeys.length === 0}
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 className="size-3.5" />
            {t("modelGateway.keysPage.remove")}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {keysRequest.error ? (
          <p className="py-8 text-center text-sm text-destructive">{t("modelGateway.keysPage.loadError")}</p>
        ) : keysRequest.loading && !keysRequest.data ? (
          <p className="py-8 text-center text-sm text-text-muted">{t("states.loading")}</p>
        ) : (keysRequest.data?.items.length ?? 0) === 0 ? (
          <p className="py-8 text-center text-sm text-text-muted">{t("modelGateway.keysPage.empty")}</p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="w-10 px-3 py-2" />
                    <th className="px-3 py-2">{t("modelGateway.keysPage.columns.id")}</th>
                    <th className="px-3 py-2">{t("modelGateway.keysPage.columns.subject")}</th>
                    <th className="px-3 py-2">{t("modelGateway.keysPage.columns.key")}</th>
                    <th className="px-3 py-2">{t("modelGateway.keysPage.columns.availability")}</th>
                    <th className="px-3 py-2">{t("modelGateway.keysPage.columns.createdAt")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {keysRequest.data?.items.map((item) => (
                    <tr key={item.id}>
                      <td className="px-3 py-2">
                        <Checkbox
                          checked={selectedIds.includes(item.id)}
                          onCheckedChange={(value) => toggle(item.id, value === true)}
                          aria-label={t("modelGateway.keysPage.select", { id: item.externalCredentialId })}
                        />
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{item.id}</td>
                      <td className="px-3 py-2 text-xs align-top">
                        <div>
                          <span className="font-semibold">
                            {t("modelGateway.keysPage.subjectLabels.organization")}：
                          </span>
                          {item.organizationName ?? t("modelGateway.keysPage.unknownSubject")}（{item.organizationId}）
                        </div>
                        <div>
                          <span className="font-semibold">{t("modelGateway.keysPage.subjectLabels.user")}：</span>
                          {item.userName ?? t("modelGateway.keysPage.unknownSubject")}（{item.userId}）
                        </div>
                        <div>
                          <span className="font-semibold">{t("modelGateway.keysPage.subjectLabels.agent")}：</span>
                          {item.agentName ?? t("modelGateway.keysPage.unknownSubject")}（{item.agentConfigId}）
                        </div>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        <div className="w-[20ch] truncate" title={item.externalCredentialId}>
                          {item.externalCredentialId}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={item.usable ? "secondary" : "destructive"}>
                          {t(`modelGateway.keysPage.reasons.${keyReason(item)}`)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-xs text-text-muted">{new Date(item.createdAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              totalPages={totalPages}
              total={keysRequest.data?.total ?? 0}
              pageSize={keysRequest.data?.pageSize ?? 20}
              onPageChange={setPage}
              translationPrefix="modelGateway.keysPage"
              t={t}
            />
          </>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        variant="destructive"
        loading={removeRequest.loading}
        title={t("modelGateway.keysPage.removeTitle")}
        description={t("modelGateway.keysPage.removeDescription", { count: selectedKeys.length })}
        confirmLabel={t("modelGateway.keysPage.remove")}
        onConfirm={() => removeRequest.run()}
      />
    </Card>
  );
}
