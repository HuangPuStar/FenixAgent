// src/services/observer/providers/acp-link.ts
// acp-link kind 的 Provider：在每次请求时只读遍历 acp-ws / external-relay / chat-relay
// 三个来源的注册表，现场组装 Observation 并返回（文档 §3.2 / 实现计划 §4.5）。
//
// 一致性校验（D6）：所有 join key 在组装时经 environment 权威表回查对齐；
// env 缺失、关键角色缺省（如 machineId 注册前为 null）、归属不一致 → verified=false，
// 计入 integrity 的 mismatchedItems。userId 哨兵 "__machine__" 不输出。

import type { ExternalRelayConnectionSnapshot } from "../../../transport/relay/external-relay";
import type { AcpConnectionSnapshot } from "../../../types/store";
import type { ChatClientSnapshot, KindProvider, Observation, ObserverContext } from "../types";

/** acp-link Provider（模块单例构造时注册到 ObserverService）。 */
export const acpLinkProvider: KindProvider = {
  kind: "acp-link",
  collect: (ctx) => collectAcpLink(ctx),
};

/** 现场收集 acp-link 观察（便于单测直调，绕过服务注册表）。 */
export async function collectAcpLink(ctx: ObserverContext): Promise<Observation[]> {
  const out: Observation[] = [];
  const now = Date.now();
  for (const entry of await ctx.sources.acpWs()) {
    out.push(await toAcpWsObservation(entry, now, ctx));
  }
  for (const entry of await ctx.sources.externalRelay()) {
    out.push(await toRelayObservation(entry, now, ctx));
  }
  for (const client of await ctx.sources.chatClients()) {
    out.push(await toChatObservation(client, now, ctx));
  }
  return out;
}

/** acp-ws 来源：machine 连接与本地 acp-link 两类（字段差异见映射表 §4.5）。 */
async function toAcpWsObservation(
  entry: AcpConnectionSnapshot,
  now: number,
  ctx: ObserverContext,
): Promise<Observation> {
  const base: Omit<Observation, "entityIds"> = {
    id: `acp-ws:${entry.wsId}`,
    kind: "acp-link",
    source: "acp-ws",
    ts: now,
    payload: {
      source: "acp-ws",
      openTime: entry.openTime,
      ...(entry.capabilities ? { capabilities: entry.capabilities } : {}),
    },
  };

  if (entry.isMachine) {
    // machine 连接：路由层传入 "__machine__" 哨兵 userId，不输出；无 org 归属。
    // machineId 注册前为 null → 省略角色且 verified=false（D6）。
    const entityIds: { role: string; id: string }[] = [{ role: "linkId", id: base.id }];
    if (entry.machineId) entityIds.push({ role: "machineId", id: entry.machineId });
    return { ...base, entityIds, verified: entry.machineId !== null };
  }

  // 本地 acp-link：identify 前 agentId 即 boundEnvId（envId），identify 后为 agentId。
  const agentId = entry.agentId ?? entry.boundEnvId;
  const env = agentId ? await ctx.getEnvironment(agentId) : undefined;

  const entityIds: { role: string; id: string }[] = [
    { role: "linkId", id: base.id },
    { role: "userId", id: entry.userId },
  ];
  if (env?.organizationId) entityIds.push({ role: "organizationId", id: env.organizationId });
  if (env?.agentConfigId) entityIds.push({ role: "agentConfigId", id: env.agentConfigId });
  if (ctx.defaultMachineId) entityIds.push({ role: "machineId", id: ctx.defaultMachineId });

  // 本地链接 machine fallback = config.defaultMachineId（D4）；未配置则省略角色。
  // 归属校验：组织环境 org 恒取自 env（`env.organizationId===org角色` 恒真，按计划
  // 公式化简后只剩 userId 比对），个人环境要求 userId 与属主一致。
  const verified = env != null && (env.userId === null || env.userId === entry.userId);
  return { ...base, entityIds, verified };
}

/** external-relay 来源：authoritative env 回查 + open 时「org 或 user 任一匹配」放行语义。 */
async function toRelayObservation(
  entry: ExternalRelayConnectionSnapshot,
  now: number,
  ctx: ObserverContext,
): Promise<Observation> {
  const env = await ctx.getEnvironment(entry.agentId);
  const entityIds: { role: string; id: string }[] = [
    { role: "linkId", id: `external-relay:${entry.relayWsId}` },
    { role: "userId", id: entry.userId },
    { role: "instanceId", id: entry.instanceId },
  ];
  if (env?.organizationId) entityIds.push({ role: "organizationId", id: env.organizationId });
  if (env?.agentConfigId) entityIds.push({ role: "agentConfigId", id: env.agentConfigId });
  const machineId = env ? await ctx.resolveHostMachineId(env) : null;
  if (machineId) entityIds.push({ role: "machineId", id: machineId });

  // 对齐 open 时「org 匹配或 user 匹配」放行规则（external-relay.ts 同款语义）
  const verified = env != null && (entry.userId === env.userId || entry.organizationId === env.organizationId);
  return {
    id: `external-relay:${entry.relayWsId}`,
    kind: "acp-link",
    source: "external-relay",
    ts: now,
    entityIds,
    payload: { source: "external-relay", openTime: entry.openTime },
    verified,
  };
}

/** chat-relay 来源：wsId 取自 registry 的 key（forEachClientEntry 带出）。 */
async function toChatObservation(client: ChatClientSnapshot, now: number, ctx: ObserverContext): Promise<Observation> {
  const env = await ctx.getEnvironment(client.agentId);
  const entityIds: { role: string; id: string }[] = [
    { role: "linkId", id: `chat-relay:${client.wsId}` },
    { role: "userId", id: client.userId },
    { role: "instanceId", id: client.instanceId },
  ];
  if (env?.organizationId) entityIds.push({ role: "organizationId", id: env.organizationId });
  if (env?.agentConfigId) entityIds.push({ role: "agentConfigId", id: env.agentConfigId });
  const machineId = env ? await ctx.resolveHostMachineId(env) : null;
  if (machineId) entityIds.push({ role: "machineId", id: machineId });

  // chat-relay 经 /acp/yjs 网关认证接入：组织环境成员放行（userId 不必等于属主），
  // 个人环境 open 时已校验属主，因此 verified 以 env 存在为必要条件。
  const verified = env != null && (client.userId === env.userId || env.organizationId !== null);
  return {
    id: `chat-relay:${client.wsId}`,
    kind: "acp-link",
    source: "chat-relay",
    ts: now,
    entityIds,
    payload: {
      source: "chat-relay",
      rcsSessionId: client.rcsSessionId,
      ...(client.acpSessionId ? { acpSessionId: client.acpSessionId } : {}),
      openTime: client.openTime,
    },
    verified,
  };
}
