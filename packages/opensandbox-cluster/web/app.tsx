import { Link, useSearch } from "@tanstack/react-router";
import { Boxes, Layers3, LogOut, Server as ServerIcon, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PoolEditor, ServerEditor } from "./admin-editors";
import { ClusterClient } from "./api/client";
import type { Pool, Server } from "./api/types";
import { Button, Details, Feedback, Field, Status } from "./components";
import { PoolManual, ServerManual } from "./help";
import { t } from "./i18n";
import { Sandboxes } from "./sandboxes";
import { clearSession, readSession, saveSession } from "./session";
import { useData } from "./use-data";

/** Restore the verified browser session without extending its one-day lifetime. */
export function App() {
  const [session, setSession] = useState(() => readSession(localStorage));
  const logout = useCallback(() => {
    clearSession(localStorage);
    setSession(undefined);
  }, []);
  useEffect(() => {
    if (!session) return;
    const timer = setTimeout(logout, Math.max(0, session.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [session, logout]);
  const client = useMemo(
    () =>
      new ClusterClient(() => {
        if (!session || session.expiresAt <= Date.now()) {
          logout();
          throw new Error(t("登录已过期，请重新输入密钥"));
        }
        return session.key;
      }, logout),
    [session, logout],
  );
  return session ? (
    <Console client={client} logout={logout} />
  ) : (
    <Login login={(key) => setSession(saveSession(localStorage, key))} />
  );
}
function Login({ login }: { login: (key: string) => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-5">
      <div className="w-full max-w-sm rounded-2xl border bg-white p-8 shadow-sm">
        <div className="mb-6 flex size-11 items-center justify-center rounded-xl bg-slate-900 text-white">
          <Boxes aria-hidden size={24} />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">OpenSandbox Cluster</h1>
        <p className="mb-7 mt-2 text-sm text-muted-foreground">{t("管理资源池、节点和沙盒")}</p>
        <form
          className="grid gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            setError("");
            const candidate = key.trim();
            try {
              await new ClusterClient(
                () => candidate,
                () => {},
              ).request("/api/v1/pools");
              login(candidate);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : t("登录失败"));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field
            label="CLUSTER_SERVICE_API_KEY"
            type="password"
            autoComplete="off"
            required
            value={key}
            onChange={(e) => setKey(e.target.value)}
            disabled={busy}
          />
          <Feedback error={error} />
          <Button type="submit" disabled={busy || !key.trim()}>
            {busy ? t("验证中…") : t("进入管理页")}
          </Button>
        </form>
        <div className="mt-5 flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldCheck size={14} aria-hidden />
          {t("密钥保存在当前浏览器，1 天后过期")}
        </div>
      </div>
    </main>
  );
}
function Console({ client, logout }: { client: ClusterClient; logout: () => void }) {
  const { tab } = useSearch({ from: "/" });
  const [version, setVersion] = useState(0);
  const pools = useData<Pool[]>(client, "/api/v1/pools", version);
  const servers = useData<Server[]>(client, "/api/v1/servers", version);
  const [editor, setEditor] = useState<{ kind: "pool"; item?: Pool } | { kind: "server"; item?: Server }>();
  const [details, setDetails] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const refresh = () => setVersion((v) => v + 1);
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
  const labels = { pools: t("池"), servers: t("节点"), sandboxes: t("沙盒") };
  const icons = { pools: Layers3, servers: ServerIcon, sandboxes: Boxes };
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-5">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-slate-900 text-white">
              <Boxes size={21} aria-hidden />
            </span>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">OpenSandbox Cluster</h1>
              <p className="text-xs text-muted-foreground">{t("集群管理")}</p>
            </div>
          </div>
          <Button variant="ghost" onClick={logout}>
            <LogOut size={16} aria-hidden />
            {t("退出")}
          </Button>
        </div>
      </header>
      <main className="mx-auto grid max-w-7xl gap-6 px-5 py-7">
        <div role="tablist" aria-label={t("管理资源")} className="flex w-fit gap-1 rounded-xl border bg-white p-1">
          {(["pools", "servers", "sandboxes"] as const).map((value) => {
            const Icon = icons[value];
            return (
              <Button
                asChild
                key={value}
                id={`tab-${value}`}
                role="tab"
                aria-selected={tab === value}
                aria-controls="resource-panel"
                variant={tab === value ? "default" : "ghost"}
                onClick={() => {
                  refresh();
                  setError("");
                  setMessage("");
                }}
              >
                <Link to="/" search={{ tab: value }}>
                  <Icon size={16} aria-hidden />
                  {labels[value]}
                </Link>
              </Button>
            );
          })}
        </div>
        <div role="tabpanel" id="resource-panel" aria-labelledby={`tab-${tab}`} className="grid gap-5">
          <Feedback error={error} />
          {message && (
            <p role="status" className="text-sm text-emerald-700">
              {message}
            </p>
          )}
          {tab === "sandboxes" ? (
            <>
              <Feedback error={pools.error || servers.error} retry={refresh} />
              <Sandboxes client={client} pools={pools.data ?? []} servers={servers.data ?? []} />
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-semibold">{tab === "pools" ? t("资源池") : t("节点")}</h2>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={refresh}>
                    {t("刷新")}
                  </Button>
                  <Button
                    disabled={tab === "servers" && !pools.data?.length}
                    onClick={() => setEditor(tab === "pools" ? { kind: "pool" } : { kind: "server" })}
                  >
                    {tab === "pools" ? t("新建池") : t("新建节点")}
                  </Button>
                </div>
              </div>
              <Feedback
                loading={tab === "pools" ? pools.loading : servers.loading}
                error={tab === "pools" ? pools.error : servers.error}
                retry={refresh}
              />
              <div className="overflow-x-auto rounded-xl border bg-white">
                <table className="w-full text-left text-sm">
                  <thead className="border-b bg-slate-50 text-muted-foreground">
                    <tr>
                      {(tab === "pools"
                        ? ["名称 / ID", "调度模式", "占用 / 容量", "状态", "操作"]
                        : ["名称 / ID", "所属池 / 连接", "占用 / 容量", "状态 / 健康", "操作"]
                      ).map((label) => (
                        <th key={label} className="whitespace-nowrap px-4 py-3 font-medium">
                          {t(label)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {tab === "pools"
                      ? pools.data?.map((pool) => (
                          <tr key={pool.id}>
                            <td className="px-4 py-4">
                              <div className="font-medium">{pool.name}</div>
                              <code className="text-xs text-muted-foreground">{pool.id}</code>
                            </td>
                            <td className="px-4 py-4">
                              {pool.schedulingMode === "count" ? t("数量模式") : t("资源模式")}
                            </td>
                            <td className="px-4 py-4">
                              {pool.schedulingMode === "count"
                                ? `${pool.currentSandboxes} / ${pool.capacitySandboxes}`
                                : t("{{count}} 个沙盒", { count: pool.currentSandboxes })}
                            </td>
                            <td className="px-4 py-4">
                              <Status value={pool.status} />
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex flex-wrap gap-1">
                                <Button variant="ghost" size="sm" onClick={() => setDetails(pool)}>
                                  {t("详情")}
                                </Button>
                                {pool.schedulingMode === "resources" && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() =>
                                      action(
                                        async () =>
                                          setDetails(
                                            await client.request(
                                              `/api/v1/pools/${encodeURIComponent(pool.id)}/resources`,
                                            ),
                                          ),
                                        "",
                                      )
                                    }
                                  >
                                    {t("资源")}
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setEditor({ kind: "pool", item: pool })}
                                >
                                  {t("编辑")}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-red-600"
                                  disabled={busy}
                                  onClick={() => {
                                    if (confirm(t("删除池 {{id}}？", { id: pool.id })))
                                      void action(() =>
                                        client.request(`/api/v1/pools/${encodeURIComponent(pool.id)}`, {
                                          method: "DELETE",
                                        }),
                                      );
                                  }}
                                >
                                  {t("删除")}
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))
                      : servers.data?.map((server) => (
                          <tr key={server.id}>
                            <td className="px-4 py-4">
                              <div className="font-medium">{server.name}</div>
                              <code className="text-xs text-muted-foreground">{server.id}</code>
                            </td>
                            <td className="px-4 py-4">
                              <div>{server.poolId}</div>
                              <span className="text-xs text-muted-foreground">{server.transportMode}</span>
                            </td>
                            <td className="px-4 py-4">
                              {server.maxSandboxes === null ? (
                                <div className="grid gap-1 whitespace-nowrap font-mono text-sm tabular-nums">
                                  <span>
                                    {server.allocatedResources?.cpu ?? 0}/{server.cpuCapacity} CPU
                                  </span>
                                  <span>
                                    {server.allocatedResources?.memoryMb ?? 0}/{server.memoryCapacityMb} MB
                                  </span>
                                  <span>
                                    {server.allocatedResources?.diskGb ?? 0}/{server.diskCapacityGb} GB
                                  </span>
                                  <span>
                                    {server.allocatedResources?.gpuCount ?? 0}/{server.gpuCapacity} GPU
                                  </span>
                                </div>
                              ) : (
                                `${server.currentSandboxes} / ${server.maxSandboxes}`
                              )}
                            </td>
                            <td className="px-4 py-4">
                              <div className="flex flex-wrap gap-1">
                                <Status value={server.status} />
                                <Status value={server.healthStatus} />
                              </div>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex min-w-56 flex-wrap gap-1">
                                <Button variant="ghost" size="sm" onClick={() => setDetails(server)}>
                                  {t("详情")}
                                </Button>
                                {server.maxSandboxes === null && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() =>
                                      action(
                                        async () =>
                                          setDetails(
                                            await client.request(
                                              `/api/v1/servers/${encodeURIComponent(server.id)}/resources`,
                                            ),
                                          ),
                                        "",
                                      )
                                    }
                                  >
                                    {t("资源")}
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setEditor({ kind: "server", item: server })}
                                >
                                  {t("编辑")}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() =>
                                    action(() =>
                                      client.request(`/api/v1/servers/${encodeURIComponent(server.id)}/health-check`, {
                                        method: "POST",
                                      }),
                                    )
                                  }
                                >
                                  {t("健康检查")}
                                </Button>
                                {server.transportMode === "tunnel" && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() =>
                                      action(async () => {
                                        const text = await client.request<string>(
                                          `/api/v1/servers/${encodeURIComponent(server.id)}/tunnel/frpc.toml`,
                                          { text: true },
                                        );
                                        const url = URL.createObjectURL(new Blob([text], { type: "application/toml" }));
                                        const a = document.createElement("a");
                                        a.href = url;
                                        a.download = "frpc.toml";
                                        a.click();
                                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                                      })
                                    }
                                  >
                                    {t("下载 frpc.toml")}
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-red-600"
                                  disabled={busy}
                                  onClick={() => {
                                    if (confirm(t("删除节点 {{id}}？", { id: server.id })))
                                      void action(() =>
                                        client.request(`/api/v1/servers/${encodeURIComponent(server.id)}`, {
                                          method: "DELETE",
                                        }),
                                      );
                                  }}
                                >
                                  {t("删除")}
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                    {!(tab === "pools"
                      ? pools.loading || pools.error || pools.data?.length
                      : servers.loading || servers.error || servers.data?.length) && (
                      <tr>
                        <td colSpan={5} className="p-12 text-center text-muted-foreground">
                          {tab === "pools" ? t("暂无资源池，先新建一个池") : t("暂无节点，请先创建池再注册节点")}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {tab === "pools" ? <PoolManual /> : <ServerManual />}
            </>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{t("容量由 Cluster 预留与分配，实际资源限制由节点执行。")}</p>
      </main>
      {editor?.kind === "pool" && (
        <PoolEditor item={editor.item} client={client} close={() => setEditor(undefined)} saved={refresh} />
      )}
      {editor?.kind === "server" && (
        <ServerEditor
          item={editor.item}
          pools={pools.data ?? []}
          client={client}
          close={() => setEditor(undefined)}
          saved={refresh}
        />
      )}
      {details !== undefined && <Details title={t("详情")} value={details} close={() => setDetails(undefined)} />}
    </div>
  );
}
