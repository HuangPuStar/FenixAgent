// web/src/pages/admin/utils.ts
// Observer 面板纯函数（可单测）：平坦表合并、machine 拓扑反查、integrity 归纳。
//
// 合并规则（计划 D13）：平坦表由叶子推导，不新增 API 字段——
// byOrg 叶子（递归携带 org/user/agent/instance 上下文）与 byEntity 叶子
// （roleId → machineId）按 id 去重；byOrg 叶子携带 payload(openTime)，
// byEntity 侧缺失时用 byOrg 值补齐。

import type { AcpLinkSnapshot, ObserverLeaf, ObserverOrgNode } from "../../api/observer";

/** 平坦表行（各角色 id 可缺省为 null；openTime 取自 LeafView.payload）。 */
export interface FlatRow {
  id: string;
  source: string;
  organizationId: string | null;
  userId: string | null;
  agentConfigId: string | null;
  instanceId: string | null;
  machineId: string | null;
  openTime?: number;
}

/** 由 byOrg 上下文 + 叶子构造平坦行。 */
function leafToRow(
  leaf: ObserverLeaf,
  ctx: {
    organizationId: string | null;
    userId: string | null;
    agentConfigId: string | null;
    instanceId: string | null;
  },
): FlatRow {
  const openTime = leaf.payload?.openTime;
  return {
    id: leaf.id,
    source: leaf.source,
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    agentConfigId: ctx.agentConfigId,
    instanceId: ctx.instanceId,
    machineId: leaf.machineId,
    ...(typeof openTime === "number" ? { openTime } : {}),
  };
}

/** 全部观察平坦表：byOrg + byEntity 叶子按 id 去重，openTime 缺失侧用 byOrg 值补齐。 */
export function mergeFlatRows(view: AcpLinkSnapshot): FlatRow[] {
  const rows = new Map<string, FlatRow>();
  const add = (row: FlatRow) => {
    const existing = rows.get(row.id);
    if (!existing) {
      rows.set(row.id, row);
      return;
    }
    // byOrg 叶子携带完整归属上下文（org/user/agent/instance + payload openTime），
    // 是权威来源：合并时以其为准，仅用 byEntity 行补齐既有缺失的字段
    // （如仅 machine 树可见的叶子由 byEntity 提供 machineId）。
    rows.set(row.id, {
      ...row,
      organizationId: existing.organizationId ?? row.organizationId,
      userId: existing.userId ?? row.userId,
      agentConfigId: existing.agentConfigId ?? row.agentConfigId,
      instanceId: existing.instanceId ?? row.instanceId,
      machineId: existing.machineId ?? row.machineId,
      openTime: existing.openTime ?? row.openTime,
    });
  };

  const walkOrg = (org: ObserverOrgNode) => {
    for (const user of org.children) {
      for (const agent of user.children) {
        for (const instance of agent.children) {
          for (const leaf of instance.leaves) {
            add(
              leafToRow(leaf, {
                organizationId: org.organizationId,
                userId: user.userId,
                agentConfigId: agent.agentConfigId,
                instanceId: instance.instanceId,
              }),
            );
          }
        }
        for (const leaf of agent.leaves ?? []) {
          add(
            leafToRow(leaf, {
              organizationId: org.organizationId,
              userId: user.userId,
              agentConfigId: agent.agentConfigId,
              instanceId: null,
            }),
          );
        }
      }
    }
  };
  for (const org of view.trees.byOrg) walkOrg(org);

  // byEntity 叶子：无 org 的观察（如 machine）只出现在 machine 树
  for (const machine of view.trees.byEntity) {
    for (const leaf of machine.leaves) {
      add({
        id: leaf.id,
        source: leaf.source,
        organizationId: null,
        userId: null,
        agentConfigId: null,
        instanceId: null,
        machineId: machine.machineId,
      });
    }
  }

  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** 拓扑反查索引：machineId → 其承载的全部 leaf id（归属树 + machine 树合并去重）。 */
export function machineReverseIndex(view: AcpLinkSnapshot): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const push = (machineId: string, leafId: string) => {
    const list = index.get(machineId) ?? [];
    if (!list.includes(leafId)) {
      list.push(leafId);
      index.set(machineId, list);
    }
  };

  const walkOrg = (org: ObserverOrgNode) => {
    for (const user of org.children) {
      for (const agent of user.children) {
        for (const instance of agent.children) {
          for (const leaf of instance.leaves) {
            if (leaf.machineId) push(leaf.machineId, leaf.id);
          }
        }
        for (const leaf of agent.leaves ?? []) {
          if (leaf.machineId) push(leaf.machineId, leaf.id);
        }
      }
    }
  };
  for (const org of view.trees.byOrg) walkOrg(org);
  for (const machine of view.trees.byEntity) {
    for (const leaf of machine.leaves) push(machine.machineId, leaf.id);
  }
  return index;
}

/** integrity 展示行（mismatchedItems 直出，仅含 kind+id）。 */
export interface IntegrityRow {
  kind: string;
  id: string;
}

/** integrity 归纳：把 mismatchedItems 映射为告警区展示行。 */
export function integrityRows(view: AcpLinkSnapshot): IntegrityRow[] {
  return view.integrity.mismatchedItems.map((item) => ({ kind: item.kind, id: item.id }));
}

/**
 * name(id) 展示助手：按角色查 names 字典得到可读名称，缺失回退原始 id。
 * 返回空串表示该角色无值（如 machine 树里无 org 归属的叶子），调用方展示占位符。
 */
export function name(names: AcpLinkSnapshot["names"], role: keyof AcpLinkSnapshot["names"], id: string | null): string {
  if (!id) return "";
  return names[role][id] ?? id;
}
