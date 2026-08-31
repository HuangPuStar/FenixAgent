/** 网关服务的健康状态。 */
export type GatewayHealthStatus = "healthy" | "degraded" | "unavailable";

/** 网关服务健康检查结果。 */
export interface GatewayHealth {
  status: GatewayHealthStatus;
  version?: string;
}

/** 网关可发布模型的供应商无关表示。 */
export interface GatewayModel {
  id: string;
  displayName?: string;
  provider?: string;
  metadata?: Record<string, unknown>;
}

/** 网关侧用户的最小身份表示。 */
export interface GatewayUser {
  externalId: string;
  email?: string;
}

/** 网关预算及当前消耗。duration 为 null 时表示一次性预算。 */
export interface GatewayBudget {
  maxBudgetUsd: number | null;
  duration: string | null;
  spendUsd: number;
  resetAt: string | null;
}

/** 网关侧 Internal User 的预算快照。 */
export interface GatewayUserBudget extends GatewayBudget {
  externalUserId: string;
}

/** 确保网关用户存在所需的身份信息。 */
export interface EnsureGatewayUserInput {
  externalId: string;
  email?: string;
  displayName?: string;
  budget?: GatewayBudgetConfig;
}

/** 首次创建网关用户时使用的预算配置快照。 */
export interface GatewayBudgetConfig {
  maxBudgetUsd: number | null;
  duration: string | null;
}

/** 更新网关用户预算的输入。 */
export interface UpdateGatewayBudgetInput {
  externalUserId: string;
  maxBudgetUsd: number | null;
  duration: string | null;
}

/** 网关批量重置用户消耗后的逐项结果。 */
export interface GatewayUserBudgetResetResult {
  succeededExternalUserIds: string[];
  failed: Array<{ externalUserId: string; error?: string }>;
}

/** 创建网关凭证的输入。 */
export interface CreateGatewayCredentialInput {
  externalUserId: string;
  /** 供网关管理后台展示和人工定位的稳定凭证别名。 */
  keyAlias?: string;
  metadata?: Record<string, string>;
}

/** 网关只在创建时返回一次的凭证密钥。 */
export interface GatewayCredentialSecret {
  externalId: string;
  secret: string;
}

/** 用量查询条件，使用首尾均包含的 UTC `YYYY-MM-DD` 日期范围。各 Adapter 负责映射到对应网关 API。 */
export interface GatewayUsageQuery {
  startAt: string;
  endAt: string;
  externalUserId?: string;
  externalCredentialId?: string;
  modelId?: string;
}

/** 网关返回的一条聚合用量记录。 */
export interface GatewayUsageRecord {
  date: string;
  modelId?: string;
  externalUserId?: string;
  externalCredentialId?: string;
  spendUsd: number;
  promptTokens: number;
  completionTokens: number;
  requests: number;
}

/** 网关用量查询结果。 */
export interface GatewayUsage {
  totalSpendUsd: number;
  records: GatewayUsageRecord[];
}

/** 网关 Adapter 统一错误码。 */
export type ModelGatewayErrorCode =
  | "UNAVAILABLE"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INVALID_RESPONSE"
  | "UNSUPPORTED_CAPABILITY";

/**
 * Adapter 对外暴露的稳定错误。
 *
 * 只保留已归一化的错误上下文，避免把外部响应体或认证头带入日志和上层响应。
 */
export class ModelGatewayError extends Error {
  readonly code: ModelGatewayErrorCode;

  constructor(code: ModelGatewayErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ModelGatewayError";
    this.code = code;
  }
}

/**
 * Fenix 与具体模型网关之间的最小契约。
 *
 * 实现不得暴露供应商专属 DTO；供应商语义应封装在对应 Adapter 内。
 */
export interface ModelGatewayAdapter {
  readonly type: string;
  checkHealth(): Promise<GatewayHealth>;
  listModels(): Promise<GatewayModel[]>;
  ensureUser(input: EnsureGatewayUserInput): Promise<GatewayUser>;
  getUserBudget(externalUserId: string): Promise<GatewayBudget>;
  /**
   * 查询网关 Internal User 预算；省略 ID 时列出全部，传入 ID 时只查询指定用户。
   */
  listUserBudgets(externalUserIds?: readonly string[]): Promise<GatewayUserBudget[]>;
  updateUserBudget(input: UpdateGatewayBudgetInput): Promise<GatewayBudget>;
  /** 将指定 Internal User 的已消耗金额清零，不修改预算上限和周期。 */
  resetUserBudgets?(externalUserIds: readonly string[]): Promise<GatewayUserBudgetResetResult>;
  createCredential(input: CreateGatewayCredentialInput): Promise<GatewayCredentialSecret>;
  blockCredential(externalCredentialId: string): Promise<void>;
  queryUsage(input: GatewayUsageQuery): Promise<GatewayUsage>;
}
