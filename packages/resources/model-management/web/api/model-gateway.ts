import { request, unwrap } from "@fenix/web-runtime/api/request";
import { getAdminKey } from "@fenix/web-runtime/lib/admin-key";

export interface ModelSyncChange {
  modelId: string;
  kind: "added" | "updated" | "removed";
  displayName?: string;
}
export interface ModelSyncStatus {
  status: "synced" | "pending" | "unknown";
  changes: ModelSyncChange[];
  models?: Array<{ id: string; displayName?: string; provider?: string }>;
  providerBaseUrlChanged?: boolean;
  error?: string;
}
export interface ModelGatewayConfiguration {
  provider: {
    id: string;
    name: string;
    displayName: string;
    gatewayType: string;
    baseUrl: string | null;
    modelCount: number;
    owner: { email: string; organizationSlug: string };
  } | null;
  adminUiUrl: string | null;
  defaultBudget: { maxBudgetUsd: number | null; duration: string | null };
}
export interface ModelSyncResult {
  added: number;
  updated: number;
  removed: number;
}
export interface GatewayUsage {
  gatewayProvider: {
    id: string;
    name: string;
    displayName: string;
  };
  totalSpendUsd: number;
  records: Array<{
    date: string;
    spendUsd: number;
    requests: number;
    promptTokens: number;
    completionTokens: number;
  }>;
  activeUserCount: number;
  byModel?: Array<{ modelId: string; spendUsd: number; requests: number }>;
  byOrganization?: Array<{
    organizationId: string;
    organizationName: string | null;
    spendUsd: number;
    requests: number;
  }>;
  byUser?: Array<{
    userId: string;
    userName: string | null;
    userEmail: string | null;
    spendUsd: number;
    requests: number;
  }>;
  byAgent?: Array<{
    agentConfigId: string;
    organizationName: string | null;
    agentName: string | null;
    spendUsd: number;
    requests: number;
  }>;
  budget: {
    maxBudgetUsd: number | null;
    duration: string | null;
    spendUsd: number;
    resetAt: string | null;
  } | null;
}

export interface ModelGatewayBudgetItem {
  id: string;
  name: string;
  email: string;
  budget: {
    maxBudgetUsd: number | null;
    duration: string | null;
    spendUsd: number;
    resetAt: string | null;
  };
  source: "litellm" | "default";
  isActivated: boolean;
}

export interface ModelGatewayManagedKey {
  id: string;
  externalCredentialId: string;
  organizationId: string;
  organizationName: string | null;
  userId: string;
  userName: string | null;
  agentConfigId: string;
  agentName: string | null;
  status: "active" | "blocked" | "error";
  createdAt: string;
  updatedAt: string;
  usable: boolean;
  invalidReason:
    | "USER_NOT_FOUND"
    | "ORGANIZATION_NOT_FOUND"
    | "MEMBERSHIP_NOT_FOUND"
    | "AGENT_NOT_FOUND"
    | "AGENT_ACCESS_REVOKED"
    | "CREDENTIAL_UNUSABLE"
    | null;
}

function adminOptions() {
  return { bearerToken: getAdminKey() ?? undefined };
}

