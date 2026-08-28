import { useRequest } from "ahooks";
import { Check, ChevronRight, ChevronsUpDown, Database, Plus, RefreshCw, Server } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "../../api/request";
import { fetchSystemPeopleTree, type SystemPeopleOrganization } from "../../api/system-people-tree";
import {
  buildSandboxRebuildRequest,
  buildSandboxResourcePatch,
  type ClusterPool,
  type ClusterServer,
  type SandboxInstance,
  type SandboxPool,
  type SandboxResourcePatch,
  systemSandboxApi,
} from "../../api/system-sandbox";
import { clearAdminKey, getAdminKey } from "../../lib/admin-key";
import { MasterKeyGate } from "./components/MasterKeyGate";
import { RemoteSandboxPanel } from "./components/RemoteSandboxPanel";

type Tab = "pools" | "cluster";
type RebuildTarget = { poolId: string; scope: "pool" | "instance" | "user"; instanceId?: string; userId?: string };
type InstanceUpdateTarget = { instanceId: string; patch: SandboxResourcePatch };
type DeleteTarget = { kind: "pool" | "instance"; id: string; name: string };
type ClusterServerForm = {
  id: string;
  pool_id: string;
  name: string;
  base_url: string;
  workspace_root: string;
  max_sandboxes: number;
  status: string;
  transport_mode: "direct" | "tunnel";
};

const DEFAULT_SANDBOX_RESOURCES: SandboxPool["defaultResources"] = {
  cpu: 2,
  memoryMb: 512,
  diskGb: 5,
  gpuCount: 0,
  environment: {},
  volumes: [],
};

function createPoolDraft(template?: SandboxPool): SandboxPool {
  const source = template;
  return {
    id: source ? `${source.id}-copy` : "",
    organizationId: source?.organizationId ?? null,
    organizationName: null,
    name: source ? `${source.name} 副本` : "",
    providerKey: source?.providerKey ?? "opensandbox-cluster",
    image: source?.image ?? "",
    defaultResources: structuredClone(source?.defaultResources ?? DEFAULT_SANDBOX_RESOURCES),
    extra: source?.extra ? structuredClone(source.extra) : null,
    createdAt: "",
    updatedAt: "",
  };
}

function formatNameWithId(name: string, id: string): string {
  return name === id ? id : `${name}（${id}）`;
}

function toClusterServerForm(server: ClusterServer): ClusterServerForm {
  return {
    id: server.id,
    pool_id: server.poolId,
    name: server.name,
    base_url: server.baseUrl,
    workspace_root: server.workspaceRoot,
    max_sandboxes: server.maxSandboxes,
    status: server.status,
    transport_mode: server.transportMode,
  };
}

export function AdminSandboxPage() {
  const { t } = useTranslation("observer");
  const [unlocked, setUnlocked] = useState(() => getAdminKey() !== null);
  const [gateError, setGateError] = useState<string | null>(null);
  if (!unlocked) {
    return (
      <MasterKeyGate
        error={gateError}
        onUnlock={() => {
          setGateError(null);
          setUnlocked(true);
        }}
      />
    );
  }
  return (
    <SandboxDashboard
      onAuthFailure={() => {
        clearAdminKey();
        setGateError(t("login.error"));
        setUnlocked(false);
      }}
    />
  );
}

