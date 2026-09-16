// src/schemas/api-system-observer.schema.ts
// GET /api/system/observer/acp-link 响应 schema（docs/arch/21-observability-observer-service.md §4）。
// 对齐文档 §4 形状：data.trees.{byEntity,byOrg} 包裹两棵树；integrity 使用实现澄清的
// { checked, mismatched, mismatchedItems }（计划 D9）；AgentNodeView.leaves 可选承载
// 无实例归属的叶子（D9）。

import * as z from "zod/v4";
// source 词汇表与 Provider 共享同一常量（计划 D1/D3：source 枚举同时用于 schema 校验）。
// types.ts 是纯类型模块（仅 import type），运行时无副作用，schema 引用不会拖入依赖。
import { OBSERVER_LINK_SOURCES } from "../services/observer/types";

export const ObserverLeafViewSchema = z.object({
  id: z.string().describe("叶子业务 id（source + 来源连接 id）。"),
  source: z.enum(OBSERVER_LINK_SOURCES).describe("现场收集来源（注册表名）。"),
  machineId: z.string().nullable().describe("承载 machine id；无承载时为 null。"),
  payload: z.record(z.string(), z.unknown()).optional().describe("类型化负载概要。"),
});
export type ObserverLeafView = z.infer<typeof ObserverLeafViewSchema>;

export const ObserverInstanceNodeSchema = z.object({
  instanceId: z.string().describe("实例 id。"),
  leafCount: z.number().int().nonnegative().describe("该实例下叶子数。"),
  leaves: ObserverLeafViewSchema.array().describe("该实例下叶子。"),
});
export type ObserverInstanceNode = z.infer<typeof ObserverInstanceNodeSchema>;

export const ObserverAgentNodeSchema = z.object({
  agentConfigId: z.string().describe("智能体配置 id。"),
  instanceCount: z.number().int().nonnegative().describe("该智能体下实例数。"),
  leafCount: z.number().int().nonnegative().describe("该智能体下叶子数。"),
  children: ObserverInstanceNodeSchema.array().describe("实例节点列表。"),
  leaves: ObserverLeafViewSchema.array()
    .optional()
    .describe("无 instanceId 归属的叶子（如本地 acp-link），直接挂在智能体节点。"),
});
export type ObserverAgentNode = z.infer<typeof ObserverAgentNodeSchema>;

export const ObserverUserNodeSchema = z.object({
  userId: z.string().describe("用户 id。"),
  agentCount: z.number().int().nonnegative().describe("该用户下智能体数。"),
  leafCount: z.number().int().nonnegative().describe("该用户下叶子数。"),
  children: ObserverAgentNodeSchema.array().describe("智能体节点列表。"),
});
export type ObserverUserNode = z.infer<typeof ObserverUserNodeSchema>;

export const ObserverOrgNodeSchema = z.object({
  organizationId: z.string().describe("组织 id。"),
  userCount: z.number().int().nonnegative().describe("该组织下用户数。"),
  agentCount: z.number().int().nonnegative().describe("该组织下智能体数。"),
  instanceCount: z.number().int().nonnegative().describe("该组织下实例数。"),
  leafCount: z.number().int().nonnegative().describe("该组织下叶子数。"),
  children: ObserverUserNodeSchema.array().describe("用户节点列表。"),
});
export type ObserverOrgNode = z.infer<typeof ObserverOrgNodeSchema>;

export const ObserverMachineTreeLeafSchema = z.object({
  id: z.string().describe("叶子业务 id。"),
  source: z.enum(OBSERVER_LINK_SOURCES).describe("现场收集来源。"),
  roleId: z.string().describe("承载角色 id（acp-link 恒等于 machineId）。"),
});
export type ObserverMachineTreeLeaf = z.infer<typeof ObserverMachineTreeLeafSchema>;

export const ObserverMachineTreeSchema = z.object({
  machineId: z.string().describe("machine id。"),
  count: z.number().int().nonnegative().describe("该 machine 承载的叶子数。"),
  leaves: ObserverMachineTreeLeafSchema.array().describe("该 machine 承载的叶子列表。"),
});
export type ObserverMachineTree = z.infer<typeof ObserverMachineTreeSchema>;

export const ObserverIntegritySummarySchema = z.object({
  checked: z.number().int().nonnegative().describe("已核对观察数。"),
  mismatched: z.number().int().nonnegative().describe("归属不一致的观察数。"),
  mismatchedItems: z
    .array(z.object({ kind: z.string(), id: z.string() }))
    .describe("不一致明细（只含 kind+id，不含敏感字段）。"),
});
export type ObserverIntegritySummary = z.infer<typeof ObserverIntegritySummarySchema>;

/** 各角色 id → 可读名称字典（name(id) 展示用；缺失 id 不出现在字典，前端回退原始 id）。 */
export const ObserverNamesSchema = z.object({
  organizationId: z.record(z.string(), z.string()).describe("组织名：id → 名称。"),
  userId: z.record(z.string(), z.string()).describe("用户名：id → 名称。"),
  agentConfigId: z.record(z.string(), z.string()).describe("智能体配置名：id → 名称。"),
  instanceId: z.record(z.string(), z.string()).describe("实例名：id → environment 名 + 序号。"),
  machineId: z.record(z.string(), z.string()).describe("machine 名：id → 名称（name ?? agentName）。"),
});
export type ObserverNames = z.infer<typeof ObserverNamesSchema>;

export const ApiSystemObserverAcpLinkDataSchema = z.object({
  generatedAt: z.string().describe("快照生成时间（ISO 8601）。"),
  kind: z.literal("acp-link").describe("观察类型。"),
  total: z.number().int().nonnegative().describe("观察总数（含 machine）。"),
  trees: z.object({
    byEntity: ObserverMachineTreeSchema.array().describe("machine 树。"),
    byOrg: ObserverOrgNodeSchema.array().describe("归属树。"),
  }),
  integrity: ObserverIntegritySummarySchema.describe("一致性汇总。"),
  names: ObserverNamesSchema.describe("各角色 id 的可读名称字典（name(id) 展示用）。"),
});
export type ApiSystemObserverAcpLinkData = z.infer<typeof ApiSystemObserverAcpLinkDataSchema>;

export const ApiSystemObserverAcpLinkResponseSchema = z.object({
  success: z.literal(true).describe("固定成功标记。"),
  data: ApiSystemObserverAcpLinkDataSchema.describe("观察数据。"),
});
export type ApiSystemObserverAcpLinkResponse = z.infer<typeof ApiSystemObserverAcpLinkResponseSchema>;
