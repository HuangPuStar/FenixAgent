import type { ProviderInfo, ProviderModel } from "@fenix/web-runtime/types/config";
import {
  getProviderAccessBadgeKey,
  getProviderDisplayName,
  getProviderKey,
  isExternalProvider,
  isProviderWritable,
  isPublicProvider,
} from "../../../lib/provider-resource-access";

export type ProviderScope = "all" | "organization" | "public";

/**
 * Provider 相关的纯工具函数。
 *
 * 从 AgentModelsPage.tsx 中拆出，使单元测试无需加载组件模块
 * （组件模块引入了 @lobehub/icons，其 antd-style 依赖在 happy-dom 中不可用）。
 *
 * 归属、展示名与授权判断已全部下沉到 `lib/provider-resource-access`（新授权视图 `scope` + `access`），
 * 本模块只保留目录层语义与展示派生函数。
 */

export { getProviderAccessBadgeKey as getProviderResourceBadgeKey, getProviderDisplayName, getProviderKey };

/**
 * 是否可写。
 *
 * 写权限来自 `access.actions` 的 `update`（缺失即拒绝）；Gateway Provider 由系统托管，后端对写操作
 * 直接返回 FORBIDDEN，因此界面保持只读，避免暴露必然失败的入口。
 */
export function canWriteProvider(provider: ProviderInfo): boolean {
  return isProviderWritable(provider) && provider.kind !== "gateway";
}

/**
 * Provider 配置 ID 可能是邮箱或自定义别名，不能用于推断品牌。
 * 已配置模型 ID 更接近真实厂商，因此优先用于品牌图标解析。
 */
export function getProviderIconModelId(provider: ProviderInfo, models: ProviderModel[]): string {
  return models[0]?.id ?? provider.id;
}

/**
 * 返回 Provider 是否属于指定目录范围；本组织与公开是可重叠维度。
 *
 * `activeOrganizationId` 缺失时按本组织视角处理（同 `isExternalProvider`），避免组织上下文未就绪时
 * 把自己的 Provider 从「本组织」中筛掉。
 */
export function providerMatchesScope(
  provider: ProviderInfo,
  scope: ProviderScope,
  activeOrganizationId?: string,
): boolean {
  if (scope === "all") return true;
  if (scope === "organization") return !isExternalProvider(provider, activeOrganizationId);
  return isPublicProvider(provider);
}

/** 模型的思考开关来自真实 options.thinking.enabled，不从模型名称推测。 */
export function supportsThinking(model: { options?: Record<string, unknown> }): boolean {
  const thinking = model.options?.thinking;
  return typeof thinking === "object" && thinking !== null && (thinking as Record<string, unknown>).enabled === true;
}

/** 数字配置转换，保留合法的 0，并拒绝 NaN、负数和空输入。 */
export function parseOptionalNonNegativeNumber(value: string): number | undefined {
  if (!value.trim()) return;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

/** 表单展示数字时保留 0，避免 truthy 判断把合法配置变成空值。 */
export function formatOptionalNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/**
 * 公开受众写载荷。
 *
 * D2 只退休了 `/web` **响应**里的旧字段形状；写协议仍由服务端以 `publicReadable` 表达受众变更
 * （与 Skill / MCP 的写路径一致），因此这里继续发送该字段。
 */
export function buildProviderPublicReadablePayload(publicReadable: boolean): Record<string, unknown> {
  return { publicReadable };
}

/**
 * 模型选择列表的候选集：探测结果在前，其次是尚未出现在探测结果里的已选条目。
 *
 * 手动输入的模型 ID 不在服务商的列表接口里（部分服务商的列表接口与消息接口不在同一个地址上），但它
 * 既然处于"已选"状态就必须在列表里可见、可取消。只渲染探测结果会制造一种幽灵选择：探测失败清空列表
 * 后，手动条目在界面上消失、却仍会被保存提交。
 */
export function mergeModelCandidates(discovered: string[], selected: string[]): string[] {
  return [...discovered, ...selected.filter((id) => !discovered.includes(id))];
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