function SandboxDashboard({ onAuthFailure }: { onAuthFailure: () => void }) {
  const { t } = useTranslation("observer");
  const [tab, setTab] = useState<Tab>("pools");
  const [instanceDetail, setInstanceDetail] = useState<SandboxInstance | null>(null);
  const [instanceEditMode, setInstanceEditMode] = useState(false);
  const [providerPayload, setProviderPayload] = useState<{ id: string; payload: unknown } | null>(null);
  const [rebuildTarget, setRebuildTarget] = useState<RebuildTarget | null>(null);
  const [instanceUpdateTarget, setInstanceUpdateTarget] = useState<InstanceUpdateTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [poolForm, setPoolForm] = useState<SandboxPool | null>(null);
  const [poolFormOpen, setPoolFormOpen] = useState(false);
  const load = useRequest(
    async () => {
      const [pools, instances] = await Promise.all([systemSandboxApi.listPools(), systemSandboxApi.listInstances()]);
      return { pools, instances: instances.items };
    },
    {
      onError: (error) => {
        if (error instanceof ApiError && error.code === "UNAUTHORIZED") onAuthFailure();
      },
    },
  );
  const clusterLoad = useRequest(
    async () => {
      const [pools, servers] = await Promise.all([
        systemSandboxApi.cluster.listPools(),
        systemSandboxApi.cluster.listServers(),
      ]);
      return { pools, servers };
    },
    {
      manual: true,
      onError: (error) => {
        if (error instanceof ApiError && error.code === "UNAUTHORIZED") onAuthFailure();
      },
    },
  );
  const peopleLoad = useRequest(fetchSystemPeopleTree);
  const action = useRequest(async (fn: () => Promise<unknown>) => fn(), { manual: true });
  const instancesByPool = useMemo(() => {
    const map = new Map<string, SandboxInstance[]>();
    for (const instance of load.data?.instances ?? [])
      map.set(instance.sandboxPoolId, [...(map.get(instance.sandboxPoolId) ?? []), instance]);
    return map;
  }, [load.data?.instances]);
  const runAction = async (fn: () => Promise<unknown>, success: string): Promise<boolean> => {
    try {
      await action.runAsync(fn);
      toast.success(success);
      await load.refresh();
      return true;
    } catch (error) {
      toast.error(t("sandbox.actionError"), { description: error instanceof Error ? error.message : undefined });
      return false;
    }
  };
  const runClusterAction = async (
    fn: () => Promise<unknown>,
    success: string | ((result: unknown) => string | ClusterActionFeedback),
  ): Promise<boolean> => {
    try {
      const result = await action.runAsync(fn);
      const feedback = typeof success === "function" ? success(result) : success;
      if (typeof feedback === "string" || feedback.variant === "success")
        toast.success(typeof feedback === "string" ? feedback : feedback.message);
      else toast.error(feedback.message);
      await clusterLoad.refresh();
      return true;
    } catch (error) {
      toast.error(t("sandbox.actionError"), { description: error instanceof Error ? error.message : undefined });
      return false;
    }
  };
  const confirmRebuild = async () => {
    if (!rebuildTarget) return;
    await runAction(
      () => systemSandboxApi.rebuild(buildSandboxRebuildRequest(rebuildTarget)),
      t("sandbox.rebuildSuccess"),
    );
    setRebuildTarget(null);
  };
  const confirmInstanceUpdate = async () => {
    if (!instanceUpdateTarget) return;
    const succeeded = await runAction(
      () => systemSandboxApi.updateInstance(instanceUpdateTarget.instanceId, instanceUpdateTarget.patch),
      t("sandbox.saveSuccess"),
    );
    if (succeeded) {
      setInstanceUpdateTarget(null);
      setInstanceDetail(null);
      setInstanceEditMode(false);
    }
  };
  const requestDeletePool = (pool: SandboxPool) => setDeleteTarget({ kind: "pool", id: pool.id, name: pool.name });
  const requestDeleteInstance = (instance: SandboxInstance) =>
    setDeleteTarget({ kind: "instance", id: instance.id, name: instance.id });
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const succeeded = await runAction(
      () =>
        deleteTarget.kind === "pool"
          ? systemSandboxApi.deletePool(deleteTarget.id)
          : systemSandboxApi.deleteInstance(deleteTarget.id),
      t("sandbox.deleteSuccess"),
    );
    if (succeeded) setDeleteTarget(null);
  };
  const savePool = async (pool: SandboxPool) => {
    try {
      const rawResources: unknown = pool.defaultResources;
      const rawExtra: unknown = pool.extra;
      const parsedResources = typeof rawResources === "string" ? JSON.parse(rawResources) : rawResources;
      const parsedExtra = typeof rawExtra === "string" ? JSON.parse(rawExtra) : rawExtra;
      const body = {
        id: pool.id,
        organizationId: pool.organizationId,
        name: pool.name,
        providerKey: pool.providerKey,
        image: pool.image,
        defaultResources: parsedResources,
        extra: parsedExtra,
      };
      await runAction(
        () => (pool.createdAt ? systemSandboxApi.updatePool(pool.id, body) : systemSandboxApi.createPool(body)),
        t("sandbox.saveSuccess"),
      );
      setPoolFormOpen(false);
    } catch (error) {
      toast.error(t("sandbox.invalidJson"), { description: error instanceof Error ? error.message : undefined });
    }
  };
  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-text-primary">{t("sandbox.title")}</h1>
            <p className="text-xs text-text-muted">{t("sandbox.subtitle")}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void (tab === "pools" ? load.refresh() : clusterLoad.refresh())}
          >
            <RefreshCw className="size-3.5" />
            {t("states.refresh")}
          </Button>
        </header>
        <div className="flex gap-2 border-b border-border">
          <Button variant={tab === "pools" ? "secondary" : "ghost"} onClick={() => setTab("pools")}>
            <Database className="size-4" />
            {t("sandbox.poolsTab")}
          </Button>
          <Button
            variant={tab === "cluster" ? "secondary" : "ghost"}
            onClick={() => {
              setTab("cluster");
              if (!clusterLoad.data && !clusterLoad.loading) void clusterLoad.runAsync();
            }}
          >
            <Server className="size-4" />
            {t("sandbox.clusterTab")}
          </Button>
        </div>
        {tab === "pools" ? (
          <PoolTree
            pools={load.data?.pools ?? []}
            instancesByPool={instancesByPool}
            loading={load.loading}
            error={load.error}
            onRetry={load.refresh}
            onCreatePool={(template) => {
              setPoolForm(createPoolDraft(template ?? load.data?.pools[0]));
              setPoolFormOpen(true);
            }}
            onPoolDetail={(pool) => {
              setPoolForm(pool);
              setPoolFormOpen(true);
            }}
            onPoolDelete={requestDeletePool}
            onPoolRebuild={(poolId) => setRebuildTarget({ poolId, scope: "pool" })}
            onInstanceDetail={(instance) => {
              setInstanceDetail(instance);
              setInstanceEditMode(false);
            }}
            onProviderPayload={(instance) => setProviderPayload({ id: instance.id, payload: instance.providerPayload })}
            onInstanceDelete={requestDeleteInstance}
            onInstanceRebuild={(poolId, instanceId) => setRebuildTarget({ poolId, scope: "instance", instanceId })}
          />
        ) : (
          <ClusterPanel
            data={clusterLoad.data}
            loading={clusterLoad.loading}
            error={clusterLoad.error}
            onRefresh={() => void clusterLoad.runAsync()}
            onAction={runClusterAction}
          />
        )}
      </div>
      <PoolDialog
        open={poolFormOpen}
        pool={poolForm}
        organizations={peopleLoad.data?.organizations ?? []}
        onOpenChange={setPoolFormOpen}
        onSave={savePool}
      />
      <InstanceDetailDialog
        instance={instanceDetail}
        editMode={instanceEditMode}
        loading={action.loading}
        onOpenChange={(open) => {
          if (!open) {
            setInstanceDetail(null);
            setInstanceEditMode(false);
          }
        }}
        onSave={async (patch) => {
          if (!instanceDetail) return;
          setInstanceUpdateTarget({ instanceId: instanceDetail.id, patch });
        }}
      />
      <ProviderPayloadDialog target={providerPayload} onOpenChange={(open) => !open && setProviderPayload(null)} />
      <ConfirmDialog
        open={rebuildTarget !== null}
        onOpenChange={(open) => !open && setRebuildTarget(null)}
        title={t("sandbox.confirmRebuildTitle")}
        description={t("sandbox.confirmRebuildDescription")}
        confirmLabel={t("sandbox.rebuild")}
        variant="destructive"
        onConfirm={() => void confirmRebuild()}
        loading={action.loading}
      />
      <ConfirmDialog
        open={instanceUpdateTarget !== null}
        onOpenChange={(open) => !open && setInstanceUpdateTarget(null)}
        title={t("sandbox.confirmResourceUpdateTitle")}
        description={t("sandbox.confirmResourceUpdateDescription")}
        confirmLabel={t("sandbox.save")}
        variant="destructive"
        onConfirm={() => void confirmInstanceUpdate()}
        loading={action.loading}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t("sandbox.confirmDeleteTitle")}
        description={
          deleteTarget
            ? t("sandbox.confirmDeleteDescription", { name: deleteTarget.name })
            : t("sandbox.confirmDeleteDescription", { name: "" })
        }
        confirmLabel={t("sandbox.delete")}
        variant="destructive"
        onConfirm={() => void confirmDelete()}
        loading={action.loading}
      />
    </div>
  );
}

