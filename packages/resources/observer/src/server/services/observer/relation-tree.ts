// src/services/observer/relation-tree.ts
// 把 Observation[] 组装成 RelationTreeView 的纯函数（无 IO、无副作用）。
// 组装规则（实现计划 §4.6）：
// - byOrg 归属树：organizationId → userId → agentConfigId → instanceId 逐层建节点；
// - byEntity machine 树：按 machineId 分组，叶子 roleId 恒等于 machineId；
// - integrity：checked = 观察数，mismatched = verified===false 数，明细只含 kind+id；
// - total 计入 machine 观察（Q3 决策）。

import {
  type AgentNodeView,
  EMPTY_OBSERVATION_NAMES,
  type InstanceNodeView,
  type IntegritySummary,
  type LeafView,
  type MachineTreeView,
  type Observation,
  type ObservationNames,
  type OrgNodeView,
  type RelationTreeView,
  type UserNodeView,
} from "./types";

/** 每个观察的角色映射（每角色至多取一次；缺省角色不占位）。 */
function buildRoleMap(observation: Observation): Map<string, string> {
  const roles = new Map<string, string>();
  for (const { role, id } of observation.entityIds) {
    if (!roles.has(role)) roles.set(role, id);
  }
  return roles;
}

/** 每个 org/user/agent 累加器维护子树内去重 leaf id 集合，供层级 leafCount 汇总。 */
interface AgentAcc {
  node: AgentNodeView;
  leafIds: Set<string>;
  instances: Map<string, InstanceNodeView>;
}
interface UserAcc {
  node: UserNodeView;
  leafIds: Set<string>;
  agents: Map<string, AgentAcc>;
}
interface OrgAcc {
  node: OrgNodeView;
  leafIds: Set<string>;
  users: Map<string, UserAcc>;
}

/** 逐层排序，保证输出稳定、可断言。 */
function sortedBy<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => key(a).localeCompare(key(b)));
}

