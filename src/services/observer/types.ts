// src/services/observer/types.ts
// Observer Service 领域类型（docs/arch/21-observability-observer-service.md §2/§3/§4）。
//
// 设计边界（文档 §0）：
// - 请求驱动拉取：Observer 不挂接任何生命周期事件，只在收到请求时现场收集；
// - 纯内存零持久化：所有输出即用即弃，不缓存、不写库；
// - 只读：只调用各来源的只读能力，不做任何管控动作。
//
// 类型来源说明：AcpConnectionSnapshot 定义于 src/types/store.ts、
// ExternalRelayConnectionSnapshot 定义于 src/transport/relay/external-relay.ts，
// 这里仅 import type（编译期擦除），避免把 relay 模块运行时图拖进观察链路。

import type { EnvironmentRecord } from "../../repositories";
import type { ExternalRelayConnectionSnapshot } from "../../transport/relay/external-relay";
import type { AcpConnectionSnapshot } from "../../types/store";

/** acp-link kind 的三类现场来源（linkId 前缀 = source，见 §4.4 linkId 归一化）。 */
export const OBSERVER_LINK_SOURCES = ["acp-ws", "external-relay", "chat-relay"] as const;
export type ObserverLinkSource = (typeof OBSERVER_LINK_SOURCES)[number];

/** 输出行（节点），文档 §2.1。 */
export interface Observation {
  /** 业务 id：source + 来源连接 id 归一化（§4.4） */
  id: string;
  /** 观察类型，acp-link kind 下恒为 "acp-link" */
  kind: string;
  /** 该对象在关系图谱中的各角色 id（缺省角色不占位，直接省略） */
  entityIds: { role: string; id: string }[];
  /** 现场收集来源（注册表名，信任标记） */
  source: string;
  /** 收集时间 Date.now() */
  ts: number;
  /** 类型化负载（capabilities、session 等概要，不含敏感字段） */
  payload?: Record<string, unknown>;
  /** 角色 id 是否经权威表回查对齐 */
  verified?: boolean;
}

/** 收集器（Provider），文档 §2.4。 */
export interface KindProvider {
  kind: string;
  collect(ctx: ObserverContext): Promise<Observation[]>;
}

/** 只读来源快照（chat-relay 用；避免直接暴露 ClientConnection 内部类型）。 */
export interface ChatClientSnapshot {
  wsId: string;
  userId: string;
  agentId: string;
  instanceId: string;
  rcsSessionId: string;
  acpSessionId: string | null;
  openTime: number;
}

/** Provider 收到的上下文：只读来源 + 权威回查，全部可注入（测试友好）。 */
export interface ObserverContext {
  sources: {
    acpWs(): Promise<readonly AcpConnectionSnapshot[]> | readonly AcpConnectionSnapshot[];
    externalRelay(): Promise<readonly ExternalRelayConnectionSnapshot[]> | readonly ExternalRelayConnectionSnapshot[];
    chatClients(): Promise<readonly ChatClientSnapshot[]> | readonly ChatClientSnapshot[];
  };
  /** environment 权威表回查（org/user/agentConfigId 对齐的唯一依据） */
  getEnvironment: (envId: string) => Promise<EnvironmentRecord | null | undefined>;
  /** 远端承载 machine 解析：agentConfig.machineId → defaultMachineId → null */
  resolveHostMachineId: (env: EnvironmentRecord) => Promise<string | null>;
  /** 本地链接 machine fallback（RCS_DEFAULT_MACHINE_ID），未配置时为 null */
  defaultMachineId: string | null;
}

// ── 树视图（文档 §4 代码块；内部类型，API 层再包 trees 骨架）──

/** 叶子对象行。machineId 为承载 machine（可能为 null）。 */
export interface LeafView {
  id: string;
  source: string;
  machineId: string | null;
  payload?: Record<string, unknown>;
}
/** 实例节点：仅承载有 instanceId 归属的叶子。 */
export interface InstanceNodeView {
  instanceId: string;
  leafCount: number;
  leaves: LeafView[];
}
/**
 * 智能体节点。leaves 为无 instanceId 归属的叶子（如本地 acp-link 无实例），
 * 这是对文档 §4 的一处实现澄清（D9）：本地链接无法落到实例节点。
 */
export interface AgentNodeView {
  agentConfigId: string;
  instanceCount: number;
  leafCount: number;
  children: InstanceNodeView[];
  /** 无 instanceId 归属的叶子（如本地 acp-link）直接挂在 agent 节点 */
  leaves?: LeafView[];
}
export interface UserNodeView {
  userId: string;
  agentCount: number;
  leafCount: number;
  children: AgentNodeView[];
}
export interface OrgNodeView {
  organizationId: string;
  userCount: number;
  agentCount: number;
  instanceCount: number;
  leafCount: number;
  children: UserNodeView[];
}
/** machine 树叶子：roleId 按文档 §4 命名，acp-link 恒等于 machineId。 */
export interface MachineTreeLeaf {
  id: string;
  source: string;
  roleId: string;
}
export interface MachineTreeView {
  machineId: string;
  count: number;
  leaves: MachineTreeLeaf[];
}

/**
 * 一致性汇总。mismatchedItems 是对文档 §4 的命名澄清（D9）：原文档把 mismatched
 * 同时用作计数与数组名，这里拆分计数与明细数组。
 */
export interface IntegritySummary {
  checked: number;
  mismatched: number;
  mismatchedItems: { kind: string; id: string }[];
}

/**
 * 各角色 id 的可读名称字典（文档 §4 names，name(id) 展示用）。
 * 键为角色词汇表 role 名（不含 linkId：叶子 id 即业务 id，无需名称）。
 * instanceId 名称由 environment 名 + 实例序号派生（经 instance registry 回查，只读）。
 */
export interface ObservationNames {
  organizationId: Record<string, string>;
  userId: Record<string, string>;
  agentConfigId: Record<string, string>;
  instanceId: Record<string, string>;
  machineId: Record<string, string>;
}

/** 空名称字典（未解析到名称时的安全初值）。 */
export const EMPTY_OBSERVATION_NAMES: ObservationNames = {
  organizationId: {},
  userId: {},
  agentConfigId: {},
  instanceId: {},
  machineId: {},
};

/** 组装结果：byOrg 归属树 + byEntity machine 树 + integrity + total + names。 */
export interface RelationTreeView {
  generatedAt: string; // new Date().toISOString()
  kind: string; // "acp-link"
  total: number;
  byOrg: OrgNodeView[];
  byEntity: MachineTreeView[];
  integrity: IntegritySummary;
  /** 各角色 id → 可读名称；缺失 id 不出现在字典，由前端回退显示原始 id */
  names: ObservationNames;
}