/** 模型网关域模块出口（§5.5：单一 `*Api` 对象；`/api/system/*` 端点用 Master Key，`/web/*` 端点走会话）。 */
export const modelGatewayApi = {
  /** 查看模型同步状态（可选按 provider 过滤）。 */
  check: (providerId?: string) =>
    unwrap(
      request<ModelSyncStatus>("/api/system/model-gateway/models/status", {
        ...adminOptions(),
        query: providerId ? { providerId } : undefined,
      }),
    ),

  /** 读取网关配置（上游 provider、管理 UI 地址、默认预算）。 */
  getConfiguration: () =>
    unwrap(request<ModelGatewayConfiguration>("/api/system/model-gateway/config", adminOptions())),

  /** 触发模型同步。 */
  sync: (providerId?: string) =>
    unwrap(
      request<ModelSyncResult>("/api/system/model-gateway/models/actions/sync", {
        ...adminOptions(),
        method: "POST",
        query: providerId ? { providerId } : undefined,
      }),
    ),

  /** 分页查询用户预算（可过滤组织 / 用户 / 预算状态）。 */
  listBudgets: (
    page = 1,
    pageSize = 20,
    filters: {
      organizationId?: string;
      userId?: string;
      budgetStatus?: "pending" | "active" | "exhausted";
    } = {},
  ) =>
    unwrap(
      request<{
        items: ModelGatewayBudgetItem[];
        total: number;
        page: number;
        pageSize: number;
      }>("/api/system/model-gateway/budgets", {
        ...adminOptions(),
        query: {
          page,
          pageSize,
          ...(filters.organizationId ? { organizationId: filters.organizationId } : {}),
          ...(filters.userId ? { userId: filters.userId } : {}),
          ...(filters.budgetStatus ? { budgetStatus: filters.budgetStatus } : {}),
        },
      }),
    ),

  /** 查询可作为预算主体的用户（关键字模糊匹配）。 */
  listUsers: (input: { keyword?: string; pageSize?: number } = {}) =>
    unwrap(
      request<{
        items: Array<{ id: string; name: string; email: string }>;
        total: number;
      }>("/api/system/model-gateway/subjects/users", {
        ...adminOptions(),
        query: { page: 1, pageSize: input.pageSize ?? 100, ...input },
      }),
    ),

  /** 查询可作为预算主体的智能体（关键字模糊匹配）。 */
  listAgents: (input: { keyword?: string; pageSize?: number } = {}) =>
    unwrap(
      request<
        Array<{
          id: string;
          name: string;
          organizationId: string;
          userId: string;
        }>
      >("/api/system/model-gateway/subjects/agents", {
        ...adminOptions(),
        query: { page: 1, pageSize: input.pageSize ?? 100, ...input },
      }),
    ),

  /** 按时间范围与主体查询网关用量（可带模型 / 用户 / 组织 / 智能体拆分）。 */
  queryUsage: (input: {
    startAt: string;
    endAt: string;
    userId?: string;
    organizationId?: string;
    agentConfigId?: string;
    modelId?: string;
    includeBreakdowns?: boolean;
  }) =>
    unwrap(
      request<GatewayUsage>("/api/system/model-gateway/usage", {
        ...adminOptions(),
        query: input,
      }),
    ),

  /** 批量设置用户预算（maxBudgetUsd 为 null 表示不限额）。 */
  updateBudgets: (userIds: string[], maxBudgetUsd: number | null, duration: string | null) =>
    unwrap(
      request("/api/system/model-gateway/budgets/actions/bulk-update", {
        ...adminOptions(),
        method: "POST",
        body: { userIds, maxBudgetUsd, duration },
      }),
    ),

  /** 批量重置用户预算用量。 */
  resetBudgets: (userIds: string[]) =>
    unwrap(
      request("/api/system/model-gateway/budgets/actions/bulk-reset", {
        ...adminOptions(),
        method: "POST",
        body: { userIds },
      }),
    ),

  /** 分页查询网关托管的用户密钥。 */
  listKeys: (page = 1, pageSize = 20) =>
    unwrap(
      request<{ items: ModelGatewayManagedKey[]; total: number; page: number; pageSize: number }>(
        "/api/system/model-gateway/keys",
        { ...adminOptions(), query: { page, pageSize } },
      ),
    ),

  /** 批量移除托管密钥（返回删除成功 / 跳过 / 失败的明细）。 */
  removeKeys: (ids: string[]) =>
    unwrap(
      request<{ deletedIds: string[]; skipped: Array<{ id: string; reason: string }>; failed: Array<{ id: string }> }>(
        "/api/system/model-gateway/keys/actions/remove",
        { ...adminOptions(), method: "POST", body: { ids } },
      ),
    ),

  /** 查询当前用户在某 provider 下的用量（`/web/*`，走会话鉴权）。 */
  queryMyUsage: (providerId: string, input: { startAt: string; endAt: string }) =>
    unwrap(request<GatewayUsage>("/web/model-gateway/:providerId/usage", { params: { providerId }, query: input })),
};
