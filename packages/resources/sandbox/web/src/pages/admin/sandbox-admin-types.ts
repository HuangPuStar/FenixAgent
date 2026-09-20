// web/src/pages/admin/sandbox-admin-types.ts
// 沙盒管理页的视图层类型与常量。
//
// 从原 AdminSandboxPage.tsx 拆出（该文件 1529 行，超过「单文件 500 行」红线）：
// 类型是页面、子组件与 hook 三方共用的最小面，放在独立模块避免组件之间互相 import
// 造成隐式耦合（拆分的部分职责见各 component 文件头注释）。

import type { SandboxPool, SandboxResourcePatch } from "../../api/system-sandbox";

/** 面板分区：资源池（按池查看实例）与 Cluster 基础设施。 */
export type Tab = "pools" | "cluster";

/** 待确认的重建目标；scope 决定重建范围（池 / 实例 / 用户）。 */
export type RebuildTarget = {
  poolId: string;
  scope: "pool" | "instance" | "user";
  instanceId?: string;
  userId?: string;
};

/** 已确认待提交的资源覆盖值（对话框提交后进入二次确认）。 */
export type InstanceUpdateTarget = { instanceId: string; patch: SandboxResourcePatch };

/** 待确认的删除目标（池与实例共用一套确认对话框）。 */
export type DeleteTarget = { kind: "pool" | "instance"; id: string; name: string };

/** Cluster Server 表单（API 字段名为 snake_case，表单沿用以免提交时二次映射）。 */
export type ClusterServerForm = {
  id: string;
  pool_id: string;
  name: string;
  base_url: string;
  workspace_root: string;
  max_sandboxes: number;
  status: string;
  transport_mode: "direct" | "tunnel";
};

/** Cluster 动作反馈：message 已由调用方 t() 取值，variant 决定 toast 类型。 */
export type ClusterActionFeedback = { message: string; variant: "success" | "error" };

/** 新建资源池时的默认资源配置（后端字段缺省时与 provider 侧的默认保持一致）。 */
export const DEFAULT_SANDBOX_RESOURCES: SandboxPool["defaultResources"] = {
  cpu: 2,
  memoryMb: 512,
  diskGb: 5,
  gpuCount: 0,
  environment: {},
  volumes: [],
};
