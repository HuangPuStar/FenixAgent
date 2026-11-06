import { useEffect, useState } from "react";
import type { ClusterClient } from "./api/client";
import type { Allocation, Page, Pool, Server } from "./api/types";
import { Button, Details, Feedback, Field, Select, Status } from "./components";
import { t } from "./i18n";
import { SandboxEditor } from "./sandbox-editor";
import { SandboxManual } from "./sandbox-manual";
import { useData } from "./use-data";
import { useSandboxStatus } from "./use-sandbox-status";

/** Sandbox management uses shared lifecycle and allocation APIs. */
export function Sandboxes({ client, pools, servers }: { client: ClusterClient; pools: Pool[]; servers: Server[] }) {
  const [poolId, setPoolId] = useState("");
  const [serverId, setServerId] = useState("");
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const [statusVersion, setStatusVersion] = useState(0);
  const refresh = () => {
    setVersion((v) => v + 1);
    setStatusVersion((v) => v + 1);
  };
  const [creating, setCreating] = useState(false);
  const [details, setDetails] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const query = new URLSearchParams({
    page: String(page),
    pageSize: "20",
    ...(poolId ? { pool_id: poolId } : {}),
    ...(serverId ? { server_id: serverId } : {}),
  });
  const data = useData<Page<Allocation>>(client, `/api/v1/sandbox-allocations?${query}`, version);
  const nativeStatus = useSandboxStatus(client, data.data?.items, statusVersion);
  useEffect(() => {
    if (!data.data?.items.length) return;
    const delay = data.data.items.some((item) => ["creating", "uncertain", "releasing"].includes(item.state))
      ? 5000
      : 10000;
    const timer = setInterval(() => {
      if (!document.hidden) setVersion((v) => v + 1);
    }, delay);
    return () => clearInterval(timer);
  }, [data.data]);
  const action = async (operation: () => Promise<unknown>, success = t("操作完成")) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await operation();
      setMessage(success);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("操作失败"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{t("沙盒")}</h2>
        <div className="flex gap-2">
          <Button variant="outline" onClick={refresh}>
            {t("刷新")}
          </Button>
          <Button disabled={!pools.length} onClick={() => setCreating(true)}>
            {t("新建沙盒")}
          </Button>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("筛选池")}>
          <Select
            aria-label={t("筛选池")}
            value={poolId}
            onChange={(e) => {
              setPoolId(e.target.value);
              setServerId("");
              setPage(1);
            }}
          >
            <option value="">{t("全部池")}</option>
            {pools.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("筛选节点")}>
          <Select
            aria-label={t("筛选节点")}
            value={serverId}
            onChange={(e) => {
              setServerId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">{t("全部节点")}</option>
            {servers
              .filter((s) => !poolId || s.poolId === poolId)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </Select>
        </Field>
      </div>
      <Feedback loading={data.loading} error={data.error || error} retry={data.retry} />
      {message && (
        <p role="status" className="text-sm text-emerald-700">
          {message}
        </p>
      )}
      <div className="overflow-x-auto rounded-xl border bg-background">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-muted/50 text-muted-foreground">
            <tr>
              {["沙盒 ID", "池 / 节点", "模式 / 绑定状态", "运行状态", "资源分配", "真实 ID / 到期", "操作"].map(
                (label) => (
                  <th key={label} className="whitespace-nowrap px-4 py-3 font-medium">
                    {t(label)}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody className="divide-y">
            {data.data?.items.map((item) => (
              <tr key={item.sandbox_id}>
                <td className="max-w-56 break-all px-4 py-4 font-mono text-xs">{item.sandbox_id}</td>
                <td className="px-4 py-4">
                  <div>{item.pool_id}</div>
                  <div className="text-xs text-muted-foreground">{item.server_id}</div>
                </td>
                <td className="px-4 py-4">
                  <div className="mb-1 text-xs">{item.allocation_mode}</div>
                  <Status value={item.state} />
                </td>
                <td className="px-4 py-4">
                  <Status
                    value={nativeStatus(item).state ?? (nativeStatus(item).error ? t("查询失败") : t("查询中…"))}
                  />
                  {nativeStatus(item).error && (
                    <p role="status" className="mt-1 max-w-48 break-words text-xs text-red-700">
                      {t("状态查询失败：{{error}}", { error: nativeStatus(item).error! })}
                    </p>
                  )}
                </td>
                <td className="px-4 py-4">
                  {item.resources ? (
                    <div className="grid gap-1 whitespace-nowrap font-mono text-xs tabular-nums">
                      <span>{item.resources.cpu ?? "—"} CPU</span>
                      <span>{item.resources.memoryMb ?? "—"} MB</span>
                      <span>{item.resources.diskGb ?? "—"} GB</span>
                      <span>{item.resources.gpuCount ?? "—"} GPU</span>
                    </div>
                  ) : (
                    t("未记录")
                  )}
                </td>
                <td className="max-w-56 break-all px-4 py-4 text-xs">
                  <div className="font-mono">{item.provider_sandbox_id ?? t("未关联")}</div>
                  {item.expires_at && (
                    <time className="mt-1 block text-muted-foreground">
                      {new Date(item.expires_at).toLocaleString()}
                    </time>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex min-w-56 flex-wrap gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        action(async () => {
                          const allocation = await client.request(
                            item.allocation_mode === "resources"
                              ? `/api/v2/sandboxes/${encodeURIComponent(item.sandbox_id)}`
                              : `/api/v1/sandboxes/${encodeURIComponent(item.sandbox_id)}/allocation`,
                          );
                          let native: unknown;
                          if (
                            item.provider_sandbox_id &&
                            item.state === "active" &&
                            (!item.expires_at || item.expires_at > Date.now())
                          ) {
                            try {
                              native = await client.request(
                                `${item.proxy_url}/v1/sandboxes/${encodeURIComponent(item.provider_sandbox_id)}`,
                              );
                            } catch (cause) {
                              native = { error: cause instanceof Error ? cause.message : t("请求失败") };
                            }
                          }
                          setDetails({ allocation, ...(native ? { native } : {}) });
                        }, "")
                      }
                    >
                      {t("详情")}
                    </Button>
                    {item.allocation_mode === "count" && !item.provider_sandbox_id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          if (confirm(t("仅删除绑定，不会停止正在创建或运行的沙盒。确认删除？")))
                            void action(() =>
                              client.request(`/api/v1/sandboxes/${encodeURIComponent(item.sandbox_id)}/allocation`, {
                                method: "DELETE",
                                ifMatch: item.allocation_etag,
                              }),
                            );
                        }}
                      >
                        {t("删除绑定")}
                      </Button>
                    )}
                    {item.provider_sandbox_id &&
                      item.state === "active" &&
                      (!item.expires_at || item.expires_at > Date.now()) &&
                      ["pause", "resume"].map((operation) => (
                        <Button
                          key={operation}
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            action(() =>
                              client.request(
                                `${item.proxy_url}/v1/sandboxes/${encodeURIComponent(item.provider_sandbox_id!)}/${operation}`,
                                { method: "POST" },
                              ),
                            )
                          }
                        >
                          {operation === "pause" ? t("暂停") : t("恢复")}
                        </Button>
                      ))}
                    {(item.allocation_mode === "resources" || item.provider_sandbox_id) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-600"
                        disabled={busy}
                        onClick={() => {
                          if (confirm(t("销毁沙盒 {{id}}？", { id: item.sandbox_id })))
                            void action(() => client.deleteSandbox(item), t("已提交销毁，可刷新查看回收状态"));
                        }}
                      >
                        {t("删除")}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {!data.loading && !data.error && !data.data?.items.length && (
              <tr>
                <td colSpan={7} className="p-10 text-center text-muted-foreground">
                  {t("暂无沙盒")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{t("共 {{total}} 条，第 {{page}} 页", { total: data.data?.total ?? 0, page })}</span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || data.loading}
            onClick={() => setPage((p) => p - 1)}
          >
            {t("上一页")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page * 20 >= (data.data?.total ?? 0) || data.loading}
            onClick={() => setPage((p) => p + 1)}
          >
            {t("下一页")}
          </Button>
        </div>
      </div>
      <SandboxManual />
      {creating && <SandboxEditor pools={pools} client={client} close={() => setCreating(false)} saved={refresh} />}
      {details !== undefined && <Details title={t("沙盒详情")} value={details} close={() => setDetails(undefined)} />}
    </section>
  );
}