function PoolTree({
  pools,
  instancesByPool,
  loading,
  error,
  onRetry,
  onCreatePool,
  onPoolDetail,
  onPoolDelete,
  onPoolRebuild,
  onInstanceDetail,
  onProviderPayload,
  onInstanceDelete,
  onInstanceRebuild,
}: {
  pools: SandboxPool[];
  instancesByPool: Map<string, SandboxInstance[]>;
  loading: boolean;
  error: Error | undefined;
  onRetry: () => void;
  onCreatePool: (template?: SandboxPool) => void;
  onPoolDetail: (pool: SandboxPool) => void;
  onPoolDelete: (pool: SandboxPool) => void;
  onPoolRebuild: (id: string) => void;
  onInstanceDetail: (instance: SandboxInstance) => void;
  onProviderPayload: (instance: SandboxInstance) => void;
  onInstanceDelete: (instance: SandboxInstance) => void;
  onInstanceRebuild: (poolId: string, instanceId: string) => void;
}) {
  const { t } = useTranslation("observer");
  if (loading && pools.length === 0) return <Skeleton className="h-72 w-full" />;
  if (error && pools.length === 0)
    return (
      <Card>
        <CardContent className="space-y-3 py-8 text-center">
          <p className="text-sm text-destructive">{t("sandbox.error")}</p>
          <Button variant="outline" onClick={onRetry}>
            {t("states.retry")}
          </Button>
        </CardContent>
      </Card>
    );
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => onCreatePool()}>
          <Plus className="size-3.5" />
          {t("sandbox.createPool")}
        </Button>
      </div>
      {pools.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-text-muted">{t("sandbox.empty")}</CardContent>
        </Card>
      ) : (
        pools.map((pool) => (
          <Card key={pool.id}>
            <details open>
              <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3">
                <ChevronRight className="size-4 transition-transform open:rotate-90" />
                <Database className="size-4 text-brand" />
                <span className="font-medium">{pool.name}</span>
                <Badge variant="outline">{pool.providerKey}</Badge>
                <span className="text-xs text-text-muted">
                  {instancesByPool.get(pool.id)?.length ?? 0} {t("sandbox.instances")}
                </span>
                <span className="ml-auto flex gap-1" onClick={(event) => event.preventDefault()}>
                  <Button size="sm" variant="outline" onClick={() => onPoolDetail(pool)}>
                    {t("sandbox.detail")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onCreatePool(pool)}>
                    复制
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onPoolRebuild(pool.id)}>
                    重建
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
                    onClick={() => onPoolDelete(pool)}
                  >
                    删除
                  </Button>
                </span>
              </summary>
              <div className="overflow-x-auto border-t border-border px-4 py-2">
                <div className="min-w-[850px]">
                  {(instancesByPool.get(pool.id) ?? []).map((instance) => (
                    <InstanceRow
                      key={instance.id}
                      instance={instance}
                      onDetail={() => onInstanceDetail(instance)}
                      onProviderPayload={() => onProviderPayload(instance)}
                      onDelete={() => onInstanceDelete(instance)}
                      onRebuild={() => onInstanceRebuild(pool.id, instance.id)}
                    />
                  ))}
                </div>
              </div>
            </details>
          </Card>
        ))
      )}
    </div>
  );
}

