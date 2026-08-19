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

// ────────────────────────────────────────────
// chat-relay（YJS）连接统计（docs/arch/21 §6 排查辅助）
// ────────────────────────────────────────────

/** chat-relay 叶子 payload 收窄后的连接统计概要。 */
export interface ChatRelayStatsPayload {
  openTime?: number;
  rcsSessionId?: string;
  acpSessionId?: string;
}

/**
 * 从叶子 payload 安全收窄出 chat-relay 连接概要；非 chat-relay 或无 payload 返回 null。
 * payload 是 Record<string, unknown>，这里逐字段类型收窄，避免 as any（CLAUDE.md）。
 */
export function chatRelayPayload(leaf: ObserverLeaf): ChatRelayStatsPayload | null {
  if (leaf.source !== "chat-relay" || !leaf.payload) return null;
  const p = leaf.payload;
  return {
    ...(typeof p.openTime === "number" ? { openTime: p.openTime } : {}),
    ...(typeof p.rcsSessionId === "string" ? { rcsSessionId: p.rcsSessionId } : {}),
    ...(typeof p.acpSessionId === "string" ? { acpSessionId: p.acpSessionId } : {}),
  };
}

export type DurationUnit = "second" | "minute" | "hour" | "day";

/**
 * 时长（ms）→ 展示粒度。向上取整到分钟/小时/天；单位文案由组件按 i18n 本地化。
 */
export function formatDuration(ms: number): { value: number; unit: DurationUnit } {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return { value: seconds, unit: "second" };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { value: minutes, unit: "minute" };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: hours, unit: "hour" };
  return { value: Math.floor(hours / 24), unit: "day" };
}

/** epoch ms → 本地时钟 HH:mm:ss（连接打开时间展示）。 */
export function formatClockTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 同会话多标签页计数：按 rcsSessionId 分组统计 chat-relay 叶子数。
 * 用于区分「同一会话开多个标签页」（正常）与「陈旧残留连接」（同实例却不同会话/无会话）。
 */
export function sessionTabCounts(orgs: ObserverOrgNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (leaf: ObserverLeaf) => {
    const info = chatRelayPayload(leaf);
    if (!info?.rcsSessionId) return;
    counts.set(info.rcsSessionId, (counts.get(info.rcsSessionId) ?? 0) + 1);
  };
  for (const org of orgs) {
    for (const user of org.children) {
      for (const agent of user.children) {
        for (const inst of agent.children) {
          for (const leaf of inst.leaves) visit(leaf);
        }
        for (const leaf of agent.leaves ?? []) visit(leaf);
      }
    }
  }
  return counts;
}

/** 单个 Y.Doc 会话（同一 rcsSessionId 的 chat-relay 链接集合）。 */
export interface YjsSessionGroup {
  rcsSessionId: string;
  /** 该会话下的链接（同一实例内；无 rcsSessionId 的非 chat-relay 链接不属于任何会话） */
  leaves: ObserverLeaf[];
}

/**
 * 把实例下的链接按 rcsSessionId 分组为 Y.Doc 会话层。
 * chat-relay 链接从 payload 收窄 rcsSessionId；acp-ws / external-relay 等无会话链接
 * 归入 ungrouped，仍直接挂在实例层下（Y.Doc 实例只有一个、链接可以有多个的展示语义）。
 */
export function groupYjsSessions(leaves: ObserverLeaf[]): { sessions: YjsSessionGroup[]; ungrouped: ObserverLeaf[] } {
  const sessionsBySession = new Map<string, ObserverLeaf[]>();
  const ungrouped: ObserverLeaf[] = [];
  for (const leaf of leaves) {
    const info = chatRelayPayload(leaf);
    if (info?.rcsSessionId) {
      const list = sessionsBySession.get(info.rcsSessionId) ?? [];
      list.push(leaf);
      sessionsBySession.set(info.rcsSessionId, list);
    } else {
      ungrouped.push(leaf);
    }
  }
  const sessions = [...sessionsBySession.entries()]
    .map(([rcsSessionId, sessionLeaves]) => ({ rcsSessionId, leaves: sessionLeaves }))
    .sort((a, b) => a.rcsSessionId.localeCompare(b.rcsSessionId));
  return { sessions, ungrouped };
}
