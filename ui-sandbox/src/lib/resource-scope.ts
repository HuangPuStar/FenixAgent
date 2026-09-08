export const RESOURCE_SCOPES = ["全部", "个人", "本组织", "平台"] as const;
export const MARKETPLACE_SCOPES = [...RESOURCE_SCOPES, "市场"] as const;

export type ResourceScope = (typeof RESOURCE_SCOPES)[number];
export type OwnedResourceScope = Exclude<ResourceScope, "全部">;
export type MarketplaceScope = (typeof MARKETPLACE_SCOPES)[number];
export type OwnedMarketplaceScope = Exclude<MarketplaceScope, "全部">;
