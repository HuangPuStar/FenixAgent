import type { ProviderInfo } from "../../../types/config";

/**
 * Provider 相关的纯工具函数。
 *
 * 从 AgentModelsPage.tsx 中拆出，使单元测试无需加载组件模块
 * （组件模块引入了 @lobehub/icons，其 antd-style 依赖在 happy-dom 中不可用）。
 */

export function getProviderKey(provider: ProviderInfo): string {
  return provider.resourceAccess?.resourceKey ?? provider.resourceKey ?? provider.id;
}

export function getProviderDisplayName(provider: ProviderInfo): string {
  const source = provider.resourceAccess?.sourceOrganizationName;
  if (source) return `${source}/${provider.id}`;
  return provider.id;
}

export function getProviderResourceBadgeKey(provider: ProviderInfo): string {
  if (provider.resourceAccess?.ownership === "external") return "resource.external";
  if (provider.resourceAccess?.publicReadable) return "resource.public";
  return "resource.internal";
}

export function canWriteProvider(provider: ProviderInfo): boolean {
  return provider.resourceAccess?.writable !== false;
}

export function buildProviderPublicReadablePayload(
  options: Record<string, unknown>,
  publicReadable: boolean,
): Record<string, unknown> {
  return { ...options, publicReadable };
}
