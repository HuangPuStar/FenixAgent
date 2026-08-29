import type {
  GatewayBudget,
  GatewayCredentialSecret,
  GatewayHealth,
  GatewayModel,
  GatewayUsage,
  GatewayUsageQuery,
  GatewayUser,
  GatewayUserBudget,
  GatewayUserBudgetResetResult,
} from "@fenix/model-gateway-sdk";

interface LiteLlmModelInfo {
  model_name?: unknown;
}

interface LiteLlmModelInfoResponse {
  data?: unknown;
}

interface LiteLlmHealthResponse {
  status?: unknown;
  version?: unknown;
}

interface LiteLlmUserResponse {
  user_id?: unknown;
  user_email?: unknown;
  max_budget?: unknown;
  spend?: unknown;
  budget_duration?: unknown;
  budget_reset_at?: unknown;
}

interface LiteLlmUserListResponse {
  users?: unknown;
  total_pages?: unknown;
}

interface LiteLlmBulkUserUpdateResult {
  user_id?: unknown;
  success?: unknown;
  error?: unknown;
}

interface LiteLlmBulkUserUpdateResponse {
  results?: unknown;
}

interface LiteLlmKeyResponse {
  key?: unknown;
  token?: unknown;
}

interface LiteLlmMetric {
  spend?: unknown;
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  api_requests?: unknown;
}

interface LiteLlmMetricGroup {
  metrics?: unknown;
  api_key_breakdown?: unknown;
}

interface LiteLlmDailyResult {
  date?: unknown;
  metrics?: unknown;
  breakdown?: { models?: unknown };
}

interface LiteLlmUsageResponse {
  results?: unknown;
  metadata?: { total_spend?: unknown };
}

/**
 * LiteLLM v1.93.0 不能通过 `/user/update` 清空已有 `budget_duration`。
 * Fenix 用该已验证的长周期值承载“一次性”预算，并且绝不把它暴露为真实周期。
 */
export const LITELLM_ONE_TIME_BUDGET_DURATION = "2000d";

function readModelName(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const modelName = (value as LiteLlmModelInfo).model_name;
  return typeof modelName === "string" && modelName.trim() ? modelName.trim() : null;
}

export function mapLiteLlmHealth(value: unknown): GatewayHealth {
  const response = (value ?? {}) as LiteLlmHealthResponse;
  const status = response.status === "healthy" ? "healthy" : "degraded";
  return {
    status,
    ...(typeof response.version === "string" ? { version: response.version } : {}),
  };
}

export function mapLiteLlmModels(value: unknown): GatewayModel[] {
  const data = (value as LiteLlmModelInfoResponse | null)?.data;
  if (!Array.isArray(data)) return [];

  const models: GatewayModel[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    const id = readModelName(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, displayName: id, provider: undefined });
  }
  return models;
}

export function mapLiteLlmUser(value: unknown): GatewayUser {
  const response = (value ?? {}) as LiteLlmUserResponse;
  if (typeof response.user_id !== "string" || !response.user_id.trim()) {
    throw new Error("LiteLLM user response is missing user_id");
  }
  return {
    externalId: response.user_id,
    ...(typeof response.user_email === "string" ? { email: response.user_email } : {}),
  };
}

export function mapLiteLlmBudget(value: unknown): GatewayBudget {
  const response = (value ?? {}) as LiteLlmUserResponse;
  const maxBudgetUsd = response.max_budget == null ? null : Number(response.max_budget);
  const spendUsd = Number(response.spend ?? 0);
  if ((maxBudgetUsd !== null && !Number.isFinite(maxBudgetUsd)) || !Number.isFinite(spendUsd)) {
    throw new Error("LiteLLM budget response contains invalid numbers");
  }
  const duration =
    response.budget_duration === LITELLM_ONE_TIME_BUDGET_DURATION
      ? null
      : typeof response.budget_duration === "string"
        ? response.budget_duration
        : null;
  return {
    maxBudgetUsd,
    duration,
    spendUsd,
    // 长周期哨兵只是 LiteLLM 的兼容实现，不能让前端将其误认为会重置的周期预算。
    resetAt: duration === null ? null : typeof response.budget_reset_at === "string" ? response.budget_reset_at : null,
  };
}

/** 将 LiteLLM 用户列表页映射为预算快照，并保留其分页信息。 */
export function mapLiteLlmUserBudgetPage(value: unknown): {
  items: GatewayUserBudget[];
  totalPages: number;
} {
  const response = (value ?? {}) as LiteLlmUserListResponse;
  const users = Array.isArray(response.users) ? response.users : [];
  const items = users.flatMap((user) => {
    const externalUserId = (user as LiteLlmUserResponse | null)?.user_id;
    if (typeof externalUserId !== "string" || !externalUserId.trim()) return [];
    return [{ externalUserId, ...mapLiteLlmBudget(user) }];
  });
  const totalPages = Number(response.total_pages);
  return {
    items,
    totalPages: Number.isInteger(totalPages) && totalPages > 0 ? totalPages : 1,
  };
}