function buildByOrg(observations: Observation[]): OrgNodeView[] {
  const orgs = new Map<string, OrgAcc>();

  for (const observation of observations) {
    const roles = buildRoleMap(observation);
    // 无 org 的观察（如 machine 连接）不进归属树，只进 byEntity 与 total。
    const orgId = roles.get("organizationId");
    if (!orgId) continue;
    const userId = roles.get("userId");
    const agentConfigId = roles.get("agentConfigId");
    const instanceId = roles.get("instanceId");

    // 叶子对象（payload 概要原样携带；machineId 可能为 null）
    const leaf: LeafView = {
      id: observation.id,
      source: observation.source,
      machineId: roles.get("machineId") ?? null,
      ...(observation.payload ? { payload: observation.payload } : {}),
    };

    // 归属树固定四级（org→user→agent→instance），可挂载的叶子载体只有
    // instance 层与 agent 层（AgentNodeView.leaves，D9）。org+user 但无
    // agentConfigId 的观察没有可挂载载体，不进 byOrg（仍在 byEntity 与 total 中）。
    if (!agentConfigId) continue;

    let orgAcc = orgs.get(orgId);
    if (!orgAcc) {
      orgAcc = {
        node: { organizationId: orgId, userCount: 0, agentCount: 0, instanceCount: 0, leafCount: 0, children: [] },
        leafIds: new Set(),
        users: new Map(),
      };
      orgs.set(orgId, orgAcc);
    }
    // org 层先计入 leafId；缺 userId 的观察没有可见叶子载体（叶子只挂 instance/agent 层），
    // 仅被 org.leafCount 计数。acp-link 四来源 userId 恒存在，此路径实际不可达，仅为保守处理。
    orgAcc.leafIds.add(observation.id);

    if (!userId) continue;
    let userAcc = orgAcc.users.get(userId);
    if (!userAcc) {
      userAcc = {
        node: { userId, agentCount: 0, leafCount: 0, children: [] },
        leafIds: new Set(),
        agents: new Map(),
      };
      orgAcc.users.set(userId, userAcc);
    }
    userAcc.leafIds.add(observation.id);

    let agentAcc = userAcc.agents.get(agentConfigId);
    if (!agentAcc) {
      agentAcc = {
        node: { agentConfigId, instanceCount: 0, leafCount: 0, children: [], leaves: undefined },
        leafIds: new Set(),
        instances: new Map(),
      };
      userAcc.agents.set(agentConfigId, agentAcc);
    }
    agentAcc.leafIds.add(observation.id);

    if (instanceId) {
      let instance = agentAcc.instances.get(instanceId);
      if (!instance) {
        instance = { instanceId, leafCount: 0, leaves: [] };
        agentAcc.instances.set(instanceId, instance);
      }
      instance.leaves.push(leaf);
    } else {
      // 无 instanceId 的叶子（如本地 acp-link）直接挂在 agent 节点（D9）
      agentAcc.node.leaves ??= [];
      agentAcc.node.leaves.push(leaf);
    }
  }

  // 汇总计数并输出
  const out: OrgNodeView[] = [];
  for (const orgAcc of orgs.values()) {
    const { node: orgNode } = orgAcc;
    const users = sortedBy([...orgAcc.users.values()], (u) => u.node.userId);
    orgNode.children = users.map((userAcc) => {
      const agents = sortedBy([...userAcc.agents.values()], (a) => a.node.agentConfigId);
      userAcc.node.children = agents.map((agentAcc) => {
        const instances = sortedBy([...agentAcc.instances.values()], (i) => i.instanceId);
        for (const instance of instances) {
          instance.leaves = sortedBy(instance.leaves, (l) => l.id);
          instance.leafCount = instance.leaves.length;
        }
        agentAcc.node.children = instances;
        agentAcc.node.instanceCount = instances.length;
        agentAcc.node.leafCount = agentAcc.leafIds.size;
        if (agentAcc.node.leaves) {
          agentAcc.node.leaves = sortedBy(agentAcc.node.leaves, (l) => l.id);
        }
        return agentAcc.node;
      });
      userAcc.node.agentCount = agents.length;
      userAcc.node.leafCount = userAcc.leafIds.size;
      return userAcc.node;
    });
    orgNode.userCount = users.length;
    orgNode.agentCount = users.reduce((sum, u) => sum + u.node.agentCount, 0);
    // 注意：orgNode.children 已是 UserNodeView（map 输出），instance 计数取视图层字段
    orgNode.instanceCount = orgNode.children.reduce(
      (sum, u) => sum + u.children.reduce((s, a) => s + a.instanceCount, 0),
      0,
    );
    orgNode.leafCount = orgAcc.leafIds.size;
    out.push(orgNode);
  }
  return sortedBy(out, (o) => o.organizationId);
}

function buildByEntity(observations: Observation[]): MachineTreeView[] {
  const groups = new Map<string, MachineTreeView>();
  for (const observation of observations) {
    const machineId = buildRoleMap(observation).get("machineId");
    if (!machineId) continue; // 无 machineId 的观察不进 machine 树
    let group = groups.get(machineId);
    if (!group) {
      group = { machineId, count: 0, leaves: [] };
      groups.set(machineId, group);
    }
    group.leaves.push({ id: observation.id, source: observation.source, roleId: machineId });
  }
  const out = [...groups.values()];
  for (const group of out) {
    group.leaves = sortedBy(group.leaves, (l) => l.id);
    group.count = group.leaves.length;
  }
  return sortedBy(out, (g) => g.machineId);
}

function buildIntegrity(kind: string, observations: Observation[]): IntegritySummary {
  const mismatchedItems = observations
    .filter((observation) => observation.verified === false)
    .map((observation) => ({ kind, id: observation.id }));
  return {
    checked: observations.length,
    mismatched: mismatchedItems.length,
    mismatchedItems,
  };
}

/** 把观察数组组装为关系树视图（kind 用于 integrity 明细与输出标记）。 */
export function buildRelationTree(
  kind: string,
  observations: Observation[],
  names: ObservationNames = EMPTY_OBSERVATION_NAMES,
): RelationTreeView {
  return {
    generatedAt: new Date().toISOString(),
    kind,
    total: observations.length,
    byOrg: buildByOrg(observations),
    byEntity: buildByEntity(observations),
    integrity: buildIntegrity(kind, observations),
    names,
  };
}
