// web/src/pages/admin/use-sandbox-dashboard.ts
// 沙盒管理页的状态与动作编排 hook（从原 AdminSandboxPage.tsx 的 SandboxDashboard 拆出）。
//
// 拆出的理由：数据加载、动作执行与「待确认目标」三类状态原本与 JSX 混在同一个 1529 行文件里，
// 组件难以单独审阅。hook 只承担状态与请求编排，渲染与可访问性语义留在组件层。
//
// 鉴权失败（401/403）统一在这里处理：request 层把两者都归一为 UNAUTHORIZED，
// 页面拿到后清 key 并回 Master Key 门，因此各子组件不需要重复判断。

import { ApiError } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { SANDBOX_NS } from "../../../i18n/namespace";
import { fetchSystemOrganizations } from "../../api/system-organizations";
import {
  buildSandboxRebuildRequest,
  type SandboxInstance,
  type SandboxPool,
  type SandboxResourcePatch,
  systemSandboxApi,
} from "../../api/system-sandbox";
import type {
  ClusterActionFeedback,
  DeleteTarget,
  InstanceUpdateTarget,
  RebuildTarget,
  Tab,
} from "./sandbox-admin-types";
import { createPoolDraft } from "./sandbox-admin-utils";

export function useSandboxDashboard(onAuthFailure: () => void) {
  const { t } = useTranslation(SANDBOX_NS);
  const [tab, setTab] = useState<Tab>("pools");
  const [instanceDetail, setInstanceDetail] = useState<SandboxInstance | null>(null);
  const [instanceEditMode, setInstanceEditMode] = useState(false);
  const [providerPayload, setProviderPayload] = useState<{ id: string; payload: unknown } | null>(null);
  const [rebuildTarget, setRebuildTarget] = useState<RebuildTarget | null>(null);
  const [instanceUpdateTarget, setInstanceUpdateTarget] = useState<InstanceUpdateTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [poolForm, setPoolForm] = useState<SandboxPool | null>(null);
  const [poolFormOpen, setPoolFormOpen] = useState(false);

  const handleAuthError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.code === "UNAUTHORIZED") onAuthFailure();
    },
    [onAuthFailure],
  );

  const load = useRequest(
    async () => {
      const [pools, instances] = await Promise.all([systemSandboxApi.listPools(), systemSandboxApi.listInstances()]);
      return { pools, instances: instances.items };
    },
    { onError: handleAuthError },
  );
  const clusterLoad = useRequest(
    async () => {
      const [pools, servers] = await Promise.all([
        systemSandboxApi.cluster.listPools(),
        systemSandboxApi.cluster.listServers(),
      ]);
      return { pools, servers };
    },
    { manual: true, onError: handleAuthError },
  );
  // 组织目录是资源池表单的下拉候选，进页面即预取（失败只影响下拉，不阻塞池列表）。
  const organizationsLoad = useRequest(fetchSystemOrganizations);
  const action = useRequest(async (fn: () => Promise<unknown>) => fn(), { manual: true });

  const instancesByPool = useMemo(() => {
    const map = new Map<string, SandboxInstance[]>();
    for (const instance of load.data?.instances ?? [])
      map.set(instance.sandboxPoolId, [...(map.get(instance.sandboxPoolId) ?? []), instance]);
    return map;
  }, [load.data?.instances]);

  /** 执行池/实例动作：成功后提示并刷新列表，失败提示错误详情（诊断上下文进 description）。 */
  const runAction = async (fn: () => Promise<unknown>, success: string): Promise<boolean> => {
    try {
      await action.runAsync(fn);
      toast.success(success);
      await load.refresh();
      return true;
    } catch (error) {
      // 上屏只给字典文案（§9.3）：`error.message` 是 `unwrap` 抛出的 `ApiError.message`（后端信封
      // 原文），原先塞进 toast 的 description，与直接回显等价；原始对象只进这里。
      console.error(t("actionError"), error);
      toast.error(t("actionError"));
      return false;
    }
  };

  /** 执行 Cluster 动作：成功文案可由结果推导（如健康检查结果）；variant=error 反映为错误 toast。 */
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
      // 上屏只给字典文案（§9.3）：`error.message` 是 `unwrap` 抛出的 `ApiError.message`（后端信封
      // 原文），原先塞进 toast 的 description，与直接回显等价；原始对象只进这里。
      console.error(t("actionError"), error);
      toast.error(t("actionError"));
      return false;
    }
  };

  const openCreatePool = (template?: SandboxPool) => {
    setPoolForm(createPoolDraft(template ?? load.data?.pools[0], t("copyNameSuffix")));
    setPoolFormOpen(true);
  };
  const openPoolDetail = (pool: SandboxPool) => {
    setPoolForm(pool);
    setPoolFormOpen(true);
  };
  const openInstanceDetail = (instance: SandboxInstance) => {
    setInstanceDetail(instance);
    setInstanceEditMode(false);
  };
  const closeInstanceDetail = () => {
    setInstanceDetail(null);
    setInstanceEditMode(false);
  };

  /**
   * 保存资源池（新建或更新）。
   *
   * 表单里的 JSON 字段以文本编辑，提交前解析；解析失败提示 invalidJson 并保留对话框，
   * 不发请求。`createdAt` 为空即视为新建（后端创建后才回填时间戳）。
   */
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
        t("saveSuccess"),
      );
      setPoolFormOpen(false);
    } catch (error) {
      // 这里的 `error` 是本地 JSON.parse 的异常，但同一条 toast 也接 `createPool/updatePool` 的信封
      // 异常，无法逐条分流，故一律只上屏「配置 JSON 格式不正确」（§9.3）；原文进日志。
      console.error(t("invalidJson"), error);
      toast.error(t("invalidJson"));
    }
  };

  const confirmRebuild = async () => {
    if (!rebuildTarget) return;
    await runAction(() => systemSandboxApi.rebuild(buildSandboxRebuildRequest(rebuildTarget)), t("rebuildSuccess"));
    setRebuildTarget(null);
  };

  const confirmInstanceUpdate = async () => {
    if (!instanceUpdateTarget) return;
    const succeeded = await runAction(
      () => systemSandboxApi.updateInstance(instanceUpdateTarget.instanceId, instanceUpdateTarget.patch),
      t("saveSuccess"),
    );
    if (succeeded) {
      setInstanceUpdateTarget(null);
      setInstanceDetail(null);
      setInstanceEditMode(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const succeeded = await runAction(
      () =>
        deleteTarget.kind === "pool"
          ? systemSandboxApi.deletePool(deleteTarget.id)
          : systemSandboxApi.deleteInstance(deleteTarget.id),
      t("deleteSuccess"),
    );
    if (succeeded) setDeleteTarget(null);
  };

  return {
    t,
    tab,
    setTab,
    pools: load.data?.pools ?? [],
    instancesByPool,
    poolsLoading: load.loading,
    poolsError: load.error,
    refreshPools: load.refresh,
    clusterData: clusterLoad.data,
    clusterLoading: clusterLoad.loading,
    clusterError: clusterLoad.error,
    refreshCluster: clusterLoad.refresh,
    ensureClusterLoaded: () => {
      if (!clusterLoad.data && !clusterLoad.loading) void clusterLoad.runAsync();
    },
    organizations: organizationsLoad.data ?? [],
    actionLoading: action.loading,
    runClusterAction,
    instanceDetail,
    instanceEditMode,
    setInstanceEditMode,
    openInstanceDetail,
    closeInstanceDetail,
    providerPayload,
    openProviderPayload: (instance: SandboxInstance) =>
      setProviderPayload({ id: instance.id, payload: instance.providerPayload }),
    closeProviderPayload: () => setProviderPayload(null),
    poolForm,
    poolFormOpen,
    closePoolForm: () => setPoolFormOpen(false),
    openCreatePool,
    openPoolDetail,
    savePool,
    rebuildTarget,
    requestPoolRebuild: (poolId: string) => setRebuildTarget({ poolId, scope: "pool" }),
    requestInstanceRebuild: (poolId: string, instanceId: string) =>
      setRebuildTarget({ poolId, scope: "instance", instanceId }),
    closeRebuild: () => setRebuildTarget(null),
    confirmRebuild,
    instanceUpdateTarget,
    requestInstanceUpdate: (instanceId: string, patch: SandboxResourcePatch) =>
      setInstanceUpdateTarget({ instanceId, patch }),
    closeInstanceUpdate: () => setInstanceUpdateTarget(null),
    confirmInstanceUpdate,
    deleteTarget,
    // 删除目标的展示名：池用池名，实例用实例 id（实例没有独立名称）。
    requestPoolDelete: (pool: SandboxPool) => setDeleteTarget({ kind: "pool", id: pool.id, name: pool.name }),
    requestInstanceDelete: (instance: SandboxInstance) =>
      setDeleteTarget({ kind: "instance", id: instance.id, name: instance.id }),
    closeDelete: () => setDeleteTarget(null),
    confirmDelete,
  };
}

export type SandboxDashboardState = ReturnType<typeof useSandboxDashboard>;
