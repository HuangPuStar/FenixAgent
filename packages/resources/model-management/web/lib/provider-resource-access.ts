import type { ResourceAccessActions, ResourceScopeView } from "@fenix/web-runtime/types/config";

/**
 * 前端授权判断的最小输入形状。
 *
 * 字段全部可选：这些 helper 既接收 `/web` 列表项（含 `scope` / `access`），也接收对话框等局部对象。
 * 判断依据是新授权视图的 `scope` 与 `access.actions`，缺失时必须按「无归属、不可写」保守降级，
 * 不得回退读取旧栈的 `resourceAccess`（旧栈的 `writable !== false` 默认放行正是这次切换要消除的
 * 越权展示来源）。
 */
export interface ProviderResourceLike {
  /** Provider 数据库资源 ID。 */
  id: string;
  /** 配置名称。 */
  name?: string;
  /** 展示名；为空时展示配置名。 */
  displayName?: string;
  scope?: ResourceScopeView;
  access?: { actions?: ResourceAccessActions };
}

/** 模型条目的授权视图输入：模型不独立持有归属，字段一律取自所属 Provider。 */
export interface ModelProviderResourceLike {
  /** 所属 Provider 的资源 UUID。 */
  providerId?: string;
  /** 所属 Provider 的配置名（组织内唯一）。 */
  provider: string;
  scope?: ResourceScopeView;
  access?: { actions?: ResourceAccessActions };
}

/** Provider 的稳定身份，直接使用数据库 ID。 */
export function getProviderKey(provider: ProviderResourceLike) {
  return provider.id;
}

/** 模型选项保留既有资源键格式，避免改变默认模型偏好存储。 */
export function getModelProviderKey(model: ModelProviderResourceLike) {
  const organizationId = model.scope?.organizationId;
  return organizationId && model.providerId ? `${organizationId}/${model.providerId}` : model.provider;
}

/** 展示名：展示名为空时退回配置名，避免出现无名条目。 */
export function getProviderDisplayName(provider: ProviderResourceLike) {
  const displayName = provider.displayName ?? "";
  return displayName === "" ? (provider.name ?? "") : displayName;
}

/** 是否可写；`update` 动作缺失时保守视为不可写。 */
export function isProviderWritable(provider: ProviderResourceLike) {
  return provider.access?.actions?.includes("update") ?? false;
}

/** 是否可管理公开状态；与写权限等价，均由 `update` 动作决定。 */
export function canManageProviderSharing(provider: ProviderResourceLike) {
  return isProviderWritable(provider);
}

/**
 * 是否为其他组织的共享资源。
 *
 * 两种情况按本组织资源处理，与后端「缺失 `scope` 视为 internal」的语义一致：资源本身无归属组织
 * （个人资源）；当前组织 id 未知（组织上下文未就绪）。后者若按外部处理，会在加载瞬间把用户自己的
 * Provider 标成共享来源并从「本组织」筛选中隐藏。
 */
export function isExternalProvider(provider: ProviderResourceLike, activeOrganizationId?: string) {
  const organizationId = provider.scope?.organizationId;
  if (!organizationId || !activeOrganizationId) return false;
  return organizationId !== activeOrganizationId;
}

/** 模型所属 Provider 是否归属其他组织，语义与 {@link isExternalProvider} 相同。 */
export function isExternalModelProvider(model: ModelProviderResourceLike, activeOrganizationId?: string) {
  return isExternalProvider({ id: model.provider, scope: model.scope }, activeOrganizationId);
}

/** 是否已对其他组织公开；决定展示角标与公开开关的文案。 */
export function isPublicProvider(provider: ProviderResourceLike) {
  return provider.scope?.visibility === "public";
}

/** 资源角标 i18n key：外部组织资源优先，其次公开，否则本组织私有。 */
export function getProviderAccessBadgeKey(provider: ProviderResourceLike, activeOrganizationId?: string) {
  if (isExternalProvider(provider, activeOrganizationId)) return "resource.external";
  if (isPublicProvider(provider)) return "resource.public";
  return "resource.internal";
}
