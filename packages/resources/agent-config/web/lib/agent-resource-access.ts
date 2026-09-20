import type { ResourceAccessActions, ResourceScopeView } from "@fenix/web-runtime/types/config";

/**
 * Agent 资源的前端授权派生子。
 *
 * 输入形状与 `@/src/lib/skill-resource-access` 一致：字段全部可选，因为这里既接收 `/web` 列表视图
 * （含 `scope` / `access`），也接收对话框等局部对象。判断依据是服务端返回的归属 `scope` 与有效动作
 * `access.actions`；缺失时按「本组织私有、不可写」保守降级，不得假设可写——旧栈的
 * `resourceAccess.writable !== false` 默认放行正是这次切换要消除的越权展示来源。
 */
export interface AgentResourceLike {
  id?: string;
  name: string;
  scope?: ResourceScopeView;
  access?: { actions?: ResourceAccessActions };
  organizationName?: string;
}

/**
 * 资源的跨组织稳定键。
 *
 * 新授权视图不再提供 `resourceAccess.resourceKey`，因此按 `${scope.organizationId}/${id}` 自行推导：
 * 二者缺一都无法保证跨组织唯一，此时退回 `name`（资源名在同一组织内唯一）。
 */
export function getAgentKey(agent: AgentResourceLike) {
  const organizationId = agent.scope?.organizationId;
  if (organizationId && agent.id) return `${organizationId}/${agent.id}`;
  return agent.name;
}

/** 详情读取使用的查找键，语义与 {@link getAgentKey} 相同。 */
export function getAgentConfigLookupKey(agent: AgentResourceLike) {
  return getAgentKey(agent);
}

/** 展示名：跨组织资源补上归属组织名以便区分同名资源，否则直接用资源名。 */
export function getAgentDisplayName(agent: AgentResourceLike) {
  const organizationName = agent.organizationName;
  return organizationName ? `${organizationName}/${agent.name}` : agent.name;
}

/** 是否可写；`update` 动作缺失时保守视为不可写。 */
export function isAgentWritable(agent: AgentResourceLike) {
  return agent.access?.actions?.includes("update") ?? false;
}

/** 是否可管理公开状态；与写权限等价，均由 `update` 动作决定。 */
export function canManageAgentSharing(agent: AgentResourceLike) {
  return isAgentWritable(agent);
}

/**
 * 是否为其他组织的共享资源。
 *
 * 两种情况按本组织资源处理，与后端「缺失 `scope` 视为 internal」的语义一致：资源本身无归属组织
 * （个人资源）；当前组织 id 未知（组织上下文未就绪）。后者若按外部处理，会在加载瞬间把用户自己的
 * Agent 标成共享来源并从默认筛选中隐藏。
 */
export function isExternalAgent(agent: AgentResourceLike, activeOrganizationId?: string) {
  const organizationId = agent.scope?.organizationId;
  if (!organizationId || !activeOrganizationId) return false;
  return organizationId !== activeOrganizationId;
}

/** 是否已对其他组织公开；决定展示角标与公开开关的文案。 */
export function isPublicAgent(agent: AgentResourceLike) {
  return agent.scope?.visibility === "public";
}

/** 资源角标 i18n key：外部组织资源优先，其次公开，否则本组织私有。 */
export function getAgentAccessBadgeKey(agent: AgentResourceLike, activeOrganizationId?: string) {
  if (isExternalAgent(agent, activeOrganizationId)) return "resource.external";
  if (isPublicAgent(agent)) return "resource.public";
  return "resource.internal";
}
