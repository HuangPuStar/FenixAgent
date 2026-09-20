import type { ResourceAccessActions, ResourceScopeView } from "@fenix/web-runtime/types/config";

/**
 * 前端授权判断的最小输入形状。
 *
 * 字段全部可选：这些 helper 既接收 `/web` 列表视图（含 `scope`/`access`），也接收对话框等局部对象。
 * 判断依据已从旧栈的 `resourceAccess` 换成新授权视图的 `scope` 与 `access.actions`，
 * 缺失时必须按「本组织私有、不可写」保守降级，不得假设可写。
 */
export interface McpResourceLike {
  name: string;
  id?: string;
  scope?: ResourceScopeView;
  access?: { actions?: ResourceAccessActions };
  organizationName?: string;
}

/**
 * 资源的跨组织稳定键。
 *
 * 新视图不再提供 `resourceAccess.resourceKey`，因此按 `${scope.organizationId}/${id}` 自行推导：
 * 二者缺一都无法保证跨组织唯一，此时退回 `name`（资源名在同一组织内唯一）。
 */
export function getMcpKey(server: McpResourceLike) {
  const organizationId = server.scope?.organizationId;
  if (organizationId && server.id) return `${organizationId}/${server.id}`;
  return server.name;
}

/**
 * 详情读取使用的查找键，语义与 {@link getMcpKey} 相同。
 *
 * 独立命名是为了标明调用点意图：详情接口的 `name` 参数同时承载服务器名与跨组织资源键。
 */
export function getMcpLookupKey(server: McpResourceLike) {
  return getMcpKey(server);
}

/**
 * 判断资源是否归属其他组织。
 *
 * 两种情况按本组织资源处理，与后端「缺失 `scope` 视为 internal」的语义一致：
 * 资源本身无归属组织（个人资源）；当前组织 id 未知（组织上下文未就绪）。后者若按外部处理，
 * 会在加载瞬间把用户自己的资源标成共享来源并从「本组织」筛选中隐藏。
 */
export function isExternalMcp(server: McpResourceLike, activeOrganizationId?: string) {
  const organizationId = server.scope?.organizationId;
  if (!organizationId || !activeOrganizationId) return false;
  return organizationId !== activeOrganizationId;
}

/** 是否可写；`update` 动作缺失时保守视为不可写。 */
export function canWriteMcp(server: McpResourceLike) {
  return server.access?.actions?.includes("update") ?? false;
}

/** 是否可管理公开状态；与写权限等价，均由 `update` 动作决定。 */
export function canManageMcpSharing(server: McpResourceLike) {
  return canWriteMcp(server);
}

export function filterWritableMcps<T extends McpResourceLike>(servers: T[]) {
  return servers.filter((server) => canWriteMcp(server));
}

/** 资源角标 i18n key：外部组织资源优先，其次公开，否则本组织私有。 */
export function getMcpResourceBadgeKey(server: McpResourceLike, activeOrganizationId?: string) {
  if (isExternalMcp(server, activeOrganizationId)) return "resource.external";
  if (server.scope?.visibility === "public") return "resource.public";
  return "resource.internal";
}

/** 展示名：跨组织资源补上归属组织名以便区分同名资源，否则直接用资源名。 */
export function getMcpDisplayName(server: McpResourceLike) {
  const organizationName = server.organizationName;
  if (organizationName) return `${organizationName}/${server.name}`;
  return server.name;
}