/** 将 LiteLLM 批量更新的逐项结果规范为网关预算重置结果。 */
export function mapLiteLlmUserBudgetReset(
  value: unknown,
  requestedExternalUserIds: readonly string[],
): GatewayUserBudgetResetResult {
  const response = (value ?? {}) as LiteLlmBulkUserUpdateResponse;
  const results = Array.isArray(response.results) ? response.results : [];
  const succeededExternalUserIds: string[] = [];
  const failed = new Map<string, string | undefined>();
  for (const result of results) {
    const item = result as LiteLlmBulkUserUpdateResult | null;
    if (!item || typeof item.user_id !== "string") continue;
    if (item.success === true) succeededExternalUserIds.push(item.user_id);
    else failed.set(item.user_id, typeof item.error === "string" ? item.error : undefined);
  }
  const succeeded = new Set(succeededExternalUserIds);
  for (const externalUserId of requestedExternalUserIds) {
    if (!succeeded.has(externalUserId) && !failed.has(externalUserId)) {
      failed.set(externalUserId, "LiteLLM did not return an update result");
    }
  }
  return {
    succeededExternalUserIds,
    failed: [...failed].map(([externalUserId, error]) => ({
      externalUserId,
      error,
    })),
  };
}

export function mapLiteLlmCredential(value: unknown): GatewayCredentialSecret {
  const response = (value ?? {}) as LiteLlmKeyResponse;
  if (typeof response.key !== "string" || !response.key.trim()) {
    throw new Error("LiteLLM key response is missing a secret key");
  }
  if (typeof response.token !== "string" || !response.token.trim()) {
    throw new Error("LiteLLM key response is missing a token ID");
  }
  return { externalId: response.token, secret: response.key };
}

function metricNumber(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function unwrapMetric(metric: unknown): LiteLlmMetric {
  const group = (metric ?? {}) as LiteLlmMetricGroup;
  return (group.metrics && typeof group.metrics === "object" ? group.metrics : (metric ?? {})) as LiteLlmMetric;
}

function mapUsageMetric(date: string, modelId: string | undefined, metric: unknown, externalCredentialId?: string) {
  const value = unwrapMetric(metric);
  return {
    date,
    modelId,
    externalUserId: undefined,
    externalCredentialId,
    spendUsd: metricNumber(value.spend),
    promptTokens: metricNumber(value.prompt_tokens),
    completionTokens: metricNumber(value.completion_tokens),
    requests: metricNumber(value.api_requests),
  };
}

function mapModelUsageMetrics(date: string, modelId: string, metric: unknown) {
  const group = (metric ?? {}) as LiteLlmMetricGroup;
  const byKey = group.api_key_breakdown;
  if (byKey && typeof byKey === "object" && !Array.isArray(byKey)) {
    const entries = Object.entries(byKey);
    if (entries.length > 0) {
      return entries.map(([usageCredentialId, keyMetric]) =>
        mapUsageMetric(date, modelId, keyMetric, usageCredentialId),
      );
    }
  }
  return [mapUsageMetric(date, modelId, metric)];
}

/**
 * LiteLLM daily activity 返回的是 Virtual Key 的 token_id，
 * 与 /key/generate 返回的 token 相同，可直接作为 Fenix 的 externalCredentialId。
 */
export function mapLiteLlmUsage(value: unknown): GatewayUsage {
  const response = (value ?? {}) as LiteLlmUsageResponse;
  const results = Array.isArray(response.results) ? response.results : [];
  const records = [];
  for (const item of results) {
    const daily = (item ?? {}) as LiteLlmDailyResult;
    if (typeof daily.date !== "string") continue;
    const models = daily.breakdown?.models;
    if (models && typeof models === "object" && !Array.isArray(models)) {
      for (const [modelId, metric] of Object.entries(models)) {
        records.push(...mapModelUsageMetrics(daily.date, modelId, metric));
      }
    } else {
      records.push(mapUsageMetric(daily.date, undefined, daily.metrics));
    }
  }

  const reportedTotal = Number(response.metadata?.total_spend);
  return {
    totalSpendUsd: Number.isFinite(reportedTotal)
      ? reportedTotal
      : records.reduce((total, record) => total + record.spendUsd, 0),
    records,
  };
}

export function buildLiteLlmUsagePath(query: GatewayUsageQuery): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(query.startAt) || !/^\d{4}-\d{2}-\d{2}$/.test(query.endAt)) {
    throw new Error("LiteLLM daily activity requires YYYY-MM-DD dates");
  }
  const params = new URLSearchParams({
    start_date: query.startAt,
    end_date: query.endAt,
  });
  if (query.externalUserId) params.set("user_id", query.externalUserId);
  if (query.externalCredentialId) params.set("api_key", query.externalCredentialId);
  if (query.modelId) params.set("model", query.modelId);
  return `/user/daily/activity?${params.toString()}`;
}