function InstanceRow({
  instance,
  onDetail,
  onProviderPayload,
  onDelete,
  onRebuild,
}: {
  instance: SandboxInstance;
  onDetail: () => void;
  onProviderPayload: () => void;
  onDelete: () => void;
  onRebuild: () => void;
}) {
  return (
    <div className="grid grid-cols-[minmax(220px,1fr)_minmax(260px,1.2fr)_24px_auto] items-start gap-4 border-b border-border py-3 text-xs last:border-0">
      <span className="space-y-1">
        <span className="block">
          <b>实例 ID：</b>
          <span className="font-mono break-all">{instance.id}</span>
        </span>
        <span className="block">
          <b>用户：</b>
          {instance.user.name} <span className="whitespace-nowrap">（{instance.user.id}）</span>
        </span>
      </span>
      <span className="space-y-1">
        <span className="block">
          <b>Machine：</b>
          <span className="font-mono break-all">{instance.machine.id}</span>
        </span>
        <span className="block">
          <b>外部沙盒 ID：</b>
          <span className="font-mono break-all">{instance.externalSandboxId ?? "-"}</span>
        </span>
        <span className="block">
          <b>上次心跳：</b>
          {instance.lastHeartbeatAt ? new Date(instance.lastHeartbeatAt).toLocaleString() : "-"}
        </span>
      </span>
      <span className="pt-1">
        <button
          type="button"
          title={`状态：${instance.status}，点击查看 Provider Payload`}
          aria-label={`状态：${instance.status}，点击查看 Provider Payload`}
          className={`inline-block size-3 rounded-full border-0 p-0 align-middle ring-2 ring-offset-2 ${
            instance.status === "ready"
              ? "bg-emerald-500 ring-emerald-200"
              : instance.status === "error"
                ? "bg-red-500 ring-red-200"
                : instance.status === "stopped"
                  ? "bg-slate-400 ring-slate-200"
                  : "bg-amber-500 ring-amber-200"
          }`}
          onClick={onProviderPayload}
        />
      </span>
      <span className="flex min-w-[260px] flex-col items-end justify-end gap-2 self-stretch">
        <span className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onDetail}>
            详情
          </Button>
          <Button size="sm" variant="outline" onClick={onRebuild}>
            重建
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
            onClick={onDelete}
          >
            删除
          </Button>
        </span>
      </span>
    </div>
  );
}

