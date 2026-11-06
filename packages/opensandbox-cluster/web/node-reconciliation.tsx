import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { useState } from "react";
import type { ClusterClient } from "./api/client";
import type { NativeSandbox, Server } from "./api/types";
import { Button, Details, Feedback } from "./components";
import { t } from "./i18n";
import { useData } from "./use-data";

interface InventoryPage {
  items: NativeSandbox[];
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}

/** Explicit node reconciliation keeps native leftovers separate from managed sandbox allocations. */
export function NodeReconciliation({
  server,
  client,
  close,
}: {
  server: Server;
  client: ClusterClient;
  close: () => void;
}) {
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [details, setDetails] = useState<NativeSandbox>();
  const path = `/api/v1/servers/${encodeURIComponent(server.id)}/unbound-sandboxes`;
  const data = useData<InventoryPage>(client, `${path}?page=${page}&pageSize=20`, version);
  const remove = async (item: NativeSandbox) => {
    if (busy || !confirm(t("销毁未绑定沙盒 {{id}}？此操作不可恢复。", { id: item.provider_sandbox_id }))) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await client.request(`${path}/${encodeURIComponent(item.provider_sandbox_id)}`, { method: "DELETE" });
      setMessage(t("沙盒已销毁"));
      setVersion((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("销毁失败"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-5xl"
        disableOverlayClose={busy}
        disableEscapeClose={busy}
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>{t("沙盒对账 · {{name}}", { name: server.name })}</DialogTitle>
          <DialogDescription>
            {t("列出此节点上没有 Cluster 绑定的沙盒。核对创建时间、镜像和详情后，可手动销毁残留。")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end">
          <Button variant="outline" disabled={busy || data.loading} onClick={() => setVersion((value) => value + 1)}>
            {t("刷新对账")}
          </Button>
        </div>
        <Feedback loading={data.loading} error={data.error} retry={data.retry} />
        <Feedback error={error} />
        {message && (
          <p role="status" className="text-sm text-emerald-700">
            {message}
          </p>
        )}
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted">
              <tr>
                {["真实沙盒 ID / 镜像", "创建时间 / 运行状态", "资源配额", "操作"].map((label) => (
                  <th key={label} className="whitespace-nowrap px-4 py-3 font-medium">
                    {t(label)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.data?.items.map((item) => (
                <tr key={item.provider_sandbox_id}>
                  <td className="px-4 py-3">
                    <code className="break-all text-xs">{item.provider_sandbox_id}</code>
                    <div className="mt-1 break-all text-xs">{item.image ?? t("未返回镜像")}</div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <div>{item.created_at ? new Date(item.created_at).toLocaleString() : "—"}</div>
                    <div className="mt-1">{item.state ?? "—"}</div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {item.resources ? (
                      <div className="grid gap-1 font-mono text-xs">
                        <span>{item.resources.cpu ?? "—"} CPU</span>
                        <span>{item.resources.memoryMb ?? "—"} MB</span>
                        <span>{item.resources.diskGb ?? "—"} GB</span>
                        <span>{item.resources.gpuCount ?? "—"} GPU</span>
                      </div>
                    ) : (
                      t("节点未返回资源配额")
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setDetails(item)}>
                        {t("详情")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-600"
                        disabled={busy || data.loading}
                        onClick={() => void remove(item)}
                      >
                        {t("销毁")}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              {!data.loading && !data.error && !data.data?.items.length && (
                <tr>
                  <td colSpan={4} className="p-8 text-center text-muted-foreground">
                    {t("本页没有未绑定沙盒")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between gap-3 text-sm">
          <Button
            variant="outline"
            disabled={busy || data.loading || page <= 1}
            onClick={() => setPage((value) => value - 1)}
          >
            {t("上一页")}
          </Button>
          <span>{t("节点清单第 {{page}} 页", { page })}</span>
          <Button
            variant="outline"
            disabled={busy || data.loading || !data.data?.hasNextPage}
            onClick={() => setPage((value) => value + 1)}
          >
            {t("下一页")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("历史沙盒若未记录真实 ID 或创建标识，可能无法识别其绑定关系，请核实后操作。")}
        </p>
        {details && <Details title={t("未绑定沙盒详情")} value={details} close={() => setDetails(undefined)} />}
      </DialogContent>
    </Dialog>
  );
}
