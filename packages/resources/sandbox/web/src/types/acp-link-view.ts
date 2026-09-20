// web/src/types/acp-link-view.ts
// Observer 观察视图（acp-link 快照）在 sandbox 包内的结构镜像。
//
// 用途：`web/src/pages/admin/utils.ts` 的纯函数（平坦表合并、machine 反查、Y.Doc 会话分组）是
// observer 页面经 `@fenix/resource-sandbox/web` 复用的视图助手，其入参是 observer 的视图模型。
//
// 为什么不直接引用真实类型：类型定义在 `packages/resources/observer/web/api/observer.ts`。observer
// 今天已登记 `./web` 出口（`observer/web/index.ts` 的 `export * from "./api/observer"`），可经包根
// 入口取到而不必走被架构门禁禁止的 `src/**` 深链；真正阻止合并的是**包级环**——observer → sandbox
// 已是既有依赖方向，反向 import 会让两个包互相依赖，依赖矩阵不允许。
//
// 这里只声明被真实读取的字段（结构子集）：完整的 observer 类型可以赋值给这些子集类型，
// 因此 observer 侧调用不受影响；反向不成立，sandbox 拿不到未声明的字段。字段语义与
// observer 的同名类型逐字对齐，漂移会让两侧编译都不报错但在运行期读到 undefined——
// 修改任一形状时必须同步改两处（移除条件：W4 把本文件与 `web/src/pages/admin/utils.ts` 并入 observer
// 并改指 `web/api/observer.ts` 的真实类型——它是跨两个包的迁移，本包切片不动）。

/** 叶子对象行（归属树内；payload 概要承载 openTime / session 等）。 */
export interface AcpLinkViewLeaf {
  id: string;
  source: string;
  machineId: string | null;
  payload?: Record<string, unknown>;
}

export interface AcpLinkViewInstanceNode {
  instanceId: string;
  leaves: AcpLinkViewLeaf[];
}

export interface AcpLinkViewAgentNode {
  agentConfigId: string;
  children: AcpLinkViewInstanceNode[];
  /** 无 instanceId 归属的叶子（如本地 acp-link），直接挂在智能体节点 */
  leaves?: AcpLinkViewLeaf[];
}

export interface AcpLinkViewUserNode {
  userId: string;
  children: AcpLinkViewAgentNode[];
}

export interface AcpLinkViewOrgNode {
  organizationId: string;
  children: AcpLinkViewUserNode[];
}

/** machine 树叶子（roleId 恒等于 machineId）。 */
export interface AcpLinkViewMachineTreeLeaf {
  id: string;
  source: string;
}

export interface AcpLinkViewMachineTree {
  machineId: string;
  leaves: AcpLinkViewMachineTreeLeaf[];
}

/** 各角色 id → 可读名称字典（缺失 id 回退显示原始 id）。 */
export interface AcpLinkViewNames {
  organizationId: Record<string, string>;
  userId: Record<string, string>;
  agentConfigId: Record<string, string>;
  instanceId: Record<string, string>;
  machineId: Record<string, string>;
}

/** acp-link 观察视图（data 形状）。 */
export interface AcpLinkViewSnapshot {
  trees: { byEntity: AcpLinkViewMachineTree[]; byOrg: AcpLinkViewOrgNode[] };
  integrity: { mismatchedItems: { kind: string; id: string }[] };
  names: AcpLinkViewNames;
}