function InstanceDetailDialog({
  instance,
  editMode,
  loading,
  onOpenChange,
  onSave,
}: {
  instance: SandboxInstance | null;
  editMode: boolean;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (patch: SandboxResourcePatch) => Promise<void>;
}) {
  const [editing, setEditing] = useState(editMode);
  const [values, setValues] = useState<Record<keyof SandboxResourcePatch, string>>({
    cpu: "",
    memoryMb: "",
    diskGb: "",
    gpuCount: "",
  });
  const [dirty, setDirty] = useState<Set<keyof SandboxResourcePatch>>(new Set());
  const open = instance !== null;
  const effectiveResources = instance?.resolvedConfig?.resources;
  const effectiveValue = useCallback(
    (key: keyof SandboxResourcePatch) => {
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
  const resources = [
    ["cpu", "CPU", "核"],
    ["memoryMb", "内存", "MB"],
    ["diskGb", "磁盘", "GB"],
    ["gpuCount", "GPU", "张"],
  ] as const;
  const patch = buildSandboxResourcePatch(
    Object.fromEntries([...dirty].map((key) => [key, values[key]])) as Record<keyof SandboxResourcePatch, string>,
  );
  return (
    <Dialog open={instance !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>实例详情 · {instance?.id}</DialogTitle>
        </DialogHeader>
        {instance ? (
          <div className="space-y-4 text-sm">
            <div className="grid gap-3">
              <div>
                <Label htmlFor="instance-detail-user">用户</Label>
                <Input
                  id="instance-detail-user"
                  readOnly
                  value={`${instance.user.name}（${instance.user.id}）`}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="instance-detail-machine">Machine</Label>
                <Input
                  id="instance-detail-machine"
                  readOnly
                  value={formatNameWithId(instance.machine.name, instance.machine.id)}
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="instance-detail-external-id">外部沙盒 ID</Label>
                <Input
                  id="instance-detail-external-id"
                  readOnly
                  value={instance.externalSandboxId ?? "-"}
                  className="mt-1 font-mono"
                />
              </div>
              <div>
                <Label htmlFor="instance-detail-status">状态</Label>
                <Input id="instance-detail-status" readOnly value={instance.status} className="mt-1" />
              </div>
            </div>
            <div>
              <Label>当前生效资源配置</Label>
              <div className="mt-2 overflow-hidden rounded border border-border">
                <div className="grid grid-cols-3 bg-muted px-3 py-2 text-xs font-medium">
                  <span>资源</span>
                  <span>当前值</span>
                  <span>当前覆盖值</span>
                </div>
                {resources.map(([key, label, unit]) => (
                  <div key={key} className="grid grid-cols-3 gap-2 border-t border-border px-3 py-2 text-xs">
                    <span>{label}</span>
                    <span>
                      {effectiveValue(key) ?? "-"} {unit}
                    </span>
                    <span>{instance.resourceOverrides?.[key] ?? "未覆盖"}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <Label>资源覆盖值</Label>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {resources.map(([key, label, unit]) => (
                  <div key={key}>
                    <Label htmlFor={`instance-resource-${key}`}>
                      {label}（{unit}）
                    </Label>
                    <Input
                      id={`instance-resource-${key}`}
                      type="number"
                      min={key === "gpuCount" ? 0 : 0.01}
                      disabled={!editing}
                      value={values[key]}
                      onChange={(event) => {
                        setValues((current) => ({ ...current, [key]: event.target.value }));
                        setDirty((current) => new Set(current).add(key));
                      }}
                    />
                    {editing && instance.resourceOverrides?.[key] !== undefined ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="mt-1 w-fit border-red-200 bg-red-50 px-2 text-xs text-red-700 hover:bg-red-100 hover:text-red-800"
                        onClick={() => {
                          setValues((current) => ({ ...current, [key]: "" }));
                          setDirty((current) => new Set(current).add(key));
                        }}
                      >
                        取消覆盖
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-text-muted">
                只会提交实际修改的资源字段；环境变量、挂载卷和连接配置不会改变。
              </p>
            </div>
            <div>
              <Label>环境变量（只读）</Label>
              <pre className="mt-1 max-h-32 max-w-full overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">
                {JSON.stringify(
                  (effectiveResources as Record<string, unknown> | undefined)?.environment ?? {},
                  null,
                  2,
                )}
              </pre>
            </div>
            <div>
              <Label>挂载卷（只读）</Label>
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
                取消
              </Button>
              <Button
                onClick={() => void onSave(patch)}
                disabled={loading || dirty.size === 0 || Object.keys(patch).length === 0}
              >
                {loading ? "提交中…" : "保存"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                关闭
              </Button>
              <Button onClick={() => setEditing(true)}>编辑</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProviderPayloadDialog({
  target,
  onOpenChange,
}: {
  target: { id: string; payload: unknown } | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Provider Payload</DialogTitle>
        </DialogHeader>
        <pre className="max-h-[65vh] max-w-full overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-4 text-xs">
          {JSON.stringify(target?.payload, null, 2)}
        </pre>
      </DialogContent>
    </Dialog>
  );
}

function OrganizationSelect({
  value,
  organizations,
  disabled = false,
  onChange,
}: {
  value: string | null;
  organizations: SystemPeopleOrganization[];
  disabled?: boolean;
  onChange: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = organizations.find((organization) => organization.id === value);
  const keyword = query.trim().toLowerCase();
  const filteredOrganizations = organizations.filter((organization) =>
    [organization.name, organization.id, organization.slug].some((field) => field.toLowerCase().includes(keyword)),
  );
  const label = selected ? `${selected.name}（${selected.id}）` : value ? `未知组织（${value}）` : "全局可用";

  if (disabled) {
    return (
      <div>
        <Label>组织</Label>
        <Input readOnly value={label} className="mt-1" />
      </div>
    );
  }

  return (
    <div>
      <Label>组织</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className="mt-1 w-full justify-between"
          >
            <span className="truncate text-left">{label}</span>
            <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
          <Command shouldFilter={false}>
            <CommandInput value={query} onValueChange={setQuery} placeholder="搜索组织名称或 ID" />
            <CommandList
              className="h-64 max-h-64 overflow-y-auto overscroll-contain"
              onWheel={(event) => event.stopPropagation()}
            >
              {filteredOrganizations.length === 0 && keyword ? <CommandEmpty>没有匹配的组织</CommandEmpty> : null}
              <CommandGroup>
                <CommandItem
                  value="__global__"
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                >
                  <Check className={`mr-2 size-4 ${value === null ? "opacity-100" : "opacity-0"}`} />
                  全局可用
                </CommandItem>
                {filteredOrganizations.map((organization) => (
                  <CommandItem
                    key={organization.id}
                    value={`${organization.name} ${organization.id} ${organization.slug}`}
                    onSelect={() => {
                      onChange(organization.id);
                      setOpen(false);
                    }}
                  >
                    <Check className={`mr-2 size-4 ${value === organization.id ? "opacity-100" : "opacity-0"}`} />
                    <span className="min-w-0">
                      <span className="block truncate">{organization.name}</span>
                      <span className="block truncate text-xs text-text-muted">{organization.id}</span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function PoolDialog({
  open,
  pool,
  organizations,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  pool: SandboxPool | null;
  organizations: SystemPeopleOrganization[];
  onOpenChange: (open: boolean) => void;
  onSave: (pool: SandboxPool) => void;
}) {
  const [value, setValue] = useState<SandboxPool | null>(pool);
  const [defaultResourcesText, setDefaultResourcesText] = useState("");
  const [extraText, setExtraText] = useState("");
  const [jsonError, setJsonError] = useState(false);
  const [editing, setEditing] = useState(!pool?.createdAt);
  useEffect(() => {
    if (open) {
      setValue(pool);
      setDefaultResourcesText(pool ? JSON.stringify(pool.defaultResources, null, 2) : "");
      setExtraText(pool?.extra ? JSON.stringify(pool.extra, null, 2) : "");
      setJsonError(false);
      setEditing(!pool?.createdAt);
    }
  }, [open, pool]);
  const isCreate = !pool?.createdAt;
  const cancelEdit = () => {
    if (isCreate) {
      onOpenChange(false);
      return;
    }
    setValue(pool);
    setDefaultResourcesText(pool ? JSON.stringify(pool.defaultResources, null, 2) : "");
    setExtraText(pool?.extra ? JSON.stringify(pool.extra, null, 2) : "");
    setJsonError(false);
    setEditing(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isCreate ? "新建资源池" : value?.name}</DialogTitle>
        </DialogHeader>
        {value ? (
          <div className="grid gap-3">
            <div>
              <Label>ID</Label>
              <Input
                value={value.id}
                readOnly={!editing || Boolean(value.createdAt)}
                onChange={(e) => setValue({ ...value, id: e.target.value })}
              />
            </div>
            <div>
              <Label>名称</Label>
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
              <Label>Provider</Label>
              <Input
                readOnly={!editing}
                value={value.providerKey}
                onChange={(e) => setValue({ ...value, providerKey: e.target.value })}
              />
            </div>
            <div>
              <Label>镜像</Label>
              <Input
                readOnly={!editing}
                value={value.image}
                onChange={(e) => setValue({ ...value, image: e.target.value })}
              />
            </div>
            <div>
              <Label>默认资源配置 JSON</Label>
              <Textarea
                value={defaultResourcesText}
                readOnly={!editing}
                onChange={(e) => {
                  const text = e.target.value;
                  setDefaultResourcesText(text);
                  try {
                    const parsed: unknown = JSON.parse(text);
                    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid JSON");
                    setValue({ ...value, defaultResources: parsed as SandboxPool["defaultResources"] });
                    setJsonError(false);
                  } catch {
                    setJsonError(true);
                  }
                }}
              />
              {jsonError ? <p className="text-xs text-destructive">JSON 格式不正确</p> : null}
            </div>
            <div>
              <Label>extra JSON</Label>
              <Textarea
                value={extraText}
                readOnly={!editing}
                onChange={(e) => {
                  const text = e.target.value;
                  setExtraText(text);
                  if (!text.trim()) {
                    setValue({ ...value, extra: null });
                    setJsonError(false);
                    return;
                  }
                  try {
                    const parsed: unknown = JSON.parse(text);
                    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid JSON");
                    setValue({ ...value, extra: parsed as Record<string, unknown> });
                    setJsonError(false);
                  } catch {
                    setJsonError(true);
                  }
                }}
              />
              {jsonError ? <p className="text-xs text-destructive">JSON 格式不正确</p> : null}
            </div>
          </div>
        ) : null}
        <DialogFooter>
          {editing ? (
            <>
              <Button variant="outline" onClick={cancelEdit}>
                取消
              </Button>
              <Button disabled={jsonError} onClick={() => value && onSave(value)}>
                保存
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                关闭
              </Button>
              <Button onClick={() => setEditing(true)}>编辑</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type ClusterActionFeedback = { message: string; variant: "success" | "error" };

function formatHealthCheckResult(result: unknown): ClusterActionFeedback {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { message: "健康检查完成：未返回状态", variant: "error" };
  }
  const payload = result as Record<string, unknown>;
  const healthStatus = payload.healthStatus;
  const lastError = payload.lastError;
  if (typeof healthStatus !== "string") return { message: "健康检查完成：未返回状态", variant: "error" };
  return {
    message:
      typeof lastError === "string" && lastError
        ? `健康检查结果：${healthStatus}（${lastError}）`
        : `健康检查结果：${healthStatus}`,
    variant: healthStatus === "healthy" ? "success" : "error",
  };
}

function ClusterPanel({
  data,
  loading,
  error,
  onRefresh,
  onAction,
}: {
  data?: { pools: ClusterPool[]; servers: ClusterServer[] };
  loading: boolean;
  error: Error | undefined;
  onRefresh: () => void;
  onAction: (
    fn: () => Promise<unknown>,
    message: string | ((result: unknown) => string | ClusterActionFeedback),
  ) => Promise<boolean>;
}) {
  const { t } = useTranslation("observer");
  const [poolForm, setPoolForm] = useState<ClusterPool | null>(null);
  const [serverForm, setServerForm] = useState<ClusterServerForm | null>(null);
  const [poolFormOpen, setPoolFormOpen] = useState(false);
  const [serverFormOpen, setServerFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ kind: "pool" | "server"; id: string; name: string } | null>(null);
  const [tunnelTarget, setTunnelTarget] = useState<ClusterServer | null>(null);
  const serversByPool = useMemo(() => {
    const grouped = new Map<string, ClusterServer[]>();
    for (const server of data?.servers ?? []) {
      grouped.set(server.poolId, [...(grouped.get(server.poolId) ?? []), server]);
    }
    return grouped;
  }, [data?.servers]);
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    await onAction(
      () =>
        deleteTarget.kind === "pool"
          ? systemSandboxApi.cluster.deletePool(deleteTarget.id)
          : systemSandboxApi.cluster.deleteServer(deleteTarget.id),
      t("sandbox.deleteSuccess"),
    );
    setDeleteTarget(null);
  };
  const confirmTunnel = async () => {
    if (!tunnelTarget) return;
    await onAction(
      () => systemSandboxApi.cluster.prepareTunnel(tunnelTarget.id),
      "Tunnel 已切换，请手动启动 Server 并建立连接",
    );
    setTunnelTarget(null);
  };
  const openServerCreate = (poolId: string) => {
    setServerForm({
      id: "",
      pool_id: poolId,
      name: "",
      base_url: "",
      workspace_root: "/workspaces",
      max_sandboxes: 10,
      status: "active",
      transport_mode: "direct",
    });
    setServerFormOpen(true);
  };
  if (loading && !data) return <Skeleton className="h-72 w-full" />;
  if (error && !data)
    return (
      <Card>
        <CardContent className="space-y-3 py-8 text-center">
          <p className="text-sm text-destructive">{t("sandbox.clusterError")}</p>
          <Button variant="outline" onClick={onRefresh}>
            {t("states.retry")}
          </Button>
        </CardContent>
      </Card>
    );
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Database className="size-4" />
            Cluster Pool
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => {
                setPoolForm({ id: "", name: "", status: "active" });
                setPoolFormOpen(true);
              }}
            >
              <Plus className="size-3.5" />
              {t("sandbox.createClusterPool")}
            </Button>
          </div>
          {data?.pools.map((pool) => {
            const servers = serversByPool.get(pool.id) ?? [];
            return (
              <details key={pool.id} open className="rounded border border-border">
                <summary className="flex cursor-pointer list-none items-center gap-3 p-3 text-sm [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="size-4 shrink-0 transition-transform [[open]>&]:rotate-90" />
                  <span className="font-medium">{pool.name}</span>
                  <span className="font-mono text-xs text-text-muted">{pool.id}</span>
                  <Badge variant="outline">{pool.status}</Badge>
                  <span className="text-xs text-text-muted">{servers.length} 个 Server</span>
                  <span className="text-xs text-text-muted">
                    沙盒：{pool.currentSandboxes ?? "-"}/{pool.capacitySandboxes ?? "-"}
                  </span>
                  <span className="ml-auto flex gap-1" onClick={(event) => event.preventDefault()}>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setPoolForm(pool);
                        setPoolFormOpen(true);
                      }}
                    >
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
                      onClick={() => setDeleteTarget({ kind: "pool", id: pool.id, name: pool.name })}
                    >
                      删除
                    </Button>
                  </span>
                </summary>
                <div className="space-y-2 border-t border-border bg-muted/20 p-3">
                  <div className="flex justify-end">
                    <Button size="sm" onClick={() => openServerCreate(pool.id)}>
                      <Plus className="size-3.5" />
                      新建 Server
                    </Button>
                  </div>
                  {servers.length === 0 ? (
                    <p className="px-2 py-3 text-xs text-text-muted">该 Pool 下暂无 Server</p>
                  ) : (
                    servers.map((server) => (
                      <ClusterServerRow
                        key={server.id}
                        server={server}
                        onEdit={() => {
                          setServerForm(toClusterServerForm(server));
                          setServerFormOpen(true);
                        }}
                        onHealthCheck={() =>
                          void onAction(() => systemSandboxApi.cluster.healthCheck(server.id), formatHealthCheckResult)
                        }
                        onPrepareTunnel={() => setTunnelTarget(server)}
                        onDownload={async () => {
                          const content = await systemSandboxApi.cluster.downloadTunnelConfig(server.id);
                          const url = URL.createObjectURL(new Blob([content], { type: "application/toml" }));
                          const anchor = document.createElement("a");
                          anchor.href = url;
                          anchor.download = `${server.id}.frpc.toml`;
                          anchor.click();
                          URL.revokeObjectURL(url);
                        }}
                        onDelete={() => setDeleteTarget({ kind: "server", id: server.id, name: server.name })}
                      />
                    ))
                  )}
                </div>
              </details>
            );
          })}
        </CardContent>
      </Card>
      <ClusterPoolDialog
        open={poolFormOpen}
        pool={poolForm}
        onOpenChange={setPoolFormOpen}
        onSave={async (pool) => {
          await onAction(
            () =>
              poolForm?.id
                ? systemSandboxApi.cluster.updatePool(poolForm.id, { name: pool.name, status: pool.status })
                : systemSandboxApi.cluster.createPool(pool),
            t("sandbox.saveSuccess"),
          );
          setPoolFormOpen(false);
        }}
      />
      <ClusterServerDialog
        open={serverFormOpen}
        server={serverForm}
        onOpenChange={setServerFormOpen}
        onSave={async (server, apiKey) => {
          const body = { ...server, ...(apiKey ? { api_key: apiKey } : {}) };
          delete (body as Record<string, unknown>).id;
          await onAction(
            () =>
              serverForm?.id
                ? systemSandboxApi.cluster.updateServer(serverForm.id, body)
                : systemSandboxApi.cluster.createServer({ ...body, id: server.id, api_key: apiKey }),
            t("sandbox.saveSuccess"),
          );
          setServerFormOpen(false);
        }}
      />
      <ConfirmDialog
        open={tunnelTarget !== null}
        onOpenChange={(open) => !open && setTunnelTarget(null)}
        title="切换 Tunnel"
        description={
          tunnelTarget
            ? `切换 ${tunnelTarget.name} 到 Tunnel 会导致整个 Server 停止服务，直到你手动以 Tunnel 方式启动并建立连接。确定继续吗？`
            : "切换 Tunnel 会导致整个 Server 停止服务，直到手动启动并建立连接。"
        }
        confirmLabel="切换 Tunnel"
        variant="destructive"
        onConfirm={() => void confirmTunnel()}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={t("sandbox.confirmDeleteTitle")}
        description={
          deleteTarget
            ? t("sandbox.confirmDeleteDescription", { name: deleteTarget.name })
            : t("sandbox.confirmDeleteDescription", { name: "" })
        }
        confirmLabel={t("sandbox.delete")}
        variant="destructive"
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}

function ClusterServerRow({
  server,
  onEdit,
  onHealthCheck,
  onPrepareTunnel,
  onDownload,
  onDelete,
}: {
  server: ClusterServer;
  onEdit: () => void;
  onHealthCheck: () => void;
  onPrepareTunnel: () => void;
  onDownload: () => Promise<void>;
  onDelete: () => void;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 rounded border border-border bg-background p-3 text-xs">
        <Server className="size-3.5 shrink-0 text-text-muted" />
        <span className="font-medium">{server.name}</span>
        <span className="font-mono text-text-muted">{server.id}</span>
        <Badge variant="outline">{server.transportMode}</Badge>
        <Badge variant={server.status === "online" ? "secondary" : "destructive"}>{server.status}</Badge>
        <Badge
          variant={server.healthStatus === "unhealthy" ? "destructive" : "outline"}
          className={server.healthStatus === "healthy" ? "border-green-200 bg-green-50 text-green-700" : undefined}
        >
          {server.healthStatus}
        </Badge>
        <span className="text-text-muted">
          沙盒：{server.currentSandboxes}/{server.maxSandboxes}
        </span>
        <span className="ml-auto flex flex-wrap justify-end gap-1">
          <Button size="sm" variant="outline" onClick={onEdit}>
            编辑
          </Button>
          <Button size="sm" variant="outline" onClick={onHealthCheck}>
            健康检查
          </Button>
          <Button size="sm" variant="outline" onClick={onPrepareTunnel}>
            切换 Tunnel
          </Button>
          {server.transportMode === "tunnel" ? (
            <Button size="sm" variant="outline" onClick={() => void onDownload()}>
              Tunnel 配置
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            className="border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
            onClick={onDelete}
          >
            删除
          </Button>
        </span>
      </div>
      <RemoteSandboxPanel server={server} />
    </div>
  );
}

function ClusterPoolDialog({
  open,
  pool,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  pool: ClusterPool | null;
  onOpenChange: (open: boolean) => void;
  onSave: (pool: ClusterPool) => Promise<void>;
}) {
  const { t } = useTranslation("observer");
  const [value, setValue] = useState<ClusterPool | null>(pool);
  useEffect(() => {
    if (open) setValue(pool);
  }, [open, pool]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{pool?.id ? t("sandbox.editClusterPool") : t("sandbox.createClusterPool")}</DialogTitle>
        </DialogHeader>
        {value ? (
          <div className="space-y-3">
            <div>
              <Label>ID</Label>
              <Input
                value={value.id}
                disabled={Boolean(pool?.id)}
                onChange={(e) => setValue({ ...value, id: e.target.value })}
              />
            </div>
            <div>
              <Label>{t("sandbox.name")}</Label>
              <Input value={value.name} onChange={(e) => setValue({ ...value, name: e.target.value })} />
            </div>
            <div>
              <Label>{t("sandbox.status")}</Label>
              <Input value={value.status} onChange={(e) => setValue({ ...value, status: e.target.value })} />
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("sandbox.cancel")}
          </Button>
          <Button disabled={!value?.id || !value.name} onClick={() => value && void onSave(value)}>
            {t("sandbox.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ClusterServerDialog({
  open,
  server,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  server: ClusterServerForm | null;
  onOpenChange: (open: boolean) => void;
  onSave: (server: ClusterServerForm, apiKey: string) => Promise<void>;
}) {
  const { t } = useTranslation("observer");
  const [value, setValue] = useState<ClusterServerForm | null>(server);
  const [apiKey, setApiKey] = useState("");
  useEffect(() => {
    if (open) {
      setValue(server);
      setApiKey("");
    }
  }, [open, server]);
  const update = (patch: Partial<ClusterServerForm>) => value && setValue({ ...value, ...patch });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{server?.id ? t("sandbox.editClusterServer") : t("sandbox.createClusterServer")}</DialogTitle>
        </DialogHeader>
        {value ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>ID</Label>
              <Input value={value.id} disabled={Boolean(server?.id)} onChange={(e) => update({ id: e.target.value })} />
            </div>
            <div>
              <Label>{t("sandbox.name")}</Label>
              <Input value={value.name} onChange={(e) => update({ name: e.target.value })} />
            </div>
            <div>
              <Label>Pool ID</Label>
              <Input value={value.pool_id} onChange={(e) => update({ pool_id: e.target.value })} />
            </div>
            <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
              <div>
                <Label>Transport mode</Label>
                <Select
                  value={value.transport_mode}
                  onValueChange={(transportMode: ClusterServerForm["transport_mode"]) =>
                    update({ transport_mode: transportMode })
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="direct">direct</SelectItem>
                    <SelectItem value="tunnel">tunnel</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Base URL</Label>
                <Input
                  value={value.base_url}
                  disabled={value.transport_mode === "tunnel"}
                  placeholder={value.transport_mode === "tunnel" ? "Tunnel 模式不需要 Base URL" : undefined}
                  onChange={(e) => update({ base_url: e.target.value })}
                />
              </div>
            </div>
            <div>
              <Label>Workspace root</Label>
              <Input value={value.workspace_root} onChange={(e) => update({ workspace_root: e.target.value })} />
            </div>
            <div>
              <Label>Max sandboxes</Label>
              <Input
                type="number"
                min="1"
                value={value.max_sandboxes}
                onChange={(e) => update({ max_sandboxes: Number(e.target.value) })}
              />
            </div>
            <div>
              <Label>{t("sandbox.status")}</Label>
              <Select value={value.status} onValueChange={(status) => update({ status })}>
                <SelectTrigger className="w-full">
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
              <Label>API key{server?.id ? "（留空则保持不变）" : ""}</Label>
              <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("sandbox.cancel")}
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
            {t("sandbox.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
