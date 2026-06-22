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

export function buildProviderPublicReadablePayload(publicReadable: boolean): Record<string, unknown> {
  return { publicReadable };
}

/**
 * 为 provider 连通性/模型列表测试构造 inline 参数。
 *
 * 前端测试最新表单值时必须只使用当前表单输入，避免在用户未保存前提前落库。
 */
export function buildProviderInlineTestPayload(input: {
  apiKey: string;
  baseURL: string;
  protocol: "openai" | "anthropic";
}): {
  apiKey?: string;
  baseURL?: string;
  protocol: "openai" | "anthropic";
} {
  return {
    apiKey: input.apiKey.trim() ? input.apiKey : undefined,
    baseURL: input.baseURL.trim() ? input.baseURL : undefined,
    protocol: input.protocol,
  };
}

/** Provider 名称到品牌色的映射。用于工牌卡片头像背景色。 */
const PROVIDER_COLORS: Record<string, string> = {
  openai: "#10a37f",
  anthropic: "#d4a574",
  deepseek: "#6366f1",
  google: "#f59e0b",
  mistral: "#8b5cf6",
  meta: "#1877f2",
  grok: "#000000",
  qwen: "#615ced",
};

/**
 * 根据 Provider 名称获取品牌色。
 * 匹配逻辑：名称转小写后，按 PROVIDER_COLORS 的 key 做 includes 匹配，返回第一个命中项。
 * 未命中返回默认灰色 #64748b。
 */
export function getProviderColor(name: string): string {
  const key = name.toLowerCase();
  for (const [k, v] of Object.entries(PROVIDER_COLORS)) {
    if (key.includes(k)) return v;
  }
  return "#64748b";
}
