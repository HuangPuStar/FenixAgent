import type { ResourceAccess } from "../../../../../src/services/config/types";

/** Provider 额外配置。 */
export type ProviderExtraOptions = Record<string, unknown>;

/** Provider 写入数据。 */
export interface ProviderUpsertData {
  displayName?: string | null;
  kind?: "direct" | "gateway";
  gatewayType?: string | null;
  protocol?: "openai" | "anthropic";
  baseUrl?: string | null;
  apiKey?: string | null;
  extraOptions?: ProviderExtraOptions | null;
}

/** Provider 写入附加选项。 */
export interface ProviderSetOptions {
  publicReadable?: boolean;
}

/** 模型能力配置。 */
export type ModelModalities = { input?: ("text" | "image")[]; output?: ("text" | "image")[] } | string[];

/** 模型限制配置。 */
export interface ModelLimitConfig {
  context?: number;
  output?: number;
  rpm?: number;
  [key: string]: unknown;
}

/** 模型成本配置。 */
export interface ModelCostConfig {
  input?: number;
  output?: number;
}

/** 模型 Provider 专属参数。 */
export type ModelOptions = Record<string, unknown>;

/** 模型写入数据。 */
export interface ModelUpsertData {
  modelId?: string;
  displayName?: string;
  modalities?: ModelModalities | null;
  limitConfig?: ModelLimitConfig | null;
  cost?: ModelCostConfig | null;
  options?: ModelOptions | null;
}

/** 前端模型字段输入。 */
export interface ModelDataInput {
  name?: string;
  modalities?: unknown;
  limit?: unknown;
  cost?: unknown;
  options?: unknown;
}

/** Provider 访问元数据修饰后的模型记录。 */
export interface ModelEntryWithProviderAccess {
  id: string;
  providerId: string;
  organizationId: string;
  modelId: string;
  displayName: string | null;
  modalities: unknown;
  limitConfig: unknown;
  cost: unknown;
  options: unknown;
  providerResourceAccess: ResourceAccess;
}
