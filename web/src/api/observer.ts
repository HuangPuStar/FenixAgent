// web/src/api/observer.ts
// Observer 观察中心 API 建模层（docs/arch/21 §4/§5）。
// 仅只读快照拉取：系统 master key 从 sessionStorage 读入（admin-key helper），
// 经 request.ts 的可选 bearerToken 注入 Authorization 头；401 由页面层清 key 回门。
//
// 类型对齐后端 schema src/schemas/api-system-observer.schema.ts（data.trees 骨架）。

import { getAdminKey } from "../lib/admin-key";
import { request, unwrap } from "./request";

/** 叶子对象行（归属树内；payload 概要承载 openTime/session 等）。 */
export interface ObserverLeaf {
  id: string;
  source: string;
  machineId: string | null;
  payload?: Record<string, unknown>;
}

export interface ObserverInstanceNode {
  instanceId: string;
  leafCount: number;
  leaves: ObserverLeaf[];
}

export interface ObserverAgentNode {
  agentConfigId: string;
  instanceCount: number;
  leafCount: number;
  children: ObserverInstanceNode[];
  /** 无 instanceId 归属的叶子（如本地 acp-link），直接挂在智能体节点 */
  leaves?: ObserverLeaf[];
}

export interface ObserverUserNode {
  userId: string;
  agentCount: number;
  leafCount: number;
  children: ObserverAgentNode[];
}

export interface ObserverOrgNode {
  organizationId: string;
  userCount: number;
  agentCount: number;
  instanceCount: number;
  leafCount: number;
  children: ObserverUserNode[];
}

/** machine 树叶子（roleId 恒等于 machineId，文档 §4 命名）。 */
export interface ObserverMachineTreeLeaf {
  id: string;
  source: string;
  roleId: string;
}

export interface ObserverMachineTree {
  machineId: string;
  count: number;
  leaves: ObserverMachineTreeLeaf[];
}

export interface ObserverIntegritySummary {
  checked: number;
  mismatched: number;
  mismatchedItems: { kind: string; id: string }[];
}

/** 各角色 id → 可读名称字典（name(id) 展示用；缺失 id 不在字典，回退显示原始 id）。 */
export interface ObserverNames {
  organizationId: Record<string, string>;
  userId: Record<string, string>;
  agentConfigId: Record<string, string>;
  instanceId: Record<string, string>;
  machineId: Record<string, string>;
}

/** acp-link 观察视图（data 形状）。 */
export interface AcpLinkSnapshot {
  generatedAt: string;
  kind: "acp-link";
  total: number;
  trees: { byEntity: ObserverMachineTree[]; byOrg: ObserverOrgNode[] };
  integrity: ObserverIntegritySummary;
  names: ObserverNames;
}

/** 拉取 acp-link 观察视图（GET /api/system/observer/acp-link，Bearer master key）。 */
export function fetchAcpLinkSnapshot(): Promise<AcpLinkSnapshot> {
  return unwrap(request<AcpLinkSnapshot>("/api/system/observer/acp-link", { bearerToken: getAdminKey() ?? undefined }));
}
